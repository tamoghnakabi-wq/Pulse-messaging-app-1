/**
 * Decrypt and render a single E2E media attachment on-device.
 * Server only holds ciphertext; plaintext never leaves this component's blob URLs.
 */
import { useEffect, useState } from 'react';
import { Loader2, Lock, AlertTriangle } from 'lucide-react';
import type { Attachment, Conversation } from '@/shared/types';
import { decryptMediaAttachment, isE2EMediaMeta } from '@/services/e2e';
import { mediaUrl } from '@/utils/mediaUrl';
import { formatFileSize } from '@/utils/format';
import { cn } from '@/utils/cn';

type Status = 'idle' | 'loading' | 'ready' | 'error' | 'locked';

interface Props {
  attachment: Attachment;
  conversation: Conversation | null | undefined;
  myId: string;
  isMine?: boolean;
  messageType?: string;
  onOpenImage?: (url: string, name?: string) => void;
}

interface DecryptedEntry {
  objectUrl: string;
  mimeType: string;
  originalName: string;
  size: number;
}

/**
 * LRU cache of decrypted object URLs (session only).
 *
 * Object URLs pin their Blob in memory until revoked. An unbounded cache meant
 * every photo/video ever scrolled past stayed resident for the life of the tab —
 * a media-heavy chat could grow to hundreds of MB and crash mobile Safari.
 * Evicted entries are revoked so the underlying Blob can be collected.
 */
const MAX_CACHED_MEDIA = 60;
const decryptCache = new Map<string, DecryptedEntry>();

function cacheKey(url: string, e2eMeta: string): string {
  return `${url.split('?')[0]}::${e2eMeta.slice(0, 64)}`;
}

/** Read through the LRU, refreshing recency on hit. */
function cacheGet(key: string): DecryptedEntry | undefined {
  const hit = decryptCache.get(key);
  if (!hit) return undefined;
  decryptCache.delete(key);
  decryptCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, entry: DecryptedEntry): void {
  decryptCache.set(key, entry);
  while (decryptCache.size > MAX_CACHED_MEDIA) {
    const oldestKey = decryptCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const evicted = decryptCache.get(oldestKey);
    decryptCache.delete(oldestKey);
    if (evicted) {
      try {
        URL.revokeObjectURL(evicted.objectUrl);
      } catch {
        /* already revoked */
      }
    }
  }
}

/** Drop every decrypted blob (called on logout — plaintext must not outlive the session). */
export function clearDecryptedMediaCache(): void {
  for (const entry of decryptCache.values()) {
    try {
      URL.revokeObjectURL(entry.objectUrl);
    } catch {
      /* */
    }
  }
  decryptCache.clear();
}

export function E2EMediaAttachment({
  attachment,
  conversation,
  myId,
  isMine,
  messageType,
  onOpenImage,
}: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [displayMime, setDisplayMime] = useState(attachment.mimeType || '');
  const [displayName, setDisplayName] = useState(attachment.originalName || 'file');
  const [displaySize, setDisplaySize] = useState(attachment.size || 0);

  const e2eMeta = attachment.e2eMeta || '';
  const src = mediaUrl(attachment.url) || attachment.url;
  const mediaClass =
    (attachment as Attachment & { mediaClass?: string }).mediaClass ||
    (displayMime.startsWith('image/')
      ? 'image'
      : displayMime.startsWith('video/')
        ? 'video'
        : displayMime.startsWith('audio/')
          ? 'audio'
          : messageType === 'voice'
            ? 'voice'
            : messageType === 'image'
              ? 'image'
              : messageType === 'video'
                ? 'video'
                : messageType === 'audio'
                  ? 'audio'
                  : 'document');

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!src || !isE2EMediaMeta(e2eMeta)) {
        setStatus('error');
        return;
      }
      if (!conversation || !myId) {
        setStatus('locked');
        return;
      }

      const key = cacheKey(src, e2eMeta);
      const cached = cacheGet(key);
      if (cached) {
        if (!cancelled) {
          setObjectUrl(cached.objectUrl);
          setDisplayMime(cached.mimeType);
          setDisplayName(cached.originalName);
          setDisplaySize(cached.size);
          setStatus('ready');
        }
        return;
      }

      setStatus('loading');
      try {
        const res = await fetch(src, { credentials: 'include' });
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const buf = await res.arrayBuffer();
        const dec = await decryptMediaAttachment(conversation, myId, buf, e2eMeta);
        if (!dec) {
          if (!cancelled) setStatus('locked');
          return;
        }
        const url = URL.createObjectURL(dec.blob);
        cacheSet(key, {
          objectUrl: url,
          mimeType: dec.mimeType,
          originalName: dec.originalName,
          size: dec.size,
        });
        // Kept alive by the LRU (not revoked here) so re-renders and scroll-back
        // reuse the same URL instead of re-fetching and re-decrypting.
        if (!cancelled) {
          setObjectUrl(url);
          setDisplayMime(dec.mimeType);
          setDisplayName(dec.originalName);
          setDisplaySize(dec.size);
          setStatus('ready');
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [src, e2eMeta, conversation, myId]);

  if (status === 'loading' || status === 'idle') {
    return (
      <div
        className={cn(
          'mb-1.5 flex min-h-[5rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl px-4 py-6',
          isMine ? 'bg-white/10' : 'bg-black/[0.05] dark:bg-white/[0.06]'
        )}
      >
        <Loader2 className="h-5 w-5 animate-spin opacity-60" />
        <span className="text-xs opacity-60">Decrypting…</span>
      </div>
    );
  }

  if (status === 'locked') {
    return (
      <div
        className={cn(
          'mb-1.5 flex min-h-[4.5rem] min-w-[10rem] flex-col items-center justify-center gap-1.5 rounded-xl px-4 py-5',
          isMine ? 'bg-white/10' : 'bg-black/[0.05] dark:bg-white/[0.06]'
        )}
      >
        <Lock className="h-5 w-5 opacity-50" />
        <span className="text-xs opacity-55">Encrypted attachment</span>
      </div>
    );
  }

  if (status === 'error' || !objectUrl) {
    return (
      <div
        className={cn(
          'mb-1.5 flex min-h-[4.5rem] min-w-[10rem] flex-col items-center justify-center gap-1.5 rounded-xl px-4 py-5',
          isMine ? 'bg-white/10' : 'bg-black/[0.05] dark:bg-white/[0.06]'
        )}
      >
        <AlertTriangle className="h-5 w-5 text-amber-500/80" />
        <span className="text-xs opacity-55">Could not decrypt media</span>
      </div>
    );
  }

  const isImage = mediaClass === 'image' || displayMime.startsWith('image/');
  const isVideo = mediaClass === 'video' || displayMime.startsWith('video/');
  const isAudio =
    mediaClass === 'audio' ||
    mediaClass === 'voice' ||
    displayMime.startsWith('audio/') ||
    messageType === 'voice';

  if (isImage) {
    return (
      <button
        type="button"
        onClick={() => onOpenImage?.(objectUrl, displayName)}
        className="media-skeleton mb-1.5 block max-w-full overflow-hidden rounded-xl text-left ring-1 ring-black/5 dark:ring-white/10"
        aria-label={`Open photo ${displayName}`.trim()}
      >
        <img
          src={objectUrl}
          alt={displayName}
          className="media-img media-img-ready max-h-72 max-w-full rounded-xl object-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      </button>
    );
  }

  if (isVideo) {
    return (
      <div className="mb-1.5 overflow-hidden rounded-xl ring-1 ring-black/10 dark:ring-white/10">
        <video
          src={objectUrl}
          controls
          playsInline
          preload="metadata"
          className="max-h-72 max-w-full bg-black"
        />
      </div>
    );
  }

  if (isAudio) {
    return (
      <div
        className={cn(
          'mb-1.5 min-w-[12rem] rounded-2xl px-2.5 py-2',
          isMine ? 'bg-white/15' : 'bg-black/[0.06] dark:bg-white/[0.06]'
        )}
      >
        <audio src={objectUrl} controls preload="metadata" className="w-full max-w-[16rem]" />
      </div>
    );
  }

  return (
    <a
      href={objectUrl}
      download={displayName}
      className={cn(
        'mb-1.5 flex min-h-11 items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors',
        isMine
          ? 'bg-white/15 hover:bg-white/20'
          : 'bg-black/5 hover:bg-black/[0.07] dark:bg-white/5 dark:hover:bg-white/[0.08]'
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-black/10 text-base dark:bg-white/10">
        🔒
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium tracking-[-0.01em]">{displayName}</p>
        <p className="text-[11px] opacity-65">{formatFileSize(displaySize)} · encrypted</p>
      </div>
    </a>
  );
}

/** True when attachment should go through client decrypt path. */
export function isE2EAttachment(att: Attachment): boolean {
  // Trust opaque envelope over flags (flag may lag; meta is authoritative)
  if (isE2EMediaMeta(att.e2eMeta)) return true;
  return !!(att.isE2E && att.mimeType === 'application/octet-stream' && att.e2eMeta);
}
