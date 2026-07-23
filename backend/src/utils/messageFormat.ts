import { Types } from 'mongoose';
import type { IMessage } from '../models/Message';
import { signMediaFields, signUploadPath } from './mediaSign';

/** Public message DTO fields commonly consumed by clients. */
export type FormattedMessage = Record<string, unknown> & {
  id: string;
  conversation: string;
  sender: Record<string, unknown> | string;
  attachments: unknown[];
};

export interface FormatMessageOptions {
  /** Current viewer — used to enforce view-once media privacy */
  viewerId?: string;
  /**
   * When true, include signed media URLs even for locked view-once (open endpoint only).
   */
  includeViewOnceMedia?: boolean;
}

function senderIdOf(sender: unknown): string {
  return idString(sender);
}

/** Stable string id from ObjectId / populated ref / string (never use ObjectId.id — it's a Buffer). */
function idString(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Types.ObjectId) return value.toString();
  if (typeof value === 'object') {
    const o = value as {
      _id?: unknown;
      id?: unknown;
      toHexString?: () => string;
      toString?: () => string;
    };
    // Plain DTO / lean user: { id: 'hex...' } — must be string (ObjectId.id is a Buffer)
    if (typeof o.id === 'string' && o.id.length > 0) return o.id;
    if (typeof o.toHexString === 'function') {
      try {
        return o.toHexString();
      } catch {
        /* fall through */
      }
    }
    if (o._id != null && o._id !== value) return idString(o._id);
    if (typeof o.toString === 'function') {
      const s = o.toString();
      // ObjectId#toString → 24-char hex; skip useless Object.prototype toString
      if (s && s !== '[object Object]' && s !== '[object BSON]') return s;
    }
  }
  return '';
}

function viewedByIds(raw: Record<string, unknown>): string[] {
  const list = raw.viewOnceViewedBy;
  if (!Array.isArray(list)) return [];
  return list.map((v) => idString(v)).filter(Boolean);
}

/** Normalize populated / raw refs to a stable public message shape. */
export function formatMessage(
  msg: IMessage | Record<string, unknown>,
  opts: FormatMessageOptions = {}
): FormattedMessage {
  const raw =
    typeof (msg as IMessage).toObject === 'function'
      ? (msg as IMessage).toObject({ virtuals: true })
      : { ...(msg as Record<string, unknown>) };

  const id =
    (raw as { _id?: Types.ObjectId | string })._id?.toString?.() ||
    (raw as { id?: string }).id ||
    '';

  const conversation = refToId((raw as { conversation?: unknown }).conversation);
  const sender = formatUserRef((raw as { sender?: unknown }).sender);
  const senderId = senderIdOf(sender) || senderIdOf((raw as { sender?: unknown }).sender);

  let replyTo = (raw as { replyTo?: unknown }).replyTo;
  if (replyTo && typeof replyTo === 'object') {
    replyTo = formatMessage(replyTo as Record<string, unknown>, opts);
  } else if (replyTo) {
    replyTo = String(replyTo);
  }

  const viewOnce = !!(raw as { viewOnce?: boolean }).viewOnce;
  const viewed = viewedByIds(raw as Record<string, unknown>);
  const viewerId = idString(opts.viewerId || '');
  const isSender = !!viewerId && viewerId === senderId;
  const viewerOpened = !!viewerId && viewed.some((id) => id === viewerId);
  const anyoneOpened = viewed.length > 0;

  // View-once privacy:
  // - Broadcast (no viewerId) and non-senders never get media URLs from list/history
  // - Recipients open via dedicated endpoint (includeViewOnceMedia)
  // - Sender keeps media in their own history
  const lockMediaForViewer =
    viewOnce && !opts.includeViewOnceMedia && !isSender;

  // Sign media URLs for authorized delivery (DB still stores plain paths)
  let attachments = (raw as { attachments?: unknown[] }).attachments;
  if (Array.isArray(attachments)) {
    if (lockMediaForViewer) {
      // Keep mime/size metadata for UI placeholders; strip URLs
      attachments = attachments.map((a) => {
        if (!a || typeof a !== 'object') return a;
        const att = { ...(a as Record<string, unknown>) };
        delete att.url;
        delete att.thumbnailUrl;
        return {
          ...att,
          viewOnceLocked: true,
        };
      });
    } else {
      attachments = attachments.map((a) => {
        if (!a || typeof a !== 'object') return a;
        const att = { ...(a as Record<string, unknown>) };
        if (typeof att.url === 'string') att.url = signUploadPath(String(att.url).split('?')[0]);
        if (typeof att.thumbnailUrl === 'string') {
          att.thumbnailUrl = signUploadPath(String(att.thumbnailUrl).split('?')[0]);
        }
        return att;
      });
    }
  }

  // Viewer-specific hints (clients should prefer computing from viewOnceViewedBy + local user id,
  // especially for socket broadcasts shared with every participant).
  const viewOnceOpened = isSender ? anyoneOpened : viewerOpened;
  // Only claim "can open" when we know the viewer identity and they haven't opened yet.
  // Broadcasts (no viewerId) leave this undefined so the client decides per user.
  const viewOnceCanOpen =
    viewOnce && !!viewerId && !isSender && !viewerOpened
      ? true
      : viewOnce && !!viewerId
        ? false
        : undefined;

  const gameIdRaw = (raw as { gameId?: unknown }).gameId;
  const gameId = gameIdRaw ? idString(gameIdRaw) : undefined;
  const pollIdRaw = (raw as { pollId?: unknown }).pollId;
  const pollId = pollIdRaw ? idString(pollIdRaw) : undefined;

  const formatted = {
    ...raw,
    id,
    _id: undefined,
    conversation,
    sender,
    replyTo: replyTo || undefined,
    attachments: attachments || [],
    gameId: gameId || undefined,
    pollId: pollId || undefined,
    viewOnce,
    viewOnceOpened: viewerId ? viewOnceOpened : anyoneOpened,
    // Explicit undefined when unknown — do not default recipients to "opened"
    ...(viewOnceCanOpen === undefined ? {} : { viewOnceCanOpen }),
    viewOnceViewedBy: viewed,
    mentions: Array.isArray((raw as { mentions?: unknown[] }).mentions)
      ? (raw as { mentions: unknown[] }).mentions.map((m) =>
          typeof m === 'object' && m ? formatUserRef(m) : String(m)
        )
      : [],
  };

  return signMediaFields(formatted as Record<string, unknown>) as FormattedMessage;
}

function refToId(ref: unknown): string {
  if (!ref) return '';
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'object' && ref !== null) {
    const o = ref as { _id?: { toString(): string }; id?: string; toString?: () => string };
    if (o._id) return o._id.toString();
    if (o.id) return o.id;
  }
  return String(ref);
}

function formatUserRef(ref: unknown): Record<string, unknown> | string {
  if (!ref) return '';
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'object' && ref !== null) {
    const u = ref as {
      _id?: { toString(): string };
      id?: string;
      username?: string;
      displayName?: string;
      avatar?: string;
    };
    if (u.username || u.displayName || u.avatar) {
      const avatar =
        typeof u.avatar === 'string' && u.avatar.includes('/uploads/')
          ? signUploadPath(String(u.avatar).split('?')[0])
          : u.avatar;
      return {
        id: u.id || u._id?.toString() || '',
        username: u.username,
        displayName: u.displayName,
        avatar,
      };
    }
    return u._id?.toString() || u.id || '';
  }
  return String(ref);
}

export function participantUserId(p: { user: unknown }): string {
  const u = p.user as { _id?: { toString(): string }; id?: string; toString?: () => string };
  if (u && typeof u === 'object') {
    if (u._id) return u._id.toString();
    if (u.id) return u.id;
  }
  return String(p.user);
}
