import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  Send,
  Paperclip,
  Smile,
  Mic,
  X,
  Image as ImageIcon,
  Square,
  Timer,
  Gamepad2,
} from 'lucide-react';
import { PlayPicker } from './play/PlayPicker';
import type { EmojiClickData } from 'emoji-picker-react';
import { Theme } from 'emoji-picker-react';
import { Button } from '../ui/Button';
import { useChatStore } from '../../store/chatStore';
import { useAuthStore } from '../../store/authStore';
import { chatService } from '../../services/chat.service';
import { getSocket } from '../../services/socket';
import { encryptMediaFiles, encryptMessageContent } from '../../services/e2e';
import { getSender } from '../../utils/format';
import toast from 'react-hot-toast';
import { cn } from '../../utils/cn';

// Lazy-load heavy emoji picker only when opened
const EmojiPicker = lazy(() => import('emoji-picker-react'));

interface Props {
  conversationId: string;
}

export function MessageInput({ conversationId }: Props) {
  const user = useAuthStore((s) => s.user);
  const replyTo = useChatStore((s) => s.replyTo);
  const editingMessage = useChatStore((s) => s.editingMessage);
  const uploadProgress = useChatStore((s) => s.uploadProgress);
  const setReplyTo = useChatStore((s) => s.setReplyTo);
  const setEditingMessage = useChatStore((s) => s.setEditingMessage);
  const setUploadProgress = useChatStore((s) => s.setUploadProgress);
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [recording, setRecording] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [viewOnce, setViewOnce] = useState(false);
  const [showPlay, setShowPlay] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewUrls = useRef<string[]>([]);

  // Stable object URLs for previews (revoke on change/unmount)
  const filePreviews = useMemo(() => {
    previewUrls.current.forEach((u) => URL.revokeObjectURL(u));
    previewUrls.current = files.map((f) => URL.createObjectURL(f));
    return previewUrls.current;
  }, [files]);

  // Reset composer when switching chats (prevents sending draft/files to the wrong thread)
  useEffect(() => {
    setText('');
    setFiles([]);
    setShowEmoji(false);
    setRecording(false);
    setSending(false);
    setDragOver(false);
    setViewOnce(false);
    previewUrls.current.forEach((u) => URL.revokeObjectURL(u));
    previewUrls.current = [];
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    getSocket()?.emit('typing:stop', { conversationId });
    mediaStream.current?.getTracks().forEach((t) => t.stop());
    mediaStream.current = null;
    mediaRecorder.current = null;
    chunks.current = [];

    return () => {
      previewUrls.current.forEach((u) => URL.revokeObjectURL(u));
      previewUrls.current = [];
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      getSocket()?.emit('typing:stop', { conversationId });
      mediaStream.current?.getTracks().forEach((t) => t.stop());
      mediaStream.current = null;
    };
  }, [conversationId]);

  useEffect(() => {
    if (editingMessage) {
      setText(editingMessage.content);
      textareaRef.current?.focus();
    }
  }, [editingMessage]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [text]);

  const emitTyping = () => {
    getSocket()?.emit('typing:start', { conversationId });
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {
      getSocket()?.emit('typing:stop', { conversationId });
    }, 2000);
  };

  const onEmoji = (emoji: EmojiClickData) => {
    setText((t) => t + emoji.emoji);
    setShowEmoji(false);
    textareaRef.current?.focus();
  };

  const addFiles = (list: FileList | File[]) => {
    const arr = Array.from(list).filter((f) => f.size <= 50 * 1024 * 1024);
    if (arr.length < Array.from(list).length) {
      toast.error('Some files exceeded the 50MB limit');
    }
    setFiles((prev) => {
      const next = [...prev, ...arr].slice(0, 10);
      // View once only applies to photo-only attachments
      if (next.some((f) => !f.type.startsWith('image/'))) {
        setViewOnce(false);
      }
      return next;
    });
  };

  const imagesOnly =
    files.length > 0 && files.every((f) => f.type.startsWith('image/'));

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStream.current = stream;
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        mediaStream.current = null;
        const blob = new Blob(chunks.current, { type: 'audio/webm' });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
        setFiles([file]);
        setRecording(false);
      };
      mediaRecorder.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      toast.error('Microphone access denied');
    }
  };

  const stopRecording = () => {
    mediaRecorder.current?.stop();
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (sending) return;
    if (!text.trim() && files.length === 0) return;

    if (editingMessage) {
      setSending(true);
      try {
        const plain = text.trim();
        let wire = plain;
        let isE2E = !!editingMessage.isE2E;
        const conv = useChatStore
          .getState()
          .conversations.find((c) => c.id === conversationId);
        if (plain && conv && user?.id) {
          const enc = await encryptMessageContent(conv, user.id, plain);
          if (enc.error) {
            toast.error(enc.error);
            setSending(false);
            return;
          }
          wire = enc.content;
          isE2E = enc.isE2E;
        }
        const updated = await chatService.editMessage(editingMessage.id, wire, isE2E);
        useChatStore.getState().updateMessage(conversationId, {
          ...updated,
          content: plain,
          isE2E,
        });
        setEditingMessage(null);
        setText('');
      } catch {
        toast.error('Failed to edit');
      } finally {
        setSending(false);
      }
      return;
    }

    if (!user?.id) {
      toast.error('Not signed in');
      return;
    }

    const replySnapshot = replyTo;
    const clientId = `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const plainText = text.trim();
    const optimisticUrls = files.map((f) => URL.createObjectURL(f));

    // Encrypt text + media before anything leaves the device (fail-closed for E2E)
    const conv =
      useChatStore.getState().conversations.find((c) => c.id === conversationId) ||
      null;
    if (!conv) {
      toast.error('Conversation not loaded. Try again.');
      return;
    }

    let wireContent = plainText;
    let isE2E = false;
    let toSend = [...files];
    let e2eMetas: string[] | undefined;
    let mediaTypes: string[] | undefined;
    let activeConv = conv;

    try {
      if (plainText) {
        const enc = await encryptMessageContent(conv, user.id, plainText);
        if (enc.error) {
          toast.error(enc.error);
          return;
        }
        wireContent = enc.content;
        isE2E = enc.isE2E;
        if (enc.conversation) {
          activeConv = enc.conversation;
          useChatStore.getState().upsertConversation({
            id: enc.conversation.id,
            e2eWrappedKeys: enc.conversation.e2eWrappedKeys,
            e2eVersion: enc.conversation.e2eVersion,
            participants: enc.conversation.participants,
          } as typeof enc.conversation);
        }
      }

      // Encrypt attachments — fail-closed when E2E is expected (no plaintext downgrade)
      if (files.length) {
        const mediaEnc = await encryptMediaFiles(activeConv, user.id, files);
        if (!mediaEnc.ok) {
          toast.error(mediaEnc.error);
          return;
        }
        if (mediaEnc.conversation) {
          activeConv = mediaEnc.conversation;
          useChatStore.getState().upsertConversation({
            id: mediaEnc.conversation.id,
            e2eWrappedKeys: mediaEnc.conversation.e2eWrappedKeys,
            e2eVersion: mediaEnc.conversation.e2eVersion,
            participants: mediaEnc.conversation.participants,
          } as typeof mediaEnc.conversation);
        }
        if (mediaEnc.isE2E) {
          toSend = mediaEnc.files;
          e2eMetas = mediaEnc.e2eMetas;
          isE2E = true;
          // mediaTypes are UI hints only — real mime is sealed in e2eMeta
          mediaTypes = files.map((f) => {
            if (f.type.startsWith('image/')) return 'image';
            if (f.type.startsWith('video/')) return 'video';
            if (f.type.startsWith('audio/')) {
              return f.type.includes('webm') || f.type.includes('ogg') ? 'voice' : 'audio';
            }
            return 'document';
          });
        } else if (isE2E) {
          // Text was E2E but media would be plaintext — refuse mixed (fail-closed)
          toast.error(
            'Could not encrypt attachments. Message was not sent in plaintext.'
          );
          return;
        }
      }
    } catch {
      toast.error('Encryption failed. Message was not sent.');
      return;
    }

    const msgType = files.length
      ? files[0].type.startsWith('image/')
        ? ('image' as const)
        : files[0].type.startsWith('video/')
          ? ('video' as const)
          : files[0].type.startsWith('audio/')
            ? ('voice' as const)
            : ('document' as const)
      : ('text' as const);

    const optimistic = {
      id: clientId,
      clientId,
      conversation: conversationId,
      sender: {
        id: user.id,
        displayName: user.displayName,
        username: user.username,
        avatar: user.avatar,
      },
      type: msgType,
      // Local UI shows plaintext; wire may be ciphertext
      content: plainText,
      isE2E,
      attachments: files.map((f, i) => ({
        filename: f.name,
        originalName: f.name,
        mimeType: f.type,
        size: f.size,
        url: optimisticUrls[i],
        // Local blob is plaintext; server attachment will be E2E
        isE2E: false,
      })),
      reactions: [],
      viewOnce: viewOnce && imagesOnly,
      viewOnceOpened: false,
      viewOnceCanOpen: false,
      createdAt: new Date().toISOString(),
      replyTo: replySnapshot || undefined,
    };

    const store = useChatStore.getState();
    store.addMessage(conversationId, optimistic as never);
    setText('');
    const sendViewOnce = viewOnce && imagesOnly;
    setFiles([]);
    setViewOnce(false);
    setReplyTo(null);
    setShowEmoji(false);
    getSocket()?.emit('typing:stop', { conversationId });
    setSending(true);

    try {
      const msg = await chatService.sendMessage(
        conversationId,
        {
          content: wireContent,
          type: optimistic.type,
          replyTo: replySnapshot?.id,
          clientId,
          files: toSend,
          viewOnce: sendViewOnce,
          isE2E,
          e2eMetas,
          mediaTypes,
        },
        (pct) => setUploadProgress(pct)
      );
      // Keep plaintext text in local store; E2E media decrypts on display
      store.addMessage(conversationId, {
        ...msg,
        clientId,
        content: plainText || msg.content,
        isE2E,
      });
    } catch {
      toast.error('Failed to send message');
      useChatStore.getState().removeMessage(conversationId, clientId);
    } finally {
      optimisticUrls.forEach((u) => URL.revokeObjectURL(u));
      setUploadProgress(null);
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div
      className={cn(
        'composer-bar composer-safe shrink-0 px-1.5 pt-2.5 sm:px-2 sm:pt-3',
        dragOver && 'composer-drag-active'
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div className="animate-fade-in pointer-events-none mb-2 rounded-2xl border border-dashed border-pulse-500/40 bg-pulse-500/8 px-3 py-2 text-center text-xs font-semibold tracking-[-0.01em] text-pulse-600 dark:text-pulse-300">
          Drop files to attach
        </div>
      )}

      {recording && (
        <div className="rec-bar mb-2">
          <span className="rec-dot" aria-hidden />
          <span className="text-xs font-semibold tracking-[-0.01em] text-red-600 dark:text-red-400">
            Recording…
          </span>
          <div className="waveform flex-1" aria-hidden>
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <button
            type="button"
            className="pressable rounded-full bg-red-500 px-3 py-1 text-xs font-semibold text-white shadow-md shadow-red-500/25"
            onClick={stopRecording}
          >
            Stop
          </button>
        </div>
      )}
      {(replyTo || editingMessage) && (
        <div className="animate-fade-in mb-2 flex items-center justify-between gap-2 rounded-2xl border border-pulse-500/15 bg-gradient-to-r from-pulse-500/12 to-pulse-500/5 px-3.5 py-2.5 text-sm shadow-sm">
          <div className="min-w-0 border-l-[3px] border-pulse-500 pl-2.5">
            <p className="font-semibold tracking-[-0.01em] text-pulse-600 dark:text-pulse-400">
              {editingMessage ? 'Editing message' : `Replying to ${getSender(replyTo!).displayName}`}
            </p>
            <p className="truncate text-[13px] text-[var(--color-ink-secondary)]">
              {(editingMessage || replyTo)?.content}
            </p>
          </div>
          <button
            type="button"
            aria-label="Cancel"
            className="pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--color-ink-secondary)] hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => {
              setReplyTo(null);
              setEditingMessage(null);
              setText('');
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {files.length > 0 && (
        <div className="mb-2 space-y-2">
          <div className="flex max-w-full flex-wrap gap-2 overflow-x-auto pb-0.5">
            {files.map((f, i) => (
              <div
                key={`${f.name}-${f.size}-${i}`}
                className="attach-preview animate-scale-in relative flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs shadow-sm"
              >
                {f.type.startsWith('image/') ? (
                  <img
                    src={filePreviews[i]}
                    alt=""
                    className={cn(
                      'h-12 w-12 rounded-lg object-cover',
                      viewOnce && imagesOnly && 'ring-2 ring-amber-400/80'
                    )}
                  />
                ) : (
                  <span className="max-w-[140px] truncate px-1 font-medium">📎 {f.name}</span>
                )}
                <button
                  type="button"
                  aria-label="Remove file"
                  onClick={() =>
                    setFiles((prev) => {
                      const next = prev.filter((_, j) => j !== i);
                      if (!next.length || next.some((x) => !x.type.startsWith('image/'))) {
                        setViewOnce(false);
                      }
                      return next;
                    })
                  }
                  className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white shadow-md shadow-red-500/25 transition-transform hover:scale-105"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          {imagesOnly && (
            <button
              type="button"
              onClick={() => setViewOnce((v) => !v)}
              className={cn(
                'pressable inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold tracking-[-0.01em] transition-colors',
                viewOnce
                  ? 'bg-amber-500/15 text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300'
                  : 'bg-black/[0.05] text-[var(--color-ink-secondary)] dark:bg-white/[0.06]'
              )}
              aria-pressed={viewOnce}
            >
              <Timer className="h-3.5 w-3.5" />
              {viewOnce ? 'View once on' : 'View once'}
            </button>
          )}
        </div>
      )}

      {uploadProgress !== null && (
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-black/8 dark:bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-pulse-400 to-pulse-600 transition-[width] duration-200 ease-out"
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
      )}

      <form
        onSubmit={send}
        className="flex min-w-0 items-end gap-0.5 sm:gap-1"
      >
        {/* Tool cluster: compact on desktop so Play isn’t clipped by the pane edge */}
        <div className="composer-tools relative flex shrink-0 items-center gap-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="attach-btn hidden text-[var(--color-ink-secondary)] sm:inline-flex"
            aria-label="Emoji"
            onClick={() => setShowEmoji(!showEmoji)}
          >
            <Smile className="h-5 w-5" />
          </Button>
          {showEmoji && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-20 cursor-default bg-black/20 md:bg-transparent"
                aria-label="Close emoji picker"
                onClick={() => setShowEmoji(false)}
              />
              <div
                className="popover-enter fixed left-2 right-2 z-30 mx-auto max-w-[min(100%,360px)] overflow-hidden rounded-2xl shadow-2xl ring-1 ring-black/5 dark:ring-white/10 sm:absolute sm:bottom-12 sm:left-0 sm:right-auto sm:mx-0"
                style={{
                  bottom: 'calc(var(--composer-bottom, 0px) + 4.5rem)',
                }}
              >
                <Suspense
                  fallback={
                    <div className="flex h-48 items-center justify-center text-sm text-[var(--color-ink-secondary)]">
                      Loading emoji…
                    </div>
                  }
                >
                  <EmojiPicker
                    onEmojiClick={onEmoji}
                    theme={
                      document.documentElement.classList.contains('dark')
                        ? Theme.DARK
                        : Theme.LIGHT
                    }
                    width="100%"
                    height={Math.min(320, (window.visualViewport?.height || window.innerHeight) * 0.4)}
                    lazyLoadEmojis
                  />
                </Suspense>
              </div>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="attach-btn text-[var(--color-ink-secondary)]"
            aria-label="Play a game"
            title="Pulse Play"
            onClick={() => setShowPlay(true)}
          >
            <Gamepad2 className="h-5 w-5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="attach-btn text-[var(--color-ink-secondary)]"
            aria-label="Attach file"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip className="h-5 w-5" />
          </Button>
          {/* Media shortcut only when there is room (paperclip already accepts images) */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="attach-btn hidden text-[var(--color-ink-secondary)] xl:inline-flex"
            aria-label="Attach media"
            onClick={() => {
              if (fileRef.current) {
                fileRef.current.accept = 'image/*,video/*';
                fileRef.current.click();
              }
            }}
          >
            <ImageIcon className="h-5 w-5" />
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
              e.target.accept = '';
            }}
          />
        </div>

        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            className="absolute bottom-2.5 left-2 z-10 flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-ink-secondary)] active:bg-black/5 sm:hidden"
            aria-label="Emoji"
            onClick={() => setShowEmoji(!showEmoji)}
          >
            <Smile className="h-5 w-5" />
          </button>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              emitTyping();
            }}
            onKeyDown={onKeyDown}
            placeholder="Message…"
            rows={1}
            enterKeyHint="send"
            autoComplete="off"
            autoCorrect="on"
            className="composer-field max-h-28 min-h-[44px] w-full resize-none rounded-[22px] py-2.5 pl-10 pr-3.5 text-base leading-5 tracking-[-0.015em] outline-none sm:max-h-32 sm:px-4 sm:py-3 sm:pl-4 sm:text-sm"
          />
        </div>

        {text.trim() || files.length > 0 ? (
          <Button
            type="submit"
            size="icon"
            className="send-btn shrink-0 shadow-lg shadow-pulse-500/30"
            loading={sending}
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            variant={recording ? 'danger' : 'primary'}
            className={cn(
              'send-btn shrink-0',
              recording ? 'shadow-lg shadow-red-500/30' : 'shadow-lg shadow-pulse-500/25'
            )}
            aria-label={recording ? 'Stop recording' : 'Record voice note'}
            onClick={recording ? stopRecording : startRecording}
          >
            {recording ? <Square className="h-4 w-4" /> : <Mic className="h-5 w-5" />}
          </Button>
        )}
      </form>

      <PlayPicker
        conversationId={conversationId}
        open={showPlay}
        onClose={() => setShowPlay(false)}
      />
    </div>
  );
}
