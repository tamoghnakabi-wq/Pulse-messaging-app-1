/**
 * Privacy field redaction based on user settings.
 * Backward compatible: missing settings default to "everyone".
 */
import { Types } from 'mongoose';
import type { IUser } from '../models/User';

export type PrivacyAudience = 'everyone' | 'contacts' | 'nobody';

export function canSee(
  audience: PrivacyAudience | undefined,
  opts: { isSelf: boolean; isContact: boolean }
): boolean {
  if (opts.isSelf) return true;
  const a = audience || 'everyone';
  if (a === 'nobody') return false;
  if (a === 'contacts') return opts.isContact;
  return true;
}

/** Shared direct/group conversation ⇒ treat as contact for privacy audience checks */
export async function usersAreContacts(a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  if (!Types.ObjectId.isValid(a) || !Types.ObjectId.isValid(b)) return false;
  const { Conversation } = await import('../models/Conversation');
  const shared = await Conversation.exists({
    isActive: true,
    'participants.user': { $all: [a, b] },
  });
  return Boolean(shared);
}

export function redactUserForViewer(
  target: Partial<IUser> & {
    id?: string;
    _id?: { toString(): string };
    settings?: IUser['settings'];
    avatar?: string;
    coverPhoto?: string;
    isOnline?: boolean;
    lastSeen?: Date | string;
    identityPublicKey?: string;
  },
  opts: { isSelf: boolean; isContact: boolean }
): Record<string, unknown> {
  const privacy = target.settings?.privacy || {
    lastSeen: 'everyone' as const,
    readReceipts: true,
    profilePhoto: 'everyone' as const,
    showEmail: true,
    onlineStatus: 'everyone' as const,
  };

  const showPhoto = canSee(privacy.profilePhoto as PrivacyAudience, opts);
  const showLastSeen = canSee(
    (privacy.lastSeen || 'everyone') as PrivacyAudience,
    opts
  );
  const showOnline = canSee(
    ((privacy as { onlineStatus?: PrivacyAudience }).onlineStatus ||
      privacy.lastSeen ||
      'everyone') as PrivacyAudience,
    opts
  );

  const id =
    target.id ||
    (target._id && typeof target._id.toString === 'function'
      ? target._id.toString()
      : String(target._id || ''));

  return {
    id,
    username: target.username,
    displayName: target.displayName,
    bio: target.bio ?? '',
    avatar: showPhoto ? target.avatar || '' : '',
    coverPhoto: showPhoto ? target.coverPhoto || '' : '',
    identityPublicKey: target.identityPublicKey || '',
    isOnline: showOnline ? !!target.isOnline : false,
    lastSeen: showLastSeen ? target.lastSeen : undefined,
    lastSeenHidden: !showLastSeen && !opts.isSelf,
    profilePhotoHidden: !showPhoto && !opts.isSelf,
  };
}
