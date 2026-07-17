import { io, Socket } from 'socket.io-client';
import { getAccessToken, getApiBaseUrl } from './api';
import { readRefreshToken } from '../shared/api/tokenStorage';

let socket: Socket | null = null;
let listenersBound = false;

export function getSocket(): Socket | null {
  return socket;
}

export function connectSocket(): Socket {
  const base = getApiBaseUrl() || window.location.origin;
  const token = getAccessToken();

  // Reuse existing instance; refresh auth and reconnect if needed
  if (socket) {
    socket.auth = { token };
    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }

  // Cloudflare quick tunnels: longer timeouts. WebSocket first for lower call latency
  // (pure-play dual AudioContext fixed one-way audio; polling added ~100–300ms).
  const throughCf =
    typeof location !== 'undefined' &&
    /trycloudflare\.com|cfargotunnel\.com/i.test(location.hostname);
  const throughTunnel =
    throughCf ||
    (typeof location !== 'undefined' && /ngrok/i.test(location.hostname));

  socket = io(base, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    upgrade: true,
    auth: { token },
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: throughTunnel ? 1000 : 800,
    reconnectionDelayMax: throughTunnel ? 8000 : 6000,
    // CF free tunnels can be slow to establish
    timeout: throughTunnel ? 20000 : 12000,
    autoConnect: true,
    // On Cloudflare, encode binary as base64 (audio already uses dataB64)
    forceBase64: throughCf,
    transportOptions: {
      polling: {
        extraHeaders: {
          'ngrok-skip-browser-warning': 'true',
        },
      },
    },
  });

  if (!listenersBound) {
    listenersBound = true;
    socket.on('connect', () => {
      if (import.meta.env.DEV) {
        console.debug('[socket] connected', socket?.id);
      }
    });

    socket.on('disconnect', (reason) => {
      if (import.meta.env.DEV) {
        console.debug('[socket] disconnected', reason);
      }
    });

    socket.on('connect_error', (err) => {
      if (import.meta.env.DEV) {
        console.warn('[socket] connect_error', err.message);
      }
      const t = getAccessToken();
      if (t && socket) socket.auth = { token: t };
    });

    // Keep token fresh on every reconnect attempt
    socket.io.on('reconnect_attempt', () => {
      const t = getAccessToken();
      if (t && socket) socket.auth = { token: t };
    });
  }

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    // Only disconnect — do not removeAllListeners here while modules may rebind.
    // Full teardown:
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
    socket = null;
    listenersBound = false;
  }
}

/**
 * Soft-close the transport without destroying the Socket.IO client.
 * Required for iOS Safari bfcache: an open WebSocket blocks freeze, so Safari
 * kills the tab → full cold reload when the user returns.
 * Pair with resumeSocket() on pageshow / visibility visible.
 */
export function pauseSocket(): void {
  if (!socket) return;
  try {
    // Disable auto-reconnect while backgrounded so we don't thrash
    socket.io.opts.reconnection = false;
    if (socket.connected) {
      socket.disconnect();
    }
  } catch {
    /* */
  }
}

/** Re-open after pauseSocket / app return. Safe to call often. */
export function resumeSocket(): Socket | null {
  const token = getAccessToken();
  if (!token && !readRefreshToken()) {
    return socket;
  }
  try {
    if (socket) {
      socket.io.opts.reconnection = true;
      socket.auth = { token: getAccessToken() };
      if (!socket.connected) {
        socket.connect();
      }
      return socket;
    }
    return connectSocket();
  } catch {
    return socket;
  }
}

/** Ensure socket is connected before call signaling. */
export function ensureSocketConnected(timeoutMs = 8000): Promise<Socket> {
  const s = connectSocket();
  // Ensure reconnection is on (may have been paused in background)
  try {
    s.io.opts.reconnection = true;
  } catch {
    /* */
  }
  if (s.connected) return Promise.resolve(s);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timeout')), timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (!s.connected) s.connect();
  });
}

export function updateSocketAuth(token: string) {
  if (socket) {
    socket.auth = { token };
    if (!socket.connected) socket.connect();
  }
}
