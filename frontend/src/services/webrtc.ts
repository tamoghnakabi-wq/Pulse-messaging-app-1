/**
 * Pulse calling — Socket.IO media relay (works through Cloudflare / ngrok without TURN).
 * - Audio: low-latency PCM frames
 * - Video / screen: JPEG snapshots drawn onto a remote canvas stream
 * - Group: server fan-out of PCM/JPEG to all joined members
 *
 * Tuned for smooth 1:1 and small group calls over the relay.
 */
import { ensureSocketConnected, getSocket } from './socket';

export type CallType = 'audio' | 'video' | 'screen';

export type CallStatus =
  | 'idle'
  | 'ringing'
  | 'calling'
  | 'connecting'
  | 'connected'
  | 'ended';

export type GroupMemberStatus = 'invited' | 'joined' | 'left' | 'rejected';

export interface CallMember {
  userId: string;
  status: GroupMemberStatus;
}

export interface IncomingCall {
  callId: string;
  fromUserId: string;
  conversationId: string;
  callType: CallType;
  sdpOffer?: RTCSessionDescriptionInit;
  /** Multi-party group call */
  group?: boolean;
  initiatorId?: string;
  members?: CallMember[];
}

type Listener = () => void;

/** Target capture rate for the audio relay (good quality, modest bandwidth). */
const RELAY_SAMPLE_RATE = 24000;
/**
 * Capture ScriptProcessor size. 2048 ≈ 43ms @ 48kHz (was 4096 ≈ 85ms).
 * Still low enough message rate for Cloudflare with batching.
 */
const PROCESS_BUFFER = 2048;
/**
 * Batch window before emit. 40ms balances latency vs CF packet rate
 * (was 100ms — largest controllable delay on the path).
 */
const PCM_BATCH_MS = 40;
const PCM_BATCH_SAMPLES = Math.floor((RELAY_SAMPLE_RATE * PCM_BATCH_MS) / 1000);
/** Max remote playout backlog — drop older audio if we fall behind (was ~2s). */
const PLAY_QUEUE_MAX_SEC = 0.28;

function isCloudflareHost(): boolean {
  if (typeof location === 'undefined') return false;
  return /trycloudflare\.com|cfargotunnel\.com/i.test(location.hostname);
}

function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPhone / iPad / iPod, plus iPadOS desktop-UA with touch
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function getAudioContextCtor(): typeof AudioContext {
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext || w.webkitAudioContext!;
}

/**
 * Camera relay: prefer low latency over max resolution.
 * 960×720 @ high JPEG saturated Socket.IO tunnels → multi-second lag + dropped frames.
 * 640×480 at moderate quality keeps motion smooth through Cloudflare/ngrok.
 */
const VIDEO_FPS_MAX = 24;
const VIDEO_FPS_MIN = 10;
const VIDEO_FPS_DEFAULT = 18;
const VIDEO_JPEG_QUALITY = 0.55;
const VIDEO_JPEG_QUALITY_MIN = 0.38;
const VIDEO_MAX_W = 640;
const VIDEO_MAX_H = 480;
const VIDEO_MIN_W = 320;
const VIDEO_MIN_H = 240;
/**
 * Screen share: prioritize motion smoothness + readable UI.
 */
const SCREEN_FPS = 20;
const SCREEN_FPS_MIN = 10;
const SCREEN_JPEG_QUALITY = 0.55;
const SCREEN_JPEG_QUALITY_MIN = 0.38;
const SCREEN_MAX_W = 1280;
const SCREEN_MAX_H = 720;
/** Soft cap — keep frames small so encode+wire stays under ~40ms. */
const VIDEO_MAX_BYTES = 55 * 1024;
const SCREEN_MAX_BYTES = 95 * 1024;
/** How often the remote canvas stream reports frames to the <video> element. */
const REMOTE_CAPTURE_FPS = 24;

type NetworkTier = 'high' | 'medium' | 'low' | 'critical';

function emitSignal(event: string, payload: Record<string, unknown>) {
  const sock = getSocket();
  if (sock?.connected) {
    sock.emit(event, payload);
    return;
  }
  void ensureSocketConnected()
    .then((s) => s.emit(event, payload))
    .catch((err) => console.error('[call] emit failed', event, err));
}

/**
 * Call media: pure JSON base64 for audio (no binary). Do NOT use volatile —
 * dropping Mac→phone packets under tunnel congestion is exactly one-way audio.
 */
function emitMedia(payload: Record<string, unknown>) {
  const sock = getSocket();
  if (sock?.connected) {
    sock.emit('call:media', payload);
    return;
  }
  void ensureSocketConnected()
    .then((s) => s.emit('call:media', payload))
    .catch((err) => console.error('[call] media emit failed', err));
}

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function int16ToFloat(int16: Int16Array): Float32Array {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    out[i] = int16[i] / 32768;
  }
  return out;
}

/** Linear resample between rates (works for up and down). */
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  if (fromRate <= 0 || toRate <= 0) return input;
  const ratio = fromRate / toRate;
  const newLen = Math.max(1, Math.floor(input.length / ratio));
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    result[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return result;
}

/** Normalize any Socket.IO / proxy binary payload into an ArrayBuffer. */
function coerceArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data == null) return null;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data).buffer;
  }
  // Node Buffer JSON shape or Socket.IO reconstitution edge-cases
  if (typeof data === 'object') {
    const obj = data as { type?: string; data?: number[]; buffer?: ArrayBuffer };
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return new Uint8Array(obj.data).buffer;
    }
  }
  if (typeof data === 'string' && data.length > 0) {
    try {
      const bin = atob(data);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out.buffer;
    } catch {
      return null;
    }
  }
  return null;
}

function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    // Avoid spread (stack limits on large frames)
    let part = '';
    for (let j = 0; j < sub.length; j++) part += String.fromCharCode(sub[j]);
    binary += part;
  }
  return btoa(binary);
}

/** Build a mono 16-bit PCM WAV (Safari HTMLAudio can play this mid-call). */
function pcmS16leToWav(pcm: ArrayBuffer, sampleRate: number): ArrayBuffer {
  const dataLen = pcm.byteLength;
  const out = new ArrayBuffer(44 + dataLen);
  const v = new DataView(out);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataLen, true);
  new Uint8Array(out, 44).set(new Uint8Array(pcm));
  return out;
}

class CallService {
  status: CallStatus = 'idle';
  callId: string | null = null;
  callType: CallType = 'audio';
  remoteUserId: string | null = null;
  conversationId: string | null = null;
  isIncoming = false;
  localStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null;
  error: string | null = null;
  incoming: IncomingCall | null = null;
  relayMode = false;
  /** Active camera: front (`user`) or rear (`environment`). */
  facingMode: 'user' | 'environment' = 'user';
  /** True while sending display/screen frames (standalone screen call or mid-call share). */
  sharingScreen = false;
  /** Multi-party room (group chat call). */
  isGroup = false;
  /** Host / original inviter for group calls. */
  initiatorId: string | null = null;
  /** Full roster (invited + joined + left/rejected). */
  members: CallMember[] = [];
  /**
   * Per-peer video streams for group grid UI.
   * 1:1 still uses `remoteStream` only.
   */
  remotePeerStreams: Record<string, MediaStream> = {};

  private listeners = new Set<Listener>();
  private ending = false;
  private switchingCamera = false;
  private sharingScreenBusy = false;
  /** Camera track parked while screen sharing (restored on stop). */
  private parkedCameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private onScreenEnded: (() => void) | null = null;

  /**
   * TWO audio graphs (required for Mac→iPhone on Safari):
   *
   * 1) captureCtx — getUserMedia mic → ScriptProcessor → near-silent destination
   *    (iOS treats this as a capture session; OUT is often inaudible)
   * 2) playCtx — pure playout (no mic). Remote PCM → ring → ScriptProcessor OUT
   *    → speakers AND MediaStreamDestination → <audio> (iOS-safe).
   *
   * Single-context full-duplex is why iPhone could SEND (IN works) but not HEAR
   * (OUT silent) while Mac heard the iPhone fine.
   */
  private audioCtx: AudioContext | null = null; // capture
  private playCtx: AudioContext | null = null; // remote only
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private outGain: GainNode | null = null;
  private relayActive = false;

  // Remote PCM playout ring (Float32 at playCtx.sampleRate)
  private playQueue: Float32Array[] = [];
  private playQueueSamples = 0;
  private playReadOffset = 0;
  private playSampleRate = RELAY_SAMPLE_RATE;
  private remoteAudioEl: HTMLAudioElement | null = null;
  private audioUnlockBound = false;
  private audioUnlockHandler: (() => void) | null = null;
  private lastPcmSentAt = 0;
  private silentFramesSkipped = 0;
  private captureEnergyEma = 0;
  private captureFrames = 0;
  private remotePackets = 0;
  private playOutGain = 1.7;
  /** Accumulate PCM before emit (Cloudflare-friendly lower message rate). */
  private pcmBatch: Float32Array[] = [];
  private pcmBatchSamples = 0;
  /** Flush incomplete PCM batches so quiet speech isn't stuck in the buffer. */
  private pcmFlushTimer: ReturnType<typeof setInterval> | null = null;
  /** Keep AudioContexts + remote <audio> alive during the call. */
  private audioKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Capture graph silent driver (keeps ScriptProcessor firing on Safari/Chrome). */
  private captureDriver: OscillatorNode | null = null;
  private captureDriverGain: GainNode | null = null;

  // Pure-play graph (no mic) — fixes iOS one-way
  private playProcessor: ScriptProcessorNode | null = null;
  private playDriver: OscillatorNode | null = null;
  private playDriverGain: GainNode | null = null;
  private playMix: GainNode | null = null;
  private playDest: MediaStreamAudioDestinationNode | null = null;
  private playGraphActive = false;
  private nextWebPlayTime = 0;

  // Video relay (local capture → JPEG → peer canvas stream)
  private localVideoEl: HTMLVideoElement | null = null;
  private localVideoCanvas: HTMLCanvasElement | null = null;
  private localVideoCtx: CanvasRenderingContext2D | null = null;
  private videoRaf: number | null = null;
  /** Fallback when tab is backgrounded — rAF freezes in minimized Safari. */
  private videoInterval: ReturnType<typeof setInterval> | null = null;
  private videoLoopActive = false;
  private onVisibilityForVideo: (() => void) | null = null;
  private videoSending = false;
  private jpegBusy = false;
  /** Encode another frame ASAP after current toBlob finishes (smoothness > perfect timing). */
  private jpegPending = false;
  private lastVideoCaptureAt = 0;
  private videoEncodeW = 0;
  private videoEncodeH = 0;
  private videoTargetFps = VIDEO_FPS_DEFAULT;
  private videoJpegQuality = VIDEO_JPEG_QUALITY;
  private videoMaxW = VIDEO_MAX_W;
  private videoMaxH = VIDEO_MAX_H;
  private networkTier: NetworkTier = 'high';
  private encodeDurations: number[] = [];
  private lastAdaptAt = 0;
  private framesSent = 0;
  private framesDropped = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private audioPriority = false;
  private remoteVideoCanvas: HTMLCanvasElement | null = null;
  private remoteVideoCtx: CanvasRenderingContext2D | null = null;
  private remoteFramePending = false;
  /** Latest inbound JPEG while decode is busy — always paint the freshest frame. */
  private remoteLatestFrame: { buffer: ArrayBuffer; width?: number; height?: number } | null =
    null;
  /**
   * Viewer has the call UI full-screen — keep encode quality from collapsing under
   * the extra GPU load of painting a large viewport.
   */
  private viewerFullscreen = false;
  /** Group: per-peer JPEG surfaces */
  private peerVideoSurfaces = new Map<
    string,
    {
      canvas: HTMLCanvasElement;
      ctx: CanvasRenderingContext2D;
      stream: MediaStream;
      latest: { buffer: ArrayBuffer; width?: number; height?: number } | null;
      pending: boolean;
    }
  >();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        /* */
      }
    });
  }

  private patch(partial: Partial<CallService>) {
    Object.assign(this, partial);
    this.notify();
  }

  private async getMedia(callType: CallType, role: 'caller' | 'callee') {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Use the HTTPS public link (Cloudflare) — mic needs a secure page');
    }

    // Standalone screen call: caller captures display + mic; callee uses mic only and receives JPEG.
    if (callType === 'screen' && role === 'caller') {
      if (!navigator.mediaDevices.getDisplayMedia) {
        throw new Error('Screen share is not supported in this browser');
      }
      const screen = await this.acquireDisplayStream();
      try {
        const micConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        if (!isAppleMobile()) {
          micConstraints.sampleRate = RELAY_SAMPLE_RATE;
        }
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints,
        });
        mic.getAudioTracks().forEach((t) => screen.addTrack(t));
      } catch {
        /* mic optional for pure screen call */
      }
      const vt = screen.getVideoTracks()[0];
      if (vt) {
        this.screenTrack = vt;
        this.sharingScreen = true;
        this.bindScreenEnded(vt, /* hangupIfStandalone */ true);
      }
      return screen;
    }

    // Do NOT force sampleRate on iOS — Safari often yields a silent track if we do.
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    if (!isAppleMobile()) {
      audioConstraints.sampleRate = RELAY_SAMPLE_RATE;
    }

    return navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video:
        callType === 'video'
          ? this.videoConstraints(this.facingMode)
          : false,
    });
  }

  /**
   * Invoke getDisplayMedia **synchronously** from a click/tap handler.
   * Do not await anything before calling this — browsers require a user gesture.
   *
   * Prefers "Entire Screen" (monitor) when the browser supports it. Safari often only
   * offers window/tab capture; Chrome/Edge/Firefox expose full-screen options.
   */
  requestDisplayMedia(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return Promise.reject(new Error('Screen share is not supported in this browser'));
    }
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      return Promise.reject(new Error('Screen share requires HTTPS'));
    }

    // Prefer full display. Chromium honors these; Safari ignores unknown fields.
    const preferred: DisplayMediaStreamOptions = {
      video: {
        // Hint: entire screen first (not current tab / single window)
        displaySurface: 'monitor',
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 24, max: 30 },
      } as MediaTrackConstraints,
      audio: false,
      // Chromium extensions to the picker (ignored where unsupported)
      preferCurrentTab: false,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
      monitorTypeSurfaces: 'include',
    } as DisplayMediaStreamOptions;

    // Call getDisplayMedia in this turn — returning the Promise is fine.
    try {
      return navigator.mediaDevices
        .getDisplayMedia(preferred)
        .catch((err: unknown) => {
          // Retry with minimal options if advanced constraints fail
          if (err instanceof DOMException && err.name === 'NotAllowedError') {
            throw err;
          }
          return navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          });
        });
    } catch {
      return navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
    }
  }

  /** @deprecated use requestDisplayMedia from a click handler */
  private acquireDisplayStream(): Promise<MediaStream> {
    return this.requestDisplayMedia();
  }

  private onScreenMuted: (() => void) | null = null;
  private onScreenUnmuted: (() => void) | null = null;

  private bindScreenEnded(track: MediaStreamTrack, hangupIfStandalone: boolean) {
    if (this.onScreenEnded) {
      try {
        this.screenTrack?.removeEventListener('ended', this.onScreenEnded);
      } catch {
        /* */
      }
    }
    if (this.onScreenMuted && this.screenTrack) {
      try {
        this.screenTrack.removeEventListener('mute', this.onScreenMuted);
      } catch {
        /* */
      }
    }
    if (this.onScreenUnmuted && this.screenTrack) {
      try {
        this.screenTrack.removeEventListener('unmute', this.onScreenUnmuted);
      } catch {
        /* */
      }
    }

    this.onScreenEnded = () => {
      if (this.ending) return;
      if (hangupIfStandalone && this.callType === 'screen' && !this.parkedCameraTrack) {
        void this.hangup(true);
        return;
      }
      void this.stopScreenShare(false);
    };
    track.addEventListener('ended', this.onScreenEnded);

    // Minimizing a shared *window* or backgrounding a *tab* mutes the track in Safari/Chrome.
    // Entire-screen (monitor) captures usually keep running.
    this.onScreenMuted = () => {
      if (this.ending || !this.sharingScreen) return;
      const surface = track.getSettings().displaySurface;
      if (surface === 'monitor') return;
      this.patch({
        error:
          surface === 'browser'
            ? 'Share paused — the Safari tab is in the background. Keep this tab visible, or choose Entire Screen / another app window.'
            : 'Share paused — the shared window may be minimized. Restore it or re-share with Entire Screen selected.',
      });
    };
    this.onScreenUnmuted = () => {
      if (this.ending) return;
      // Resume encoding immediately when the OS unmutes the track
      this.videoSending = true;
      this.jpegBusy = false;
      this.jpegPending = false;
      if (this.error && /Share paused/i.test(this.error)) {
        this.patch({ error: null });
      }
      if (this.localVideoEl) void this.localVideoEl.play().catch(() => undefined);
      if (this.relayActive && !this.videoLoopActive) {
        this.startVideoRelayOut();
      } else if (this.videoLoopActive) {
        this.syncVideoCaptureScheduler();
      }
      this.notify();
    };
    track.addEventListener('mute', this.onScreenMuted);
    track.addEventListener('unmute', this.onScreenUnmuted);

    try {
      // Helps encoders prioritize text/UI sharpness
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (track as any).contentHint = 'detail';
    } catch {
      /* */
    }

    window.setTimeout(() => {
      if (this.ending || track.readyState !== 'live') return;
      const settings = track.getSettings() as MediaTrackSettings & {
        displaySurface?: string;
      };
      console.debug('[call] screen surface', settings.displaySurface, settings);
    }, 400);
  }

  /** Whether outbound video should use screen-share encode settings. */
  private isScreenMode(): boolean {
    return this.sharingScreen || this.callType === 'screen';
  }

  private videoConstraints(facing: 'user' | 'environment'): MediaTrackConstraints {
    return {
      facingMode: { ideal: facing },
      // Capture modest resolution — encode canvas downscales further; heavy 720p
      // capture + toBlob was a major source of call lag on mobile.
      width: { ideal: 640, max: 960 },
      height: { ideal: 480, max: 720 },
      frameRate: { ideal: 24, max: 30 },
    };
  }

  /**
   * Call UI entered/exited full-screen. Resist hard quality cliffs, but never
   * inflate resolution — that reintroduces lag on the relay path.
   */
  setViewerFullscreen(active: boolean) {
    this.viewerFullscreen = !!active;
    if (active && this.relayActive && this.wantsVideo() && !this.isScreenMode()) {
      this.videoJpegQuality = Math.max(this.videoJpegQuality, VIDEO_JPEG_QUALITY);
      this.videoTargetFps = Math.max(this.videoTargetFps, 15);
      if (this.networkTier === 'critical') {
        this.networkTier = 'low';
        this.audioPriority = false;
      }
    }
  }

  /** Paint surface for remote JPEG frames — mount in the UI for crisp fullscreen. */
  getRemoteVideoCanvas(): HTMLCanvasElement | null {
    return this.remoteVideoCanvas;
  }

  /** Open a specific camera without audio (used when flipping mid-call). */
  private async openCamera(facing: 'user' | 'environment'): Promise<MediaStream> {
    // Prefer exact facing mode on phones; fall back to ideal if unsupported.
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...this.videoConstraints(facing),
          facingMode: { exact: facing },
        },
      });
    } catch {
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: this.videoConstraints(facing),
      });
    }
  }

  private bindAudioUnlock() {
    if (this.audioUnlockBound || typeof window === 'undefined') return;
    this.audioUnlockBound = true;
    this.audioUnlockHandler = () => {
      void this.resumePlayback();
    };
    // iOS / Chrome often re-suspend AudioContext after the accept gesture
    window.addEventListener('pointerdown', this.audioUnlockHandler, true);
    window.addEventListener('touchend', this.audioUnlockHandler, true);
    window.addEventListener('keydown', this.audioUnlockHandler, true);
    document.addEventListener('visibilitychange', this.audioUnlockHandler);
  }

  private unbindAudioUnlock() {
    if (!this.audioUnlockBound || !this.audioUnlockHandler) return;
    window.removeEventListener('pointerdown', this.audioUnlockHandler, true);
    window.removeEventListener('touchend', this.audioUnlockHandler, true);
    window.removeEventListener('keydown', this.audioUnlockHandler, true);
    document.removeEventListener('visibilitychange', this.audioUnlockHandler);
    this.audioUnlockBound = false;
    this.audioUnlockHandler = null;
  }

  /** Resume capture + pure-play graphs (call often; cheap when already running). */
  private async resumePlayback() {
    try {
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }
      if (this.playCtx && this.playCtx.state === 'suspended') {
        await this.playCtx.resume();
      }
      const el = this.remoteAudioEl;
      if (el) {
        el.muted = false;
        el.volume = 1;
        if (el.paused) await el.play().catch(() => undefined);
      }
    } catch {
      /* */
    }
  }

  /**
   * Unlock both audio graphs on the user gesture (start/accept).
   * Must create playCtx here so iOS allows remote speaker output later.
   */
  private primeSpeakerOutput(_ctx: AudioContext) {
    void this.ensurePlayGraph();
    // Tiny audible-unlock tick on play graph
    void this.ensurePlayGraph().then((pctx) => {
      try {
        const n = Math.max(1, Math.floor(pctx.sampleRate * 0.02));
        const buf = pctx.createBuffer(1, n, pctx.sampleRate);
        buf.getChannelData(0)[0] = 0.0003;
        const src = pctx.createBufferSource();
        src.buffer = buf;
        const g = pctx.createGain();
        g.gain.value = 0.001;
        src.connect(g);
        g.connect(pctx.destination);
        src.start(0);
      } catch {
        /* */
      }
    });
  }

  /**
   * Pure-play AudioContext (no mic). Remote PCM is mixed here and played via
   * speakers + a single continuous HTMLAudioElement (MediaStream), which is the
   * reliable iOS path while getUserMedia holds a separate capture context.
   */
  private async ensurePlayGraph(): Promise<AudioContext> {
    const AC = getAudioContextCtor();
    if (!this.playCtx || this.playCtx.state === 'closed') {
      this.playCtx = new AC({ latencyHint: 'interactive' });
      this.playSampleRate = this.playCtx.sampleRate;
      this.playGraphActive = false;
      this.playProcessor = null;
      this.playDriver = null;
      this.playDriverGain = null;
      this.playMix = null;
      this.playDest = null;
      this.nextWebPlayTime = 0;
    }
    if (this.playCtx.state === 'suspended') {
      await this.playCtx.resume();
    }

    if (!this.playGraphActive && this.playCtx) {
      const pctx = this.playCtx;
      this.playMix = pctx.createGain();
      this.playMix.gain.value = isAppleMobile() ? 2.2 : 1.5;

      this.playDest = pctx.createMediaStreamDestination();
      this.playMix.connect(this.playDest);
      try {
        this.playMix.connect(pctx.destination);
      } catch {
        /* */
      }

      // Continuous pull mixer — smaller buffer = lower playout latency
      // 1024 @ 48kHz ≈ 21ms; 512 ≈ 11ms (desktop)
      const bufSize = isAppleMobile() ? 1024 : 512;
      this.playProcessor = pctx.createScriptProcessor(bufSize, 1, 1);
      this.playProcessor.onaudioprocess = (ev) => {
        if (this.ending) {
          ev.outputBuffer.getChannelData(0).fill(0);
          return;
        }
        if (pctx.state === 'suspended') void pctx.resume().catch(() => undefined);
        // playOutGain boosts quiet mobile speakers without clipping (soft-clip in pull)
        this.pullRemotePcm(ev.outputBuffer.getChannelData(0), this.playOutGain);
      };

      // Silent driver so ScriptProcessor keeps firing without a mic
      this.playDriver = pctx.createOscillator();
      this.playDriver.frequency.value = 20; // non-zero required on some engines
      this.playDriverGain = pctx.createGain();
      this.playDriverGain.gain.value = 0; // fully silent
      this.playDriver.connect(this.playDriverGain);
      this.playDriverGain.connect(this.playProcessor);
      this.playProcessor.connect(this.playMix);
      try {
        this.playDriver.start();
      } catch {
        /* already started */
      }

      // Single continuous <audio> element (not thrashing blob URLs)
      if (typeof document !== 'undefined') {
        if (!this.remoteAudioEl) {
          const el = document.createElement('audio');
          el.autoplay = true;
          el.setAttribute('playsinline', 'true');
          el.setAttribute('webkit-playsinline', 'true');
          el.controls = false;
          el.muted = false;
          el.volume = 1;
          el.style.cssText =
            'position:fixed;width:2px;height:2px;opacity:0.02;pointer-events:none;left:0;bottom:0;z-index:0;';
          document.body.appendChild(el);
          this.remoteAudioEl = el;
        }
        const el = this.remoteAudioEl;
        el.muted = false;
        el.volume = 1;
        if (el.srcObject !== this.playDest.stream) {
          el.srcObject = this.playDest.stream;
        }
        void el.play().catch(() => undefined);
      }

      this.playGraphActive = true;
      console.debug('[call] pure-play graph ready', {
        rate: pctx.sampleRate,
        ios: isAppleMobile(),
      });
    }

    this.bindAudioUnlock();
    return this.playCtx;
  }

  private stopPlayGraph() {
    try {
      this.playProcessor?.disconnect();
      this.playDriverGain?.disconnect();
      this.playDriver?.stop();
      this.playDriver?.disconnect();
      this.playMix?.disconnect();
      this.playDest?.disconnect();
    } catch {
      /* */
    }
    this.playProcessor = null;
    this.playDriver = null;
    this.playDriverGain = null;
    this.playMix = null;
    this.playDest = null;
    this.playGraphActive = false;
    if (this.remoteAudioEl) {
      try {
        this.remoteAudioEl.pause();
        this.remoteAudioEl.srcObject = null;
        this.remoteAudioEl.remove();
      } catch {
        /* */
      }
      this.remoteAudioEl = null;
    }
    if (this.playCtx && this.playCtx.state !== 'closed') {
      void this.playCtx.close().catch(() => undefined);
    }
    this.playCtx = null;
    this.nextWebPlayTime = 0;
  }

  private teardownRemoteAudioElement() {
    this.stopPlayGraph();
  }

  /** Also schedule BufferSource into the pure-play mix (extra reliability). */
  private scheduleWebAudioPlay(f32: Float32Array, sampleRate: number) {
    if (f32.length < 1 || this.ending) return;
    void this.ensurePlayGraph().then((pctx) => {
      if (this.ending || !this.playMix) return;
      const playData =
        sampleRate === pctx.sampleRate ? f32 : resample(f32, sampleRate, pctx.sampleRate);
      if (playData.length < 1) return;
      const ab = pctx.createBuffer(1, playData.length, pctx.sampleRate);
      ab.getChannelData(0).set(playData);
      const src = pctx.createBufferSource();
      src.buffer = ab;
      src.connect(this.playMix!);
      const now = pctx.currentTime;
      // Tight jitter buffer (~25ms) — was ~50ms
      if (this.nextWebPlayTime < now + 0.015) this.nextWebPlayTime = now + 0.025;
      if (this.nextWebPlayTime > now + 0.22) this.nextWebPlayTime = now + 0.02;
      try {
        src.start(this.nextWebPlayTime);
        this.nextWebPlayTime += ab.duration;
      } catch {
        this.nextWebPlayTime = 0;
      }
    });
  }

  private clearPlayQueue() {
    this.playQueue = [];
    this.playQueueSamples = 0;
    this.playReadOffset = 0;
  }

  /** Whether we have a media destination (1:1 peer or group room). */
  private canSendMedia(): boolean {
    if (!this.callId) return false;
    if (this.isGroup) return true;
    return !!this.remoteUserId;
  }

  /** Build emit payload for PCM/JPEG (group fan-out vs 1:1 target). */
  private mediaEnvelope(extra: Record<string, unknown>): Record<string, unknown> {
    if (this.isGroup) {
      return {
        callId: this.callId,
        group: true,
        ...extra,
      };
    }
    return {
      targetUserId: this.remoteUserId,
      callId: this.callId,
      ...extra,
    };
  }

  /**
   * Merge batched PCM and emit as base64 JSON only (no binary attachments).
   * Cloudflare + Vite WS proxy handle high-rate binary poorly; JSON is reliable.
   */
  private flushPcmBatch() {
    if (!this.canSendMedia() || this.pcmBatchSamples === 0) {
      this.pcmBatch = [];
      this.pcmBatchSamples = 0;
      return;
    }
    const merged = new Float32Array(this.pcmBatchSamples);
    let o = 0;
    for (const c of this.pcmBatch) {
      merged.set(c, o);
      o += c.length;
    }
    this.pcmBatch = [];
    this.pcmBatchSamples = 0;

    const pcm = floatTo16BitPCM(merged);
    this.lastPcmSentAt = performance.now();
    emitMedia(
      this.mediaEnvelope({
        format: 'pcm_s16le',
        sampleRate: RELAY_SAMPLE_RATE,
        // Base64-only — survives Cloudflare quick tunnels better than binary frames
        dataB64: abToBase64(pcm),
      })
    );
  }

  /** Push remote Float32 PCM (already at playCtx rate) into the playout ring. */
  private enqueueRemotePcm(samples: Float32Array) {
    if (samples.length === 0) return;
    // Copy — caller may reuse buffers
    const copy = new Float32Array(samples.length);
    copy.set(samples);
    this.playQueue.push(copy);
    this.playQueueSamples += copy.length;
    // Cap backlog so network jitter cannot stack multi-second delay
    const maxSamples = Math.floor(
      (this.playCtx?.sampleRate || this.playSampleRate || RELAY_SAMPLE_RATE) *
        PLAY_QUEUE_MAX_SEC
    );
    while (this.playQueueSamples > maxSamples && this.playQueue.length > 1) {
      const dropped = this.playQueue.shift()!;
      const unread = Math.max(0, dropped.length - this.playReadOffset);
      this.playQueueSamples = Math.max(0, this.playQueueSamples - unread);
      this.playReadOffset = 0;
    }
  }

  /** Fill output buffer from the playout ring (silence on underrun). */
  private pullRemotePcm(out: Float32Array, gain: number) {
    let i = 0;
    while (i < out.length) {
      if (this.playQueue.length === 0) {
        out.fill(0, i);
        return;
      }
      const chunk = this.playQueue[0];
      const available = chunk.length - this.playReadOffset;
      const need = out.length - i;
      const n = Math.min(available, need);
      for (let j = 0; j < n; j++) {
        let s = chunk[this.playReadOffset + j] * gain;
        // Soft clip
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        out[i + j] = s;
      }
      i += n;
      this.playReadOffset += n;
      this.playQueueSamples = Math.max(0, this.playQueueSamples - n);
      if (this.playReadOffset >= chunk.length) {
        this.playQueue.shift();
        this.playReadOffset = 0;
      }
    }
  }

  /** Capture-only AudioContext (may share hardware with playCtx on some OS). */
  private async ensureAudioCtx(_preferredRate = RELAY_SAMPLE_RATE) {
    const ios = isAppleMobile();
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AC = getAudioContextCtor();
      // iOS: never force sampleRate — silent mic tracks if mismatched
      if (ios) {
        this.audioCtx = new AC({ latencyHint: 'interactive' });
      } else {
        try {
          this.audioCtx = new AC({
            sampleRate: RELAY_SAMPLE_RATE,
            latencyHint: 'interactive',
          });
        } catch {
          this.audioCtx = new AC({ latencyHint: 'interactive' });
        }
      }
      this.playOutGain = ios ? 2.0 : 1.5;
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    this.bindAudioUnlock();
    return this.audioCtx;
  }

  private async ensurePlayCtx(_sampleRate = RELAY_SAMPLE_RATE) {
    // Play path is the pure-play graph (separate from mic capture)
    return this.ensurePlayGraph();
  }

  private async ensureCaptureCtx() {
    return this.ensureAudioCtx();
  }

  /** Low-latency PCM audio + optional JPEG video → Socket.IO */
  private async startRelayOut() {
    if (!this.localStream || !this.canSendMedia()) return;
    if (this.relayActive) return;

    this.setupCallReconnect();
    const audioTracks = this.localStream.getAudioTracks();

    try {
      if (audioTracks.length) {
        // Ensure mic is live; only leave disabled if user intentionally muted
        const userMuted = this.isMuted();
        for (const t of audioTracks) {
          if (!userMuted && !t.enabled) t.enabled = true;
          if (t.readyState !== 'live') {
            console.warn('[call] mic track not live', t.readyState, t.label);
          }
        }

        const ctx = await this.ensureCaptureCtx();
        // Re-resume after getUserMedia — iOS often suspends between accept and relay start
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => undefined);
        }

        const micStream = new MediaStream(audioTracks);
        this.captureSource = ctx.createMediaStreamSource(micStream);

        // Large buffer on all platforms → fewer callbacks → fewer CF tunnel messages
        const bufferSize = PROCESS_BUFFER;
        this.processor = ctx.createScriptProcessor(bufferSize, 1, 1);
        // Capture graph: near-silent OUT (keeps SP alive). Remote voice is on playCtx.
        this.outGain = ctx.createGain();
        this.outGain.gain.value = 0.0001;

        this.captureEnergyEma = 0;
        this.captureFrames = 0;
        this.pcmBatch = [];
        this.pcmBatchSamples = 0;

        // Ensure pure-play graph is running for remote voice (esp. iOS)
        void this.ensurePlayGraph();

        this.processor.onaudioprocess = (ev) => {
          if (!this.relayActive || this.ending) return;

          // Keep capture context running if the browser suspended it mid-call
          if (ctx.state === 'suspended') {
            void ctx.resume().catch(() => undefined);
          }

          // Capture SP output is intentional silence (remote plays on playCtx)
          ev.outputBuffer.getChannelData(0).fill(0);

          // ── CAPTURE: mic → relay (needs peer or group room) ──
          if (!this.canSendMedia()) return;

          // Respect user mute — do not send PCM while muted
          const track = this.localStream?.getAudioTracks()[0];
          if (track && !track.enabled) return;

          const input = ev.inputBuffer.getChannelData(0);
          // Copy — input buffer is reused
          const mono = new Float32Array(input.length);
          mono.set(input);

          const fromRate = ctx.sampleRate;
          const pcmFloat =
            fromRate === RELAY_SAMPLE_RATE
              ? mono
              : resample(mono, fromRate, RELAY_SAMPLE_RATE);

          // Soft noise gate: only drop near-digital silence. Previous gate was
          // too aggressive with AEC/AGC and caused one-way "dead mic" calls.
          let energy = 0;
          const step = Math.max(1, Math.floor(pcmFloat.length / 64));
          for (let i = 0; i < pcmFloat.length; i += step) {
            energy += Math.abs(pcmFloat[i]);
          }
          energy /= Math.max(1, Math.floor(pcmFloat.length / step));
          this.captureEnergyEma = this.captureEnergyEma * 0.85 + energy * 0.15;
          this.captureFrames += 1;

          const now = performance.now();
          // Very low floor — quiet speech / far mic must still transmit
          const silenceFloor = isAppleMobile() ? 0.00004 : 0.00012;
          const isSilent = energy < silenceFloor && this.captureEnergyEma < silenceFloor * 1.5;
          if (isSilent) {
            this.silentFramesSkipped += 1;
            // Heartbeat at most ~4/s of true silence (not every callback)
            if (this.silentFramesSkipped < 8 && now - this.lastPcmSentAt < 250) {
              return;
            }
            this.silentFramesSkipped = 0;
          } else {
            this.silentFramesSkipped = 0;
          }

          // Batch ~40ms then emit (≈25 pkt/s — fine for CF base64 JSON)
          const chunk = new Float32Array(pcmFloat.length);
          chunk.set(pcmFloat);
          this.pcmBatch.push(chunk);
          this.pcmBatchSamples += chunk.length;
          if (this.pcmBatchSamples >= PCM_BATCH_SAMPLES) {
            this.flushPcmBatch();
          }
        };

        // Silent driver so ScriptProcessor keeps firing even if mic is gated
        try {
          this.captureDriver = ctx.createOscillator();
          this.captureDriver.frequency.value = 20;
          this.captureDriverGain = ctx.createGain();
          this.captureDriverGain.gain.value = 0;
          this.captureDriver.connect(this.captureDriverGain);
          this.captureDriverGain.connect(this.processor);
          this.captureDriver.start();
        } catch {
          /* */
        }

        this.captureSource.connect(this.processor);
        // Must connect to destination so onaudioprocess fires
        this.processor.connect(this.outGain);
        this.outGain.connect(ctx.destination);

        // Flush partial batches so speech doesn't stick waiting for a full window
        if (this.pcmFlushTimer) clearInterval(this.pcmFlushTimer);
        this.pcmFlushTimer = setInterval(() => {
          if (!this.relayActive || this.ending) return;
          if (this.pcmBatchSamples > 0) this.flushPcmBatch();
        }, PCM_BATCH_MS + 10);

        // Keep both audio graphs + remote element alive (iOS/Chrome suspend mid-call)
        if (this.audioKeepaliveTimer) clearInterval(this.audioKeepaliveTimer);
        this.audioKeepaliveTimer = setInterval(() => {
          if (this.ending) return;
          void this.resumePlayback();
          if (this.audioCtx?.state === 'suspended') {
            void this.audioCtx.resume().catch(() => undefined);
          }
        }, 2000);

        console.debug('[call] PCM full-duplex relay', {
          ctxRate: ctx.sampleRate,
          targetRate: RELAY_SAMPLE_RATE,
          buffer: bufferSize,
          batchMs: PCM_BATCH_MS,
          cloudflare: isCloudflareHost(),
          ios: isAppleMobile(),
        });
      } else if (!this.wantsVideo()) {
        this.patch({ error: 'No microphone track' });
        return;
      }

      this.relayActive = true;
      this.relayMode = true;
      this.notify();

      // Video / screen frames over the same media channel
      if (this.wantsVideo()) {
        this.ensureRemoteVideoSurface(
          this.isScreenMode() ? SCREEN_MAX_W : VIDEO_MAX_W,
          this.isScreenMode() ? SCREEN_MAX_H : VIDEO_MAX_H
        );
        this.startVideoRelayOut();
        // Screen tracks often report 0×0 until the capture element is playing
        if (this.isScreenMode()) {
          void this.waitForLocalVideoReady(3000);
        }
        // Ensure capture element keeps producing frames (iOS can auto-pause)
        if (this.localVideoEl) {
          void this.localVideoEl.play().catch(() => undefined);
        }
      }
    } catch (e) {
      console.error('[call] media capture failed', e);
      this.patch({ error: 'Could not start media capture' });
    }
  }

  private stopRelayOut() {
    this.relayActive = false;
    // Flush any leftover voice so the last syllable isn't lost
    try {
      this.flushPcmBatch();
    } catch {
      /* */
    }
    if (this.pcmFlushTimer) {
      clearInterval(this.pcmFlushTimer);
      this.pcmFlushTimer = null;
    }
    if (this.audioKeepaliveTimer) {
      clearInterval(this.audioKeepaliveTimer);
      this.audioKeepaliveTimer = null;
    }
    this.stopVideoRelayOut();
    try {
      this.captureDriver?.stop();
      this.captureDriver?.disconnect();
      this.captureDriverGain?.disconnect();
      this.processor?.disconnect();
      this.captureSource?.disconnect();
      this.outGain?.disconnect();
    } catch {
      /* */
    }
    this.captureDriver = null;
    this.captureDriverGain = null;
    this.processor = null;
    this.captureSource = null;
    this.outGain = null;
    // Do NOT close audioCtx here — may still be priming; hangup closes it.
    this.captureEnergyEma = 0;
    this.captureFrames = 0;
    this.pcmBatch = [];
    this.pcmBatchSamples = 0;
    this.clearPlayQueue();
  }

  private wantsVideo(): boolean {
    return (
      this.callType === 'video' ||
      this.callType === 'screen' ||
      this.sharingScreen ||
      !!this.localStream?.getVideoTracks().length
    );
  }

  /**
   * Prepare offscreen paint canvas for remote JPEG frames.
   * Prefer mounting this canvas in the DOM (getRemoteVideoCanvas) for display —
   * captureStream→&lt;video&gt; softens badly when CSS-upscaled to full screen.
   * Keep captureStream only as a secondary MediaStream for consumers that need it.
   */
  private ensureRemoteVideoSurface(width = VIDEO_MAX_W, height = VIDEO_MAX_H) {
    if (this.remoteVideoCanvas && this.remoteVideoCtx) {
      // Never resize here — flushRemoteFrames sizes exactly to each bitmap.
      // Resizing on metadata guesses was clearing frames and fighting the draw path.
      if (!this.remoteStream) {
        try {
          this.remoteStream = this.remoteVideoCanvas.captureStream(REMOTE_CAPTURE_FPS);
          this.notify();
        } catch {
          /* */
        }
      }
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, width);
    canvas.height = Math.max(2, height);
    // Help browsers composite the mounted canvas sharply
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    canvas.style.background = '#000';
    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    // High quality for 1:1 paint and any rare scale; medium looked soft fullscreen
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.remoteVideoCanvas = canvas;
    this.remoteVideoCtx = ctx;
    try {
      // Optional MediaStream for any code still binding <video srcObject>
      this.remoteStream = canvas.captureStream(REMOTE_CAPTURE_FPS);
      this.notify();
    } catch (e) {
      console.warn('[call] canvas.captureStream unavailable', e);
      this.remoteStream = null;
      // Still notify so UI can mount the canvas element itself
      this.notify();
    }
  }

  private frameByteCap(): number {
    return this.isScreenMode() ? SCREEN_MAX_BYTES : VIDEO_MAX_BYTES;
  }

  /** Adapt FPS / quality / resolution — less aggressive so good links stay smooth. */
  private adaptVideoQuality(encodeMs: number, blobBytes: number) {
    this.encodeDurations.push(encodeMs);
    if (this.encodeDurations.length > 30) this.encodeDurations.shift();
    const now = performance.now();
    // Adapt slower so brief encode spikes don't tank FPS permanently
    if (now - this.lastAdaptAt < 2200) return;
    this.lastAdaptAt = now;

    const avg =
      this.encodeDurations.reduce((a, b) => a + b, 0) / (this.encodeDurations.length || 1);
    const dropRate =
      this.framesSent + this.framesDropped > 0
        ? this.framesDropped / (this.framesSent + this.framesDropped)
        : 0;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const byteCap = this.frameByteCap();
    const screen = this.isScreenMode();

    // Higher thresholds — toBlob often takes 20–40ms even on good hardware
    // Screen encode is heavier; don't punish FPS as hard
    let tier: NetworkTier = 'high';
    if (
      offline ||
      avg > (screen ? 140 : 120) ||
      dropRate > (screen ? 0.5 : 0.45) ||
      blobBytes > byteCap * 0.98
    ) {
      tier = 'critical';
    } else if (avg > (screen ? 85 : 70) || dropRate > (screen ? 0.32 : 0.28)) {
      tier = 'low';
    } else if (avg > (screen ? 55 : 45) || dropRate > (screen ? 0.2 : 0.16)) {
      tier = 'medium';
    }

    // Prefer stepping back up when healthy
    if (
      this.networkTier !== 'high' &&
      !offline &&
      avg < (screen ? 45 : 35) &&
      dropRate < 0.08 &&
      blobBytes < byteCap * 0.75
    ) {
      tier = this.networkTier === 'critical' ? 'low' : this.networkTier === 'low' ? 'medium' : 'high';
    }

    if (tier === this.networkTier && !screen) return;
    if (tier === this.networkTier && screen) return;
    this.networkTier = tier;
    // Only throttle video hard when truly critical — was also 'low', which felt choppy on good Wi‑Fi
    this.audioPriority = tier === 'critical';

    if (screen) {
      // Keep screen motion high — prefer FPS over resolution when stressed
      if (tier === 'high') {
        this.videoTargetFps = SCREEN_FPS;
        this.videoJpegQuality = SCREEN_JPEG_QUALITY;
        this.videoMaxW = SCREEN_MAX_W;
        this.videoMaxH = SCREEN_MAX_H;
      } else if (tier === 'medium') {
        this.videoTargetFps = 20;
        this.videoJpegQuality = 0.55;
        this.videoMaxW = 1152;
        this.videoMaxH = 648;
      } else if (tier === 'low') {
        this.videoTargetFps = 16;
        this.videoJpegQuality = 0.48;
        this.videoMaxW = 960;
        this.videoMaxH = 540;
      } else {
        this.videoTargetFps = SCREEN_FPS_MIN;
        this.videoJpegQuality = SCREEN_JPEG_QUALITY_MIN;
        this.videoMaxW = 800;
        this.videoMaxH = 450;
      }
    } else if (tier === 'high') {
      this.videoTargetFps = VIDEO_FPS_MAX;
      this.videoJpegQuality = VIDEO_JPEG_QUALITY;
      this.videoMaxW = VIDEO_MAX_W;
      this.videoMaxH = VIDEO_MAX_H;
    } else if (tier === 'medium') {
      // Prefer FPS over resolution for low latency
      this.videoTargetFps = 16;
      this.videoJpegQuality = 0.48;
      this.videoMaxW = 560;
      this.videoMaxH = 420;
    } else if (tier === 'low') {
      this.videoTargetFps = 12;
      this.videoJpegQuality = 0.42;
      this.videoMaxW = 480;
      this.videoMaxH = 360;
    } else {
      this.videoTargetFps = VIDEO_FPS_MIN;
      this.videoJpegQuality = VIDEO_JPEG_QUALITY_MIN;
      this.videoMaxW = VIDEO_MIN_W;
      this.videoMaxH = VIDEO_MIN_H;
    }
    this.framesSent = 0;
    this.framesDropped = 0;
    console.debug('[call] adapt', { tier, fps: this.videoTargetFps, q: this.videoJpegQuality });
  }

  private setupCallReconnect() {
    if (typeof window === 'undefined') return;
    const onOffline = () => {
      this.audioPriority = true;
      this.videoTargetFps = Math.min(this.videoTargetFps, 8);
    };
    const onOnline = () => {
      if (this.ending || !this.canSendMedia()) return;
      // Re-bind socket and soft-nudge media after brief network loss
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        void ensureSocketConnected()
          .then(() => {
            if (this.localStream && this.wantsVideo() && !this.videoLoopActive) {
              this.startVideoRelayOut();
            }
            // Reset tier upward gradually
            this.networkTier = 'medium';
            this.audioPriority = false;
            this.videoTargetFps = Math.max(this.videoTargetFps, 12);
          })
          .catch(() => undefined);
      }, 600);
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    // store for cleanup via hangup
    (this as { _netCleanup?: () => void })._netCleanup = () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    };
  }

  /** Capture local camera/screen as JPEG and relay over Socket.IO. */
  private startVideoRelayOut() {
    if (!this.wantsVideo() || !this.localStream || !this.canSendMedia()) return;
    if (this.videoLoopActive) return;

    const track = this.localStream.getVideoTracks()[0];
    if (!track) {
      console.warn('[call] no local video track for relay');
      return;
    }

    const isScreen = this.isScreenMode();
    // Cloudflare: slight quality trim only — keep high FPS so motion stays smooth
    const cf = isCloudflareHost();
    this.videoTargetFps = isScreen ? SCREEN_FPS : cf ? 15 : VIDEO_FPS_DEFAULT;
    this.videoJpegQuality = isScreen
      ? SCREEN_JPEG_QUALITY
      : cf
        ? 0.48
        : VIDEO_JPEG_QUALITY;
    // Camera stays 640×480 for latency; screen can be larger for text
    this.videoMaxW = isScreen ? (cf ? 960 : SCREEN_MAX_W) : VIDEO_MAX_W;
    this.videoMaxH = isScreen ? (cf ? 540 : SCREEN_MAX_H) : VIDEO_MAX_H;
    this.networkTier = 'high';
    this.audioPriority = false;
    this.encodeDurations = [];
    this.framesSent = 0;
    this.framesDropped = 0;
    this.jpegPending = false;

    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.setAttribute('playsinline', 'true');
    // Required for some browsers to decode getDisplayMedia into videoWidth/Height
    video.setAttribute('muted', 'true');
    video.srcObject = new MediaStream([track]);
    void video.play().catch((err) => {
      console.warn('[call] local capture video play failed', err);
    });
    this.localVideoEl = video;

    const canvas = document.createElement('canvas');
    this.localVideoCanvas = canvas;
    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false,
    });
    if (!ctx) return;
    // Medium/high scaling keeps faces readable after downscale to encode size
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.isScreenMode() ? 'high' : 'medium';
    this.localVideoCtx = ctx;

    this.videoSending = true;
    this.jpegBusy = false;
    this.lastVideoCaptureAt = 0;
    this.videoLoopActive = true;
    this.bindVideoVisibilityScheduler();
    this.syncVideoCaptureScheduler();
    console.debug('[call] video relay OUT', {
      fps: this.videoTargetFps,
      quality: this.videoJpegQuality,
      screen: isScreen,
    });
  }

  /**
   * rAF stops when Safari is minimized. For screen share, fall back to setInterval
   * so JPEG frames keep sending (browsers may still throttle ~1fps in deep background).
   * Dragging the window partially on-screen keeps rAF alive — that's why that "works".
   */
  private bindVideoVisibilityScheduler() {
    if (typeof document === 'undefined' || this.onVisibilityForVideo) return;
    this.onVisibilityForVideo = () => {
      if (!this.videoLoopActive || this.ending) return;
      // Keep capture element playing after backgrounding
      if (this.localVideoEl) {
        void this.localVideoEl.play().catch(() => undefined);
      }
      this.syncVideoCaptureScheduler();
    };
    document.addEventListener('visibilitychange', this.onVisibilityForVideo);
  }

  private clearVideoCaptureTimers() {
    if (this.videoRaf != null) {
      cancelAnimationFrame(this.videoRaf);
      this.videoRaf = null;
    }
    if (this.videoInterval != null) {
      clearInterval(this.videoInterval);
      this.videoInterval = null;
    }
  }

  private syncVideoCaptureScheduler() {
    if (!this.videoLoopActive || this.ending || !this.wantsVideo()) {
      this.clearVideoCaptureTimers();
      return;
    }
    this.clearVideoCaptureTimers();

    const bgScreen =
      this.isScreenMode() && typeof document !== 'undefined' && document.hidden;

    if (bgScreen) {
      // Prefer ~10–12fps attempt; OS may clamp lower when minimized
      const ms = Math.max(80, Math.round(1000 / Math.min(this.videoTargetFps, 12)));
      this.videoInterval = setInterval(() => {
        this.captureOneVideoFrame(performance.now());
      }, ms);
      this.captureOneVideoFrame(performance.now());
      console.debug('[call] screen encode: background interval', ms);
      return;
    }

    const tick = (now: number) => {
      if (!this.videoLoopActive || this.ending || !this.wantsVideo()) {
        this.videoRaf = null;
        return;
      }
      // If we became hidden mid-loop (screen share), switch schedulers
      if (this.isScreenMode() && document.hidden) {
        this.videoRaf = null;
        this.syncVideoCaptureScheduler();
        return;
      }
      this.videoRaf = requestAnimationFrame(tick);
      this.captureOneVideoFrame(now);
    };
    this.videoRaf = requestAnimationFrame(tick);
  }

  /** One capture/encode tick (used by both rAF and background interval). */
  private captureOneVideoFrame(now: number) {
    if (!this.videoSending || this.ending) return;

    const minFps = this.isScreenMode() ? SCREEN_FPS_MIN : VIDEO_FPS_MIN;
    const targetFps = this.audioPriority
      ? Math.min(this.videoTargetFps, this.isScreenMode() ? 14 : 12)
      : this.videoTargetFps;
    const frameMs = 1000 / Math.max(minFps, targetFps);
    if (now - this.lastVideoCaptureAt < frameMs) return;
    if (!this.canSendMedia()) return;

    const liveTrack = this.localStream?.getVideoTracks()[0];
    // muted (not ended) still happens when a window is minimized — keep trying to draw
    if (!liveTrack || !liveTrack.enabled || liveTrack.readyState !== 'live') return;

    const vEl = this.localVideoEl;
    const cnv = this.localVideoCanvas;
    const c2d = this.localVideoCtx;
    if (!vEl || !cnv || !c2d) return;

    // Capture element stalled (common after tab freeze) — kick play, don't kill loop
    if (vEl.readyState < 2 || vEl.videoWidth < 2 || vEl.paused) {
      void vEl.play().catch(() => undefined);
      return;
    }

    // Unstick if toBlob never completed (browser stall / GC)
    if (this.jpegBusy && now - this.lastVideoCaptureAt > 800) {
      this.jpegBusy = false;
      this.jpegPending = false;
    }

    if (this.jpegBusy) {
      this.drawLocalVideoFrame();
      this.jpegPending = true;
      return;
    }

    if (!this.drawLocalVideoFrame()) return;

    this.lastVideoCaptureAt = now;
    this.encodeAndSendFrame(this.videoJpegQuality);
  }

  /** Draw current camera frame into the encode canvas. Returns false if not ready. */
  private drawLocalVideoFrame(): boolean {
    const vEl = this.localVideoEl;
    const cnv = this.localVideoCanvas;
    const c2d = this.localVideoCtx;
    if (!vEl || !cnv || !c2d) return false;
    if (vEl.readyState < 2 || vEl.videoWidth < 2) return false;

    const maxW = this.videoMaxW;
    const maxH = this.videoMaxH;
    const vw = vEl.videoWidth || maxW;
    const vh = vEl.videoHeight || maxH;
    if (vw < 2 || vh < 2) return false;

    const scale = Math.min(maxW / vw, maxH / vh, 1);
    const w = Math.max(2, Math.round((vw * scale) / 2) * 2);
    const h = Math.max(2, Math.round((vh * scale) / 2) * 2);

    if (cnv.width !== w || cnv.height !== h) {
      cnv.width = w;
      cnv.height = h;
      // Resize resets 2d state
      c2d.imageSmoothingEnabled = true;
      c2d.imageSmoothingQuality = this.isScreenMode() ? 'high' : 'medium';
    }

    try {
      c2d.drawImage(vEl, 0, 0, w, h);
    } catch {
      return false;
    }
    this.videoEncodeW = w;
    this.videoEncodeH = h;
    return true;
  }

  /**
   * Rebind capture <video> to a new track, or fully restart the JPEG loop.
   * Used after front/rear camera swap.
   */
  private rebindLocalVideoCapture(track: MediaStreamTrack) {
    // Reset encode gate so a mid-switch toBlob callback can't stall forever
    this.jpegBusy = false;
    this.jpegPending = false;
    this.lastVideoCaptureAt = 0;

    if (this.localVideoEl && this.videoLoopActive) {
      this.localVideoEl.srcObject = new MediaStream([track]);
      void this.localVideoEl.play().catch(() => undefined);
      this.videoSending = track.enabled && this.wantsVideo();
      return;
    }

    // No active loop — start fresh
    if (this.relayActive && track.enabled) {
      this.stopVideoRelayOut();
      this.startVideoRelayOut();
    }
  }

  /** Encode current local canvas; re-encode at lower quality if oversize. */
  private encodeAndSendFrame(quality: number) {
    const canvas = this.localVideoCanvas;
    if (!canvas || this.ending || !this.canSendMedia()) return;
    // Avoid stacking toBlob if already encoding
    if (this.jpegBusy) {
      this.jpegPending = true;
      return;
    }
    this.jpegBusy = true;
    const w = this.videoEncodeW || canvas.width;
    const h = this.videoEncodeH || canvas.height;
    const t0 = performance.now();
    const byteCap = this.frameByteCap();
    const qMin = this.isScreenMode() ? SCREEN_JPEG_QUALITY_MIN : VIDEO_JPEG_QUALITY_MIN;
    let finished = false;

    const finishEncode = () => {
      if (finished) return;
      finished = true;
      this.jpegBusy = false;
      // Immediately encode the freshest drawn frame if one was queued while busy
      if (this.jpegPending && !this.ending && this.canSendMedia()) {
        this.jpegPending = false;
        this.drawLocalVideoFrame();
        this.encodeAndSendFrame(this.videoJpegQuality);
      }
    };

    // Hard unstick — some Safari builds drop toBlob callbacks under load
    const stuckTimer = window.setTimeout(() => {
      if (!finished) {
        this.framesDropped += 1;
        finishEncode();
      }
    }, 900);

    try {
      canvas.toBlob(
        (blob) => {
          window.clearTimeout(stuckTimer);
          const encodeMs = performance.now() - t0;
          if (!blob || this.ending || !this.canSendMedia()) {
            this.framesDropped += 1;
            this.adaptVideoQuality(encodeMs, 0);
            finishEncode();
            return;
          }

          // Too large → one cheaper re-encode (avoid multi-pass thrash that kills FPS)
          if (blob.size > byteCap && quality > qMin + 0.04) {
            const nextQ = Math.max(qMin, quality - (this.isScreenMode() ? 0.14 : 0.1));
            finished = true; // allow nested encode to own the gate
            this.jpegBusy = false;
            window.clearTimeout(stuckTimer);
            this.encodeAndSendFrame(nextQ);
            return;
          }

          // Still too large after min quality — skip (rare)
          if (blob.size > byteCap) {
            this.framesDropped += 1;
            this.adaptVideoQuality(encodeMs, blob.size);
            finishEncode();
            return;
          }

          void blob.arrayBuffer().then((buf) => {
            if (this.ending || !this.canSendMedia()) {
              finishEncode();
              return;
            }
            const sock = getSocket();
            if (!sock?.connected) {
              this.framesDropped += 1;
              // Don't thrash adapt downward on brief pauseSocket / tunnel blip
              void ensureSocketConnected().catch(() => undefined);
              finishEncode();
              return;
            }
            // Prefer base64 like PCM — binary attachments get mangled on CF tunnels
            emitMedia(
              this.mediaEnvelope({
                format: 'jpeg',
                width: w,
                height: h,
                dataB64: abToBase64(buf),
              })
            );
            this.framesSent += 1;
            this.adaptVideoQuality(encodeMs, blob.size);
            finishEncode();
          }).catch(() => {
            this.framesDropped += 1;
            finishEncode();
          });
        },
        'image/jpeg',
        quality
      );
    } catch {
      window.clearTimeout(stuckTimer);
      this.framesDropped += 1;
      finishEncode();
    }
  }

  private stopVideoRelayOut() {
    this.videoSending = false;
    this.videoLoopActive = false;
    this.clearVideoCaptureTimers();
    if (this.onVisibilityForVideo) {
      document.removeEventListener('visibilitychange', this.onVisibilityForVideo);
      this.onVisibilityForVideo = null;
    }
    if (this.localVideoEl) {
      try {
        this.localVideoEl.pause();
        this.localVideoEl.srcObject = null;
      } catch {
        /* */
      }
      this.localVideoEl = null;
    }
    this.localVideoCanvas = null;
    this.localVideoCtx = null;
    this.jpegBusy = false;
    this.jpegPending = false;
    // Do not clear remoteLatestFrame — inbound remote video is independent of local capture
  }

  private paintRemoteJpeg(
    buffer: ArrayBuffer,
    width?: number,
    height?: number,
    fromUserId?: string
  ) {
    // Group: paint into per-peer canvas so the UI can show a grid
    if (this.isGroup && fromUserId) {
      void this.paintPeerJpeg(fromUserId, buffer, width, height);
      return;
    }
    // Always keep the newest frame; never queue backlog (prevents laggy "slideshow")
    this.remoteLatestFrame = { buffer, width, height };
    if (this.remoteFramePending) return;
    void this.flushRemoteFrames();
  }

  private ensurePeerVideoSurface(userId: string, width = VIDEO_MAX_W, height = VIDEO_MAX_H) {
    let surface = this.peerVideoSurfaces.get(userId);
    if (surface) {
      if (surface.canvas.width !== width || surface.canvas.height !== height) {
        // Don't force resize every frame — only grow if needed later via draw
      }
      return surface;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, width, height);
    let stream: MediaStream;
    try {
      stream = canvas.captureStream(REMOTE_CAPTURE_FPS);
    } catch {
      return null;
    }
    surface = { canvas, ctx, stream, latest: null, pending: false };
    this.peerVideoSurfaces.set(userId, surface);
    this.remotePeerStreams = { ...this.remotePeerStreams, [userId]: stream };
    // Keep primary remoteStream for any single-tile fallbacks
    if (!this.remoteStream) this.remoteStream = stream;
    this.notify();
    return surface;
  }

  private async paintPeerJpeg(
    userId: string,
    buffer: ArrayBuffer,
    width?: number,
    height?: number
  ) {
    const surface = this.ensurePeerVideoSurface(
      userId,
      width && width > 0 ? width : VIDEO_MAX_W,
      height && height > 0 ? height : VIDEO_MAX_H
    );
    if (!surface) return;
    surface.latest = { buffer, width, height };
    if (surface.pending) return;
    surface.pending = true;
    try {
      while (surface.latest && !this.ending) {
        const frame = surface.latest;
        surface.latest = null;
        try {
          const blob = new Blob([frame.buffer], { type: 'image/jpeg' });
          const bmp = await createImageBitmap(blob, {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
          } as ImageBitmapOptions);
          try {
            if (
              surface.canvas.width !== bmp.width ||
              surface.canvas.height !== bmp.height
            ) {
              surface.canvas.width = bmp.width;
              surface.canvas.height = bmp.height;
            }
            surface.ctx.drawImage(bmp, 0, 0);
            if (this.status !== 'connected' && this.status !== 'idle' && this.status !== 'ended') {
              this.patch({ status: 'connected', error: null, relayMode: true });
            }
          } finally {
            bmp.close();
          }
        } catch {
          /* decode failed */
        }
      }
    } finally {
      surface.pending = false;
      if (surface.latest && !this.ending) {
        void this.paintPeerJpeg(userId, surface.latest.buffer, surface.latest.width, surface.latest.height);
        surface.latest = null;
      }
    }
  }

  private removePeerSurface(userId: string) {
    const surface = this.peerVideoSurfaces.get(userId);
    if (!surface) return;
    try {
      surface.stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* */
    }
    this.peerVideoSurfaces.delete(userId);
    const next = { ...this.remotePeerStreams };
    delete next[userId];
    this.remotePeerStreams = next;
    if (this.remoteStream === surface.stream) {
      const first = Object.values(next)[0] || null;
      this.remoteStream = first;
    }
    this.notify();
  }

  private clearPeerSurfaces() {
    for (const id of [...this.peerVideoSurfaces.keys()]) {
      this.removePeerSurface(id);
    }
    this.peerVideoSurfaces.clear();
    this.remotePeerStreams = {};
  }

  private async flushRemoteFrames() {
    if (this.remoteFramePending) return;
    this.remoteFramePending = true;

    try {
      while (this.remoteLatestFrame && !this.ending) {
        const frame = this.remoteLatestFrame;
        this.remoteLatestFrame = null;

        const hintW = frame.width && frame.width > 0 ? frame.width : VIDEO_MAX_W;
        const hintH = frame.height && frame.height > 0 ? frame.height : VIDEO_MAX_H;
        this.ensureRemoteVideoSurface(hintW, hintH);

        try {
          const blob = new Blob([frame.buffer], { type: 'image/jpeg' });
          const bmp = await createImageBitmap(blob, {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
            // resizeQuality only applies when resizing; keep native JPEG pixels
          } as ImageBitmapOptions);
          try {
            if (!this.remoteVideoCtx || !this.remoteVideoCanvas) continue;
            // Size canvas buffer to the frame's native pixels (1:1 paint = crisp)
            if (
              this.remoteVideoCanvas.width !== bmp.width ||
              this.remoteVideoCanvas.height !== bmp.height
            ) {
              this.remoteVideoCanvas.width = bmp.width;
              this.remoteVideoCanvas.height = bmp.height;
              // Restore smoothing after resize (browsers reset context state)
              this.remoteVideoCtx.imageSmoothingEnabled = true;
              this.remoteVideoCtx.imageSmoothingQuality = 'high';
            }
            this.remoteVideoCtx.drawImage(bmp, 0, 0);
            // Notify only on meaningful state changes — NOT every frame.
            // Per-frame notify re-rendered CallOverlay, re-bound local <video>,
            // and looked like the call was "pausing" constantly.
            if (this.status !== 'connected') {
              this.patch({ status: 'connected', error: null, relayMode: true });
            } else if (!this.remoteStream) {
              try {
                this.remoteStream = this.remoteVideoCanvas.captureStream(REMOTE_CAPTURE_FPS);
                this.notify();
              } catch {
                /* canvas-in-DOM path still works without MediaStream */
                this.notify();
              }
            }
          } finally {
            bmp.close();
          }
        } catch {
          /* decode failed — continue with next latest frame */
        }
      }
    } finally {
      this.remoteFramePending = false;
      // A frame may have arrived while we were finishing
      if (this.remoteLatestFrame && !this.ending) {
        void this.flushRemoteFrames();
      }
    }
  }

  private toArrayBuffer(
    data: ArrayBuffer | ArrayBufferView | Blob | number[] | string | unknown
  ): ArrayBuffer | null {
    return coerceArrayBuffer(data);
  }

  /** Receive remote PCM audio or JPEG video frames */
  onRemoteMedia(payload: {
    data?: ArrayBuffer | ArrayBufferView | Blob | number[] | string;
    dataB64?: string;
    format?: string;
    sampleRate?: number;
    mimeType?: string;
    width?: number;
    height?: number;
    fromUserId?: string;
    callId?: string;
  }) {
    if (this.ending) return;
    // Ignore media for other/stale calls
    if (
      this.callId &&
      payload.callId &&
      payload.callId !== this.callId
    ) {
      return;
    }
    // Drop only when truly idle/ended. Accept media while ringing/calling so the
    // first packets after accept aren't lost (was a common one-way audio race).
    if (this.status === 'idle' || this.status === 'ended') {
      return;
    }

    const format = payload.format || '';

    // Video frames
    if (
      format === 'jpeg' ||
      format === 'image/jpeg' ||
      payload.mimeType === 'image/jpeg'
    ) {
      const fromId = payload.fromUserId ? String(payload.fromUserId) : undefined;
      if (!payload.data && !payload.dataB64) return;
      if (payload.data instanceof Blob) {
        void payload.data.arrayBuffer().then((b) => {
          this.paintRemoteJpeg(b, payload.width, payload.height, fromId);
        });
        return;
      }
      const buf = this.toArrayBuffer(payload.data) || coerceArrayBuffer(payload.dataB64);
      if (buf) this.paintRemoteJpeg(buf, payload.width, payload.height, fromId);
      return;
    }

    // Legacy webm blobs from older clients — ignore
    if (format && format !== 'pcm_s16le' && payload.mimeType?.includes('webm')) {
      return;
    }

    // Prefer base64 (Cloudflare-safe). Fall back to binary for older peers.
    const playResolved = (buffer: ArrayBuffer) => {
      this.playPcmBuffer(buffer, payload.sampleRate || RELAY_SAMPLE_RATE);
    };

    if (payload.data instanceof Blob) {
      void payload.data.arrayBuffer().then(playResolved);
      return;
    }

    const buffer =
      coerceArrayBuffer(payload.dataB64) || this.toArrayBuffer(payload.data);
    if (!buffer) return;
    playResolved(buffer);
  }

  /**
   * Decode inbound PCM → pure-play ring + scheduled BufferSource on playCtx.
   * Never routes remote audio through the mic capture graph.
   */
  private playPcmBuffer(buffer: ArrayBuffer, sampleRate: number) {
    if (buffer.byteLength < 2 || this.ending) return;

    const usable = buffer.byteLength - (buffer.byteLength % 2);
    if (usable < 2) return;
    const pcmSlice = buffer.byteLength === usable ? buffer : buffer.slice(0, usable);

    const int16 = new Int16Array(usable / 2);
    const view = new DataView(pcmSlice, 0, usable);
    for (let i = 0; i < int16.length; i++) {
      int16[i] = view.getInt16(i * 2, true);
    }

    const f32 = int16ToFloat(int16);
    // Resample to play graph rate (not capture rate)
    const playRate = this.playCtx?.sampleRate || this.playSampleRate || RELAY_SAMPLE_RATE;
    const playData =
      sampleRate === playRate ? f32 : resample(f32, sampleRate, playRate);
    if (playData.length < 1) return;

    this.remotePackets += 1;

    // Feed pure-play ring (consumed by playProcessor on playCtx — not the mic graph)
    const wasEmpty = this.playQueueSamples < 32;
    this.enqueueRemotePcm(playData);

    // Ensure play graph exists (user may receive media before startRelayOut)
    void this.ensurePlayGraph().then(() => {
      void this.resumePlayback();
      // Fallback playout: before SP is up, or after underrun (one-way receive fix)
      if (!this.playGraphActive || wasEmpty) {
        this.scheduleWebAudioPlay(playData, playRate);
      }
    });

    // Caller/callee: start sending as soon as we hear the peer (covers missed answer)
    if (!this.relayActive && this.localStream && this.canSendMedia()) {
      void this.startRelayOut();
    }

    if (this.remotePackets === 1 || this.remotePackets % 40 === 0) {
      console.debug('[call] PCM IN', {
        packets: this.remotePackets,
        queued: this.playQueueSamples,
        sampleRate,
        playRate,
        playGraph: this.playGraphActive,
        ios: isAppleMobile(),
      });
    }

    if (this.status !== 'connected' && this.status !== 'idle' && this.status !== 'ended') {
      this.patch({ status: 'connected', error: null, relayMode: true });
    }
  }

  // ─── Public API ─────────────────────────────────────────────────

  async start(opts: {
    conversationId: string;
    remoteUserId: string;
    callType: CallType;
    /** Must be created via requestDisplayMedia() in the same click as start for screen calls. */
    displayPromise?: Promise<MediaStream>;
  }) {
    if (this.status !== 'idle' && this.status !== 'ended') {
      throw new Error('Already in a call');
    }

    // If screen call without a pre-started display promise, we cannot recover a gesture here.
    if (opts.callType === 'screen' && !opts.displayPromise) {
      throw new Error(
        'Screen share must be started from a click (getDisplayMedia requires a user gesture)'
      );
    }

    await ensureSocketConnected();
    // Unlock audio on user gesture residual (screen picker already consumed primary gesture)
    const actx = await this.ensurePlayCtx();
    await this.ensureCaptureCtx();
    await this.resumePlayback();
    this.primeSpeakerOutput(actx);

    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.ending = false;
    this.lastPcmSentAt = 0;
    this.silentFramesSkipped = 0;
    this.remotePackets = 0;
    this.clearPlayQueue();
    this.clearPeerSurfaces();

    this.patch({
      status: 'calling',
      callId,
      callType: opts.callType,
      remoteUserId: String(opts.remoteUserId),
      conversationId: opts.conversationId,
      isIncoming: false,
      incoming: null,
      error: null,
      remoteStream: null,
      relayMode: false,
      isGroup: false,
      initiatorId: null,
      members: [],
    });

    try {
      let stream: MediaStream;
      if (opts.callType === 'screen' && opts.displayPromise) {
        stream = await this.buildScreenCallStream(opts.displayPromise);
      } else {
        stream = await this.getMedia(opts.callType, 'caller');
      }
      this.localStream = stream;
      this.notify();

      emitSignal('call:initiate', {
        conversationId: opts.conversationId,
        targetUserId: String(opts.remoteUserId),
        callType: opts.callType,
        callId,
        preferRelay: true,
        sdpOffer: {
          type: 'offer',
          sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=PulseRelay\r\nt=0 0\r\n',
        },
      });

      this.patch({ status: 'connecting' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start';
      this.resetAll();
      this.patch({
        status: 'idle',
        error: /Permission|NotAllowed|denied|gesture/i.test(msg)
          ? /gesture|getDisplayMedia/i.test(msg)
            ? msg
            : 'Microphone/camera permission denied'
          : msg,
        callId: null,
        remoteUserId: null,
        conversationId: null,
        isGroup: false,
        members: [],
      });
      throw e;
    }
  }

  /**
   * Start a multi-party call in a group conversation.
   * Rings selected members; media is server-fanned to all joined peers.
   */
  async startGroup(opts: {
    conversationId: string;
    inviteUserIds: string[];
    callType: CallType;
    displayPromise?: Promise<MediaStream>;
  }) {
    if (this.status !== 'idle' && this.status !== 'ended') {
      throw new Error('Already in a call');
    }
    const inviteUserIds = [...new Set(opts.inviteUserIds.map(String).filter(Boolean))];
    if (!inviteUserIds.length) {
      throw new Error('Select at least one member to call');
    }
    if (opts.callType === 'screen' && !opts.displayPromise) {
      throw new Error(
        'Screen share must be started from a click (getDisplayMedia requires a user gesture)'
      );
    }

    await ensureSocketConnected();
    const actx = await this.ensurePlayCtx();
    await this.ensureCaptureCtx();
    await this.resumePlayback();
    this.primeSpeakerOutput(actx);

    const callId = `gcall_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.ending = false;
    this.lastPcmSentAt = 0;
    this.silentFramesSkipped = 0;
    this.remotePackets = 0;
    this.clearPlayQueue();
    this.clearPeerSurfaces();

    const members: CallMember[] = [
      ...inviteUserIds.map((id) => ({ userId: id, status: 'invited' as const })),
    ];

    this.patch({
      status: 'calling',
      callId,
      callType: opts.callType,
      remoteUserId: inviteUserIds[0],
      conversationId: opts.conversationId,
      isIncoming: false,
      incoming: null,
      error: null,
      remoteStream: null,
      relayMode: false,
      isGroup: true,
      initiatorId: null, // filled after local identity not needed for host
      members,
    });

    try {
      let stream: MediaStream;
      if (opts.callType === 'screen' && opts.displayPromise) {
        stream = await this.buildScreenCallStream(opts.displayPromise);
      } else {
        stream = await this.getMedia(opts.callType, 'caller');
      }
      this.localStream = stream;
      this.notify();

      emitSignal('call:group:start', {
        conversationId: opts.conversationId,
        inviteUserIds,
        callType: opts.callType,
        callId,
      });

      // Host starts sending immediately so early joiners hear audio
      await this.startRelayOut();
      this.patch({ status: 'connecting', relayMode: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start group call';
      this.resetAll();
      this.patch({
        status: 'idle',
        error: /Permission|NotAllowed|denied|gesture/i.test(msg)
          ? /gesture|getDisplayMedia/i.test(msg)
            ? msg
            : 'Microphone/camera permission denied'
          : msg,
        callId: null,
        remoteUserId: null,
        conversationId: null,
        isGroup: false,
        members: [],
      });
      throw e;
    }
  }

  /** Invite more conversation members into an active group call. */
  inviteToGroup(inviteUserIds: string[]) {
    if (!this.isGroup || !this.callId) {
      throw new Error('Not in a group call');
    }
    const ids = [...new Set(inviteUserIds.map(String).filter(Boolean))];
    if (!ids.length) return;
    emitSignal('call:group:invite', {
      callId: this.callId,
      inviteUserIds: ids,
    });
    // Optimistic roster update
    const next = [...this.members];
    for (const id of ids) {
      if (!next.some((m) => m.userId === id)) {
        next.push({ userId: id, status: 'invited' });
      }
    }
    this.patch({ members: next });
  }

  applyGroupRoster(members: CallMember[], meta?: { initiatorId?: string; callType?: CallType }) {
    if (!members?.length && !this.isGroup) return;
    this.patch({
      isGroup: true,
      members: members.map((m) => ({
        userId: String(m.userId),
        status: m.status,
      })),
      ...(meta?.initiatorId ? { initiatorId: String(meta.initiatorId) } : {}),
      ...(meta?.callType ? { callType: meta.callType } : {}),
    });
    // Prefer a joined peer as remoteUserId for any legacy 1:1 UI bits
    const joined = members.filter((m) => m.status === 'joined').map((m) => String(m.userId));
    if (joined.length && this.remoteUserId && !joined.includes(this.remoteUserId)) {
      // keep existing remoteUserId if still joined
    } else if (joined.length && !this.remoteUserId) {
      this.patch({ remoteUserId: joined[0] });
    }
  }

  onGroupPeerJoined(userId: string, members?: CallMember[]) {
    if (members) this.applyGroupRoster(members);
    else {
      const next = this.members.map((m) =>
        m.userId === userId ? { ...m, status: 'joined' as const } : m
      );
      if (!next.some((m) => m.userId === userId)) {
        next.push({ userId, status: 'joined' });
      }
      this.patch({ members: next, remoteUserId: this.remoteUserId || userId });
    }
    if (this.status === 'calling' || this.status === 'connecting' || this.status === 'ringing') {
      this.patch({ status: 'connected', relayMode: true });
    }
    if (this.localStream && !this.relayActive) {
      void this.startRelayOut();
    }
  }

  onGroupPeerLeft(userId: string, members?: CallMember[]) {
    if (members) this.applyGroupRoster(members);
    else {
      this.patch({
        members: this.members.map((m) =>
          m.userId === userId ? { ...m, status: 'left' as const } : m
        ),
      });
    }
    this.removePeerSurface(userId);
    const stillJoined = (members || this.members).filter((m) => m.status === 'joined');
    // If only we remain, stay connected until user hangs up
    if (stillJoined.length <= 1 && this.status === 'connected') {
      // keep call open for re-invites
    }
  }

  onGroupPeerRejected(userId: string, members?: CallMember[]) {
    if (members) this.applyGroupRoster(members);
    else {
      this.patch({
        members: this.members.map((m) =>
          m.userId === userId ? { ...m, status: 'rejected' as const } : m
        ),
      });
    }
  }

  /** Finish a standalone screen call after requestDisplayMedia() from a click. */
  private async buildScreenCallStream(
    displayPromise: Promise<MediaStream>
  ): Promise<MediaStream> {
    const screen = await displayPromise;
    try {
      const micConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (!isAppleMobile()) {
        micConstraints.sampleRate = RELAY_SAMPLE_RATE;
      }
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints,
      });
      mic.getAudioTracks().forEach((t) => screen.addTrack(t));
    } catch {
      /* mic optional */
    }
    const vt = screen.getVideoTracks()[0];
    if (vt) {
      this.screenTrack = vt;
      this.sharingScreen = true;
      this.bindScreenEnded(vt, true);
    }
    return screen;
  }

  onIncoming(payload: IncomingCall) {
    if (!payload?.fromUserId && !payload?.initiatorId) return;
    const from = String(payload.fromUserId || payload.initiatorId || '');

    if (this.status === 'connecting' || this.status === 'connected' || this.status === 'calling') {
      if (payload.group) {
        emitSignal('call:group:reject', { callId: payload.callId });
      } else {
        emitSignal('call:reject', {
          targetUserId: from,
          callId: payload.callId,
        });
      }
      return;
    }

    this.ending = false;
    this.clearPeerSurfaces();
    this.patch({
      status: 'ringing',
      isIncoming: true,
      callId: payload.callId,
      callType: payload.callType || 'audio',
      remoteUserId: from,
      conversationId: payload.conversationId,
      isGroup: !!payload.group,
      initiatorId: payload.initiatorId ? String(payload.initiatorId) : from,
      members: payload.members || [],
      incoming: {
        ...payload,
        fromUserId: from,
        callType: payload.callType || 'audio',
        group: !!payload.group,
      },
      error: null,
    });
  }

  async accept() {
    const inc = this.incoming;
    if (!inc || !this.callId) {
      throw new Error('No incoming call');
    }

    this.patch({ status: 'connecting', isIncoming: false, error: null });

    try {
      await ensureSocketConnected();
      // Unlock AudioContext on accept gesture (iOS will only play remote audio after this)
      const actx = await this.ensurePlayCtx();
      await this.ensureCaptureCtx();
      await this.resumePlayback();
      this.primeSpeakerOutput(actx);

      const stream = await this.getMedia(this.callType, 'callee');
      this.localStream = stream;
      this.notify();

      if (this.isGroup || inc.group) {
        emitSignal('call:group:accept', { callId: this.callId });
        this.patch({ isGroup: true });
      } else {
        if (!this.remoteUserId) throw new Error('No remote user');
        emitSignal('call:accept', {
          targetUserId: this.remoteUserId,
          callId: this.callId,
          preferRelay: true,
          sdpAnswer: {
            type: 'answer',
            sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=PulseRelay\r\nt=0 0\r\n',
          },
        });
      }

      await this.startRelayOut();
      this.patch({
        status: 'connected',
        incoming: null,
        relayMode: true,
        error: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Accept failed';
      if (this.isGroup || inc.group) {
        emitSignal('call:group:reject', { callId: this.callId });
      } else if (this.remoteUserId) {
        emitSignal('call:reject', {
          targetUserId: this.remoteUserId,
          callId: this.callId,
        });
      }
      this.resetAll();
      this.patch({
        status: 'idle',
        error: /Permission|NotAllowed|denied/i.test(msg)
          ? 'Microphone/camera permission denied'
          : msg,
        callId: null,
        remoteUserId: null,
        conversationId: null,
        incoming: null,
        isIncoming: false,
        isGroup: false,
        members: [],
      });
      throw e;
    }
  }

  reject() {
    if (this.isGroup || this.incoming?.group) {
      if (this.callId) emitSignal('call:group:reject', { callId: this.callId });
    } else if (this.remoteUserId && this.callId) {
      emitSignal('call:reject', {
        targetUserId: this.remoteUserId,
        callId: this.callId,
      });
    }
    void this.hangup(false);
  }

  async onRemoteAnswer(_sdpAnswer?: RTCSessionDescriptionInit) {
    if (this.ending) return;
    // Group joins use call:group:peer-joined instead
    if (this.isGroup) {
      if (this.localStream && !this.relayActive) void this.startRelayOut();
      this.patch({ status: 'connected', error: null, relayMode: true });
      return;
    }
    console.debug('[call] remote accepted — PCM relay');

    const actx = await this.ensurePlayCtx();
    await this.ensureCaptureCtx();
    await this.resumePlayback();
    this.primeSpeakerOutput(actx);

    if (this.localStream) {
      await this.startRelayOut();
    }

    this.patch({
      status: 'connected',
      error: null,
      relayMode: true,
    });
  }

  async onRemoteIce(_candidate: RTCIceCandidateInit) {
    // No-op — relay path does not use ICE
  }

  private resetAll() {
    try {
      (this as { _netCleanup?: () => void })._netCleanup?.();
      (this as { _netCleanup?: () => void })._netCleanup = undefined;
    } catch {
      /* */
    }
    this.stopRelayOut();
    this.lastPcmSentAt = 0;
    this.silentFramesSkipped = 0;
    this.remotePackets = 0;
    this.clearPlayQueue();
    this.remoteFramePending = false;
    this.remoteLatestFrame = null;
    this.remoteVideoCanvas = null;
    this.remoteVideoCtx = null;
    this.clearPeerSurfaces();
    this.networkTier = 'high';
    this.audioPriority = false;
    this.encodeDurations = [];
    this.unbindAudioUnlock();
    this.teardownRemoteAudioElement();

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close().catch(() => undefined);
    }
    this.audioCtx = null;
    // playCtx closed inside stopPlayGraph / teardownRemoteAudioElement

    this.localStream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* */
      }
    });
    this.localStream = null;
    // Stop canvas.captureStream tracks so the tab doesn't keep encoding
    this.remoteStream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* */
      }
    });
    this.remoteStream = null;
    this.relayMode = false;
    this.isGroup = false;
    this.initiatorId = null;
    this.members = [];
    this.viewerFullscreen = false;
    this.facingMode = 'user';
    this.switchingCamera = false;
    this.sharingScreen = false;
    this.sharingScreenBusy = false;
    if (this.screenTrack && this.onScreenEnded) {
      try {
        this.screenTrack.removeEventListener('ended', this.onScreenEnded);
      } catch {
        /* */
      }
    }
    this.screenTrack = null;
    this.onScreenEnded = null;
    if (this.parkedCameraTrack) {
      try {
        this.parkedCameraTrack.stop();
      } catch {
        /* */
      }
      this.parkedCameraTrack = null;
    }
    this.remoteLatestFrame = null;
  }

  async hangup(notifyRemote = true) {
    if (this.ending) return;
    this.ending = true;

    if (notifyRemote && this.callId) {
      if (this.isGroup) {
        emitSignal('call:group:leave', { callId: this.callId });
      } else if (this.remoteUserId) {
        emitSignal('call:end', {
          targetUserId: this.remoteUserId,
          callId: this.callId,
        });
      }
    }

    this.resetAll();
    this.patch({
      status: 'idle',
      callId: null,
      remoteUserId: null,
      conversationId: null,
      isIncoming: false,
      incoming: null,
      localStream: null,
      remoteStream: null,
      error: null,
      relayMode: false,
      isGroup: false,
      initiatorId: null,
      members: [],
      remotePeerStreams: {},
    });
    this.ending = false;
  }

  toggleMute(): boolean {
    const audio = this.localStream?.getAudioTracks()[0];
    if (!audio) return false;
    audio.enabled = !audio.enabled;
    this.notify();
    return !audio.enabled;
  }

  toggleVideo(): boolean {
    const video = this.localStream?.getVideoTracks()[0];
    if (!video) return false;
    video.enabled = !video.enabled;
    const on = video.enabled && this.wantsVideo();
    // When camera is off, pause encoding (saves bandwidth) but keep the rAF loop
    this.videoSending = on;

    if (on && this.relayActive) {
      // Unstick encode gate after a long pause
      this.jpegBusy = false;
      this.jpegPending = false;
      this.lastVideoCaptureAt = 0;
      // Capture <video> can stall while the track was disabled — kick it
      if (this.localVideoEl) {
        try {
          const track = this.localStream?.getVideoTracks()[0];
          if (track && this.localVideoEl.srcObject) {
            const ms = this.localVideoEl.srcObject as MediaStream;
            if (!ms.getVideoTracks().includes(track)) {
              this.localVideoEl.srcObject = new MediaStream([track]);
            }
          }
          void this.localVideoEl.play().catch(() => undefined);
        } catch {
          /* */
        }
      }
      // If the loop somehow died, rebuild the full JPEG pipeline
      if (!this.videoLoopActive) {
        this.stopVideoRelayOut();
        this.startVideoRelayOut();
      } else {
        this.syncVideoCaptureScheduler();
      }
    }

    this.notify();
    return !video.enabled;
  }

  isSharingScreen(): boolean {
    return this.sharingScreen;
  }

  /**
   * Stop share if active; otherwise caller must use requestDisplayMedia() from a
   * click handler then attachScreenShare(promise).
   */
  async toggleScreenShare(): Promise<boolean> {
    if (this.sharingScreen) {
      await this.stopScreenShare(true);
      return false;
    }
    // Cannot start here — getDisplayMedia needs a direct user gesture.
    throw new Error('Use requestDisplayMedia from a click handler, then attachScreenShare');
  }

  /**
   * Attach a display stream obtained via requestDisplayMedia() under a user gesture.
   */
  async attachScreenShare(displayPromise: Promise<MediaStream>): Promise<void> {
    if (this.ending || !this.canSendMedia()) {
      try {
        const s = await displayPromise;
        s.getTracks().forEach((t) => t.stop());
      } catch {
        /* */
      }
      throw new Error('Not in a call');
    }
    if (this.sharingScreenBusy || this.sharingScreen) {
      try {
        const s = await displayPromise;
        s.getTracks().forEach((t) => t.stop());
      } catch {
        /* */
      }
      return;
    }
    if (!this.localStream) {
      try {
        const s = await displayPromise;
        s.getTracks().forEach((t) => t.stop());
      } catch {
        /* */
      }
      throw new Error('No local media');
    }

    this.sharingScreenBusy = true;
    try {
      const display = await displayPromise;
      const track = display.getVideoTracks()[0];
      if (!track) {
        display.getTracks().forEach((t) => t.stop());
        throw new Error('No screen track');
      }

      // Park camera track (do not stop — restore later)
      const cam = this.localStream.getVideoTracks()[0];
      if (cam && cam !== track) {
        this.localStream.removeTrack(cam);
        if (!this.parkedCameraTrack) {
          this.parkedCameraTrack = cam;
          cam.enabled = false;
        } else if (cam !== this.parkedCameraTrack) {
          try {
            cam.stop();
          } catch {
            /* */
          }
        }
      }

      this.localStream.addTrack(track);
      this.screenTrack = track;
      this.sharingScreen = true;
      this.bindScreenEnded(track, this.callType === 'screen');

      // Fresh stream identity for React local preview
      this.localStream = new MediaStream(this.localStream.getTracks());

      this.stopVideoRelayOut();
      this.ensureRemoteVideoSurface(SCREEN_MAX_W, SCREEN_MAX_H);
      this.startVideoRelayOut();
      await this.waitForLocalVideoReady(3000);
      this.videoSending = true;
      this.notify();
      console.debug('[call] screen share started', {
        w: this.localVideoEl?.videoWidth,
        h: this.localVideoEl?.videoHeight,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Screen share failed';
      if (
        /NotAllowed|Permission|denied|cancel|Abort/i.test(msg) ||
        (e instanceof DOMException &&
          (e.name === 'NotAllowedError' || e.name === 'AbortError'))
      ) {
        this.patch({ error: 'Screen share cancelled or blocked' });
      } else if (/user gesture|UserGesture/i.test(msg)) {
        this.patch({
          error: 'Screen share must be started from a click — try the Share screen button again',
        });
      } else {
        this.patch({ error: msg || 'Could not share screen' });
      }
      throw e;
    } finally {
      this.sharingScreenBusy = false;
    }
  }

  /**
   * Stop screen share and restore camera when this was a video call.
   * @param restoreCamera when false (browser "Stop sharing"), still try restore
   */
  async stopScreenShare(restoreCamera = true): Promise<void> {
    if (this.sharingScreenBusy) return;
    this.sharingScreenBusy = true;
    try {
      if (this.screenTrack && this.onScreenEnded) {
        try {
          this.screenTrack.removeEventListener('ended', this.onScreenEnded);
        } catch {
          /* */
        }
      }
      if (this.screenTrack) {
        try {
          this.localStream?.removeTrack(this.screenTrack);
        } catch {
          /* */
        }
        try {
          this.screenTrack.stop();
        } catch {
          /* */
        }
        this.screenTrack = null;
      }
      this.onScreenEnded = null;
      this.sharingScreen = false;

      // Pure screen call with no camera to restore — end call
      if (this.callType === 'screen' && !this.parkedCameraTrack && !restoreCamera) {
        this.sharingScreenBusy = false;
        void this.hangup(true);
        return;
      }

      if (restoreCamera || this.callType === 'video' || this.parkedCameraTrack) {
        let cam = this.parkedCameraTrack;
        if (cam && cam.readyState !== 'live') {
          try {
            cam.stop();
          } catch {
            /* */
          }
          cam = null;
          this.parkedCameraTrack = null;
        }
        if (!cam && (this.callType === 'video' || this.callType === 'audio')) {
          // Re-open camera for video calls; audio-only mid-share leaves video off
          if (this.callType === 'video') {
            try {
              const s = await this.openCamera(this.facingMode);
              cam = s.getVideoTracks()[0] || null;
            } catch {
              cam = null;
            }
          }
        }
        if (cam && this.localStream) {
          cam.enabled = true;
          if (!this.localStream.getVideoTracks().includes(cam)) {
            this.localStream.addTrack(cam);
          }
          this.parkedCameraTrack = null;
        }
      }

      if (this.localStream) {
        this.localStream = new MediaStream(this.localStream.getTracks());
      }

      this.stopVideoRelayOut();
      if (this.relayActive && this.localStream?.getVideoTracks()[0]) {
        this.startVideoRelayOut();
        this.videoSending = true;
        await this.waitForLocalVideoReady(1500);
      }
      this.notify();
    } finally {
      this.sharingScreenBusy = false;
    }
  }

  /**
   * Flip between front and rear camera (video calls only).
   * Replaces the local video track; audio and relay stay active.
   */
  async switchCamera(): Promise<'user' | 'environment' | null> {
    if (this.callType !== 'video' || !this.localStream || this.ending) {
      return null;
    }
    if (this.sharingScreen) {
      this.patch({ error: 'Stop screen share before switching camera' });
      return null;
    }
    if (this.switchingCamera) return this.facingMode;

    const next: 'user' | 'environment' =
      this.facingMode === 'user' ? 'environment' : 'user';
    this.switchingCamera = true;

    // Pause outbound video while we swap so the loop doesn't sample a dying track
    const wasSending = this.videoSending;
    this.videoSending = false;
    this.jpegBusy = false;

    try {
      const camStream = await this.openCamera(next);
      const newTrack = camStream.getVideoTracks()[0];
      if (!newTrack) {
        camStream.getTracks().forEach((t) => t.stop());
        throw new Error('No camera track');
      }

      const oldTrack = this.localStream.getVideoTracks()[0];
      const wasEnabled = oldTrack ? oldTrack.enabled : true;
      newTrack.enabled = wasEnabled;

      // Build a fresh stream (new object identity for React) with new video + same audio
      const audioTracks = this.localStream.getAudioTracks();
      if (oldTrack) {
        try {
          oldTrack.stop();
        } catch {
          /* */
        }
      }
      this.localStream = new MediaStream([...audioTracks, newTrack]);

      // Prefer the actual device-reported facing mode when available
      const reported = newTrack.getSettings().facingMode;
      this.facingMode =
        reported === 'environment' || reported === 'user' ? reported : next;

      // Full restart of JPEG pipeline is more reliable than reusing a closed-over track
      this.stopVideoRelayOut();
      if (this.relayActive && wasEnabled) {
        this.startVideoRelayOut();
        // Wait briefly for the capture element to produce frames (avoids black freeze)
        await this.waitForLocalVideoReady(1200);
      } else if (wasSending && wasEnabled) {
        this.rebindLocalVideoCapture(newTrack);
      }

      this.videoSending = wasEnabled && this.wantsVideo();
      this.notify();
      return this.facingMode;
    } catch (err) {
      console.warn('[call] switchCamera failed', err);
      // Resume previous capture if it was running
      if (this.relayActive && this.localStream?.getVideoTracks()[0]?.enabled) {
        if (!this.videoLoopActive) this.startVideoRelayOut();
        else this.videoSending = true;
      }
      this.patch({
        error:
          next === 'environment'
            ? 'Could not open rear camera'
            : 'Could not open front camera',
      });
      return null;
    } finally {
      this.switchingCamera = false;
    }
  }

  /** Resolve when the local capture <video> has dimensions (or timeout). */
  private waitForLocalVideoReady(timeoutMs: number): Promise<void> {
    const el = this.localVideoEl;
    if (!el) return Promise.resolve();
    if (el.readyState >= 2 && el.videoWidth > 0) return Promise.resolve();

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener('loadeddata', finish);
        el.removeEventListener('playing', finish);
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, timeoutMs);
      el.addEventListener('loadeddata', finish);
      el.addEventListener('playing', finish);
      void el.play().catch(() => undefined);
    });
  }

  isMuted() {
    const a = this.localStream?.getAudioTracks()[0];
    return a ? !a.enabled : false;
  }

  isVideoOff() {
    const v = this.localStream?.getVideoTracks()[0];
    return v ? !v.enabled : false;
  }

  getFacingMode(): 'user' | 'environment' {
    return this.facingMode;
  }
}

export const webrtc = new CallService();
