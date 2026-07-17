import { Types } from 'mongoose';
import { Conversation } from '../../models/Conversation';
import { isUserOnline } from '../../socket/presence';
import { formatMessage } from '../../utils/messageFormat';
import { signMediaFields, signUploadPath } from '../../utils/mediaSign';

/** Mongoose populate paths for conversation list/detail responses. */
export function conversationPopulatePaths() {
  return [
    {
      path: 'participants.user',
      select:
        'username displayName avatar isOnline lastSeen bio identityPublicKey settings.privacy',
    },
    {
      path: 'lastMessage',
      // Lean preview fields only — never pull full reaction/readBy arrays into chat list
      select: 'content type sender createdAt isDeleted attachments isE2E',
      populate: { path: 'sender', select: 'username displayName avatar' },
    },
  ];
}

type PopulatedUserLike = {
  _id?: Types.ObjectId | { toString(): string };
  id?: string;
  username?: string;
  displayName?: string;
  avatar?: string;
  isOnline?: boolean;
  lastSeen?: Date;
  bio?: string;
  identityPublicKey?: string;
  settings?: {
    privacy?: {
      lastSeen?: string;
      profilePhoto?: string;
      onlineStatus?: string;
      readReceipts?: boolean;
    };
  };
  toString?: () => string;
};

function canSeePrivacy(
  audience: string | undefined,
  isSelf: boolean
): boolean {
  if (isSelf) return true;
  const a = audience || 'everyone';
  if (a === 'nobody') return false;
  // Shared conversation ⇒ contact
  if (a === 'contacts' || a === 'everyone') return true;
  return true;
}

function signAvatar(avatar?: string): string {
  if (avatar && String(avatar).includes('/uploads/')) {
    return signUploadPath(String(avatar).split('?')[0]);
  }
  return avatar || '';
}

function resolveUserId(u: PopulatedUserLike | string | unknown): string {
  if (!u) return '';
  if (typeof u === 'string') return u;
  const user = u as PopulatedUserLike;
  return (
    user.id ||
    user._id?.toString?.() ||
    (typeof user.toString === 'function' && user.toString() !== '[object Object]'
      ? user.toString()
      : '') ||
    String(user)
  );
}

/**
 * Public conversation DTO for API clients.
 * Prefer live socket presence over DB flags for direct chats.
 */
export function formatConversation(
  conv: InstanceType<typeof Conversation> | Record<string, unknown>,
  userId: string
) {
  const c = conv as InstanceType<typeof Conversation>;
  const me = c.participants.find(
    (p) => p.user._id?.toString() === userId || p.user.toString() === userId
  );
  const others = c.participants.filter(
    (p) =>
      (p.user as { _id?: Types.ObjectId })._id?.toString() !== userId &&
      p.user.toString() !== userId
  );

  let displayName = c.name || '';
  let avatar = c.avatar || '';
  let isOnline = false;
  let lastSeen: Date | undefined;

  if (c.type === 'direct' && others[0]) {
    const otherUser = others[0].user as unknown as PopulatedUserLike;
    displayName = otherUser.displayName || otherUser.username || 'User';
    avatar = otherUser.avatar || '';
    const otherId = resolveUserId(otherUser) || String(others[0].user);
    isOnline = isUserOnline(otherId);
    lastSeen = otherUser.lastSeen;
  }

  let lastMessage: unknown = c.lastMessage as unknown;
  if (lastMessage && typeof lastMessage === 'object') {
    lastMessage = formatMessage(lastMessage as Record<string, unknown>);
  }

  return signMediaFields({
    id: c._id.toString(),
    type: c.type,
    name: c.name,
    displayName,
    description: c.description,
    avatar: signAvatar(avatar),
    isOnline,
    lastSeen,
    participants: c.participants.map((p) => {
      const u = p.user as unknown as PopulatedUserLike;
      const uid = resolveUserId(u);
      return {
        user: (() => {
          const isSelf = uid === userId;
          const priv = u.settings?.privacy || {};
          const showPhoto = canSeePrivacy(priv.profilePhoto, isSelf);
          const showLast = canSeePrivacy(priv.lastSeen, isSelf);
          const showOnline = canSeePrivacy(priv.onlineStatus || priv.lastSeen, isSelf);
          return {
            id: uid,
            username: u.username,
            displayName: u.displayName,
            avatar: showPhoto ? signAvatar(u.avatar) : '',
            isOnline: showOnline ? isUserOnline(uid) : false,
            lastSeen: showLast ? u.lastSeen : undefined,
            bio: u.bio,
            identityPublicKey: u.identityPublicKey || '',
            profilePhotoHidden: !showPhoto && !isSelf,
            lastSeenHidden: !showLast && !isSelf,
          };
        })(),
        role: p.role,
        joinedAt: p.joinedAt,
        lastReadAt: p.lastReadAt,
        isMuted: p.isMuted,
        isPinned: p.isPinned,
        isArchived: p.isArchived,
        isFavorite: p.isFavorite,
      };
    }),
    lastMessage,
    lastMessageAt: c.lastMessageAt,
    pinnedMessages: c.pinnedMessages,
    e2eVersion: (c as { e2eVersion?: number }).e2eVersion || 0,
    e2eWrappedKeys: Array.isArray((c as { e2eWrappedKeys?: unknown[] }).e2eWrappedKeys)
      ? (
          (c as { e2eWrappedKeys: { userId?: unknown; wrappedKey?: string }[] }).e2eWrappedKeys ||
          []
        ).map((k) => ({
          userId: String(
            (k.userId as { toString?: () => string })?.toString?.() || k.userId || ''
          ),
          wrappedKey: k.wrappedKey || '',
        }))
      : [],
    inviteCode:
      me && (me.role === 'owner' || me.role === 'admin') ? c.inviteCode : undefined,
    myPrefs: me
      ? {
          isPinned: me.isPinned,
          isArchived: me.isArchived,
          isFavorite: me.isFavorite,
          isMuted: me.isMuted,
          role: me.role,
          lastReadAt: me.lastReadAt,
        }
      : null,
    unreadCount: Math.max(0, me?.unreadCount || 0),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
}
