import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { User } from '../models/User';
import { AppError } from '../utils/AppError';
import asyncHandler from '../utils/asyncHandler';
import { fileUrl } from '../middleware/upload';
import { toRelativeMediaPath, deleteStoredUpload } from '../utils/mediaUrl';
import { isUserOnline } from '../socket';

function signMedia(path?: string): string {
  if (!path) return '';
  try {

    const { signUploadPath } = require('../utils/mediaSign') as {
      signUploadPath: (p: string) => string;
    };
    if (String(path).includes('/uploads/')) {
      return signUploadPath(String(path).split('?')[0]);
    }
  } catch {
    /* */
  }
  return path;
}

export const getUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.params.id).select(
    'username email displayName bio avatar coverPhoto identityPublicKey isOnline lastSeen isEmailVerified createdAt settings.privacy'
  );
  if (!user) throw new AppError('User not found', 404);

  const { usersAreContacts, redactUserForViewer } = await import('../utils/privacy');
  const isSelf = String(user._id) === String(req.userId);
  const isContact = isSelf || (await usersAreContacts(req.userId!, user._id.toString()));

  // Only share contact email with people who already share a conversation
  // and only if the user has not hidden their email in privacy settings
  const showEmailPref = user.settings?.privacy?.showEmail !== false;
  const canSeeEmail = isContact && showEmailPref;
  const revealEmail = isSelf || canSeeEmail;

  const redacted = redactUserForViewer(user, { isSelf, isContact });

  res.json({
    success: true,
    data: {
      user: {
        ...redacted,
        avatar: signMedia(String(redacted.avatar || '')),
        coverPhoto: signMedia(String(redacted.coverPhoto || '')),
        email: revealEmail ? user.email : undefined,
        emailHidden: isContact && !showEmailPref && !isSelf,
        isEmailVerified: revealEmail ? user.isEmailVerified : undefined,
        createdAt: user.createdAt,
        // Live presence only when onlineStatus privacy allows
        isOnline: redacted.isOnline
          ? isUserOnline(user._id.toString())
          : false,
      },
    },
  });
});

/** Publish (or replace) this device's E2E identity public key */
export const upsertIdentityKey = asyncHandler(async (req: AuthRequest, res: Response) => {
  const key = String(req.body.identityPublicKey || '').trim();
  if (!key || key.length < 32 || key.length > 2048) {
    throw new AppError('Invalid identity public key', 400, 'INVALID_KEY');
  }
  // Base64-ish SPKI export
  if (!/^[A-Za-z0-9+/_=-]+$/.test(key)) {
    throw new AppError('Invalid identity public key encoding', 400, 'INVALID_KEY');
  }
  const user = await User.findById(req.userId);
  if (!user) throw new AppError('User not found', 404);
  user.identityPublicKey = key;
  await user.save();
  res.json({
    success: true,
    data: { identityPublicKey: user.identityPublicKey },
  });
});

/** Fetch only public key (lightweight, for E2E key exchange) */
export const getIdentityKey = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.params.id).select('identityPublicKey username').lean();
  if (!user) throw new AppError('User not found', 404);
  res.json({
    success: true,
    data: {
      userId: String(user._id),
      identityPublicKey: user.identityPublicKey || '',
    },
  });
});

/**
 * Client-encrypted E2E private key backup.
 * Server stores opaque ciphertext only — never the password or plaintext private key.
 * Restores history after browser origin changes (e.g. tunnel URL rotation).
 */
export const putE2EKeyBackup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const publicKey = String(req.body.publicKey || '').trim();
  const salt = String(req.body.salt || '').trim();
  const iv = String(req.body.iv || '').trim();
  const ciphertext = String(req.body.ciphertext || '').trim();
  const v = Number(req.body.v) || 1;

  if (!publicKey || publicKey.length < 32 || publicKey.length > 2048) {
    throw new AppError('Invalid backup public key', 400, 'INVALID_BACKUP');
  }
  if (!salt || salt.length > 128 || !iv || iv.length > 64) {
    throw new AppError('Invalid backup envelope', 400, 'INVALID_BACKUP');
  }
  if (!ciphertext || ciphertext.length > 8192) {
    throw new AppError('Invalid backup ciphertext', 400, 'INVALID_BACKUP');
  }
  if (!/^[A-Za-z0-9+/_=-]+$/.test(publicKey + salt + iv + ciphertext)) {
    throw new AppError('Invalid backup encoding', 400, 'INVALID_BACKUP');
  }

  const user = await User.findById(req.userId).select('+e2eKeyBackup');
  if (!user) throw new AppError('User not found', 404);

  user.e2eKeyBackup = { v, publicKey, salt, iv, ciphertext };
  // Keep identity public key in sync with the backed-up pair
  user.identityPublicKey = publicKey;
  await user.save();

  res.json({ success: true, data: { saved: true } });
});

export const getE2EKeyBackup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId).select('+e2eKeyBackup identityPublicKey');
  if (!user) throw new AppError('User not found', 404);
  const b = user.e2eKeyBackup;
  if (!b?.ciphertext || !b?.publicKey) {
    res.json({ success: true, data: { backup: null } });
    return;
  }
  res.json({
    success: true,
    data: {
      backup: {
        v: b.v || 1,
        publicKey: b.publicKey,
        salt: b.salt,
        iv: b.iv,
        ciphertext: b.ciphertext,
      },
    },
  });
});

export const updateProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId);
  if (!user) throw new AppError('User not found', 404);

  const { displayName, bio, username } = req.body;

  if (username && username !== user.username) {
    const taken = await User.findOne({ username });
    if (taken) throw new AppError('Username already taken', 409, 'DUPLICATE');
    user.username = username;
  }
  if (displayName !== undefined) user.displayName = displayName;
  if (bio !== undefined) user.bio = bio;

  await user.save();
  res.json({ success: true, data: { user: user.toPublicJSON() } });
});

export const updateSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId);
  if (!user) throw new AppError('User not found', 404);

  if (req.body.theme) user.settings.theme = req.body.theme;
  if (typeof req.body.chatBackground === 'string') {
    user.settings.chatBackground = req.body.chatBackground;
  }
  if (req.body.notifications) {
    user.settings.notifications = {
      ...user.settings.notifications,
      ...req.body.notifications,
    };
  }
  if (req.body.privacy) {
    user.settings.privacy = {
      ...user.settings.privacy,
      ...req.body.privacy,
    };
  }

  await user.save();
  res.json({ success: true, data: { settings: user.settings } });
});

export const uploadAvatar = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');

  const { fileMatchesMime, unlinkQuiet } = await import('../utils/fileMagic');
  const { signUploadPath } = await import('../utils/mediaSign');

  if (!req.file.mimetype.startsWith('image/')) {
    unlinkQuiet(req.file.path);
    throw new AppError('Avatar must be an image', 400, 'INVALID_FILE_TYPE');
  }
  if (!fileMatchesMime(req.file.path, req.file.mimetype)) {
    unlinkQuiet(req.file.path);
    throw new AppError('Avatar file content is invalid', 400, 'INVALID_FILE_CONTENT');
  }
  const { scanUploadedFile } = await import('../utils/malwareScan');
  const { stripImageMetadata } = await import('../utils/imageSanitize');
  const { recordSecurityEvent } = await import('../utils/securityEvents');
  const scan = await scanUploadedFile(req.file.path);
  if (!scan.clean) {
    unlinkQuiet(req.file.path);
    recordSecurityEvent('malware_blocked', {
      userId: req.userId,
      ip: req.ip,
      meta: { reason: scan.reason || 'flagged', kind: 'avatar' },
    });
    throw new AppError(scan.reason || 'File failed security scan', 400, 'MALWARE_BLOCKED');
  }
  stripImageMetadata(req.file.path, req.file.mimetype);

  const user = await User.findById(req.userId);
  if (!user) throw new AppError('User not found', 404);

  // Store relative path only — survives ngrok domain changes on restart
  const previousAvatar = user.avatar;
  user.avatar = toRelativeMediaPath(fileUrl(req.file.filename, req.file.mimetype));
  await user.save();
  // Reclaim the replaced file; every avatar change used to orphan one on disk
  if (previousAvatar && previousAvatar !== user.avatar) {
    deleteStoredUpload(previousAvatar);
  }

  const publicUser = user.toPublicJSON();
  if (typeof publicUser.avatar === 'string') {
    publicUser.avatar = signUploadPath(String(publicUser.avatar).split('?')[0]);
  }

  res.json({
    success: true,
    data: {
      avatar: signUploadPath(user.avatar),
      user: publicUser,
    },
  });
});

export const uploadCoverPhoto = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');

  const { fileMatchesMime, unlinkQuiet } = await import('../utils/fileMagic');
  const { signUploadPath } = await import('../utils/mediaSign');

  if (!req.file.mimetype.startsWith('image/')) {
    unlinkQuiet(req.file.path);
    throw new AppError('Cover photo must be an image', 400, 'INVALID_FILE_TYPE');
  }
  if (!fileMatchesMime(req.file.path, req.file.mimetype)) {
    unlinkQuiet(req.file.path);
    throw new AppError('Cover file content is invalid', 400, 'INVALID_FILE_CONTENT');
  }
  {
    const { scanUploadedFile } = await import('../utils/malwareScan');
    const { stripImageMetadata } = await import('../utils/imageSanitize');
    const { recordSecurityEvent } = await import('../utils/securityEvents');
    const scan = await scanUploadedFile(req.file.path);
    if (!scan.clean) {
      unlinkQuiet(req.file.path);
      recordSecurityEvent('malware_blocked', {
        userId: req.userId,
        ip: req.ip,
        meta: { reason: scan.reason || 'flagged', kind: 'cover' },
      });
      throw new AppError(scan.reason || 'File failed security scan', 400, 'MALWARE_BLOCKED');
    }
    stripImageMetadata(req.file.path, req.file.mimetype);
  }

  const user = await User.findById(req.userId);
  if (!user) throw new AppError('User not found', 404);

  const previousCover = user.coverPhoto;
  user.coverPhoto = toRelativeMediaPath(fileUrl(req.file.filename, req.file.mimetype));
  await user.save();
  if (previousCover && previousCover !== user.coverPhoto) {
    deleteStoredUpload(previousCover);
  }

  const publicUser = user.toPublicJSON();

  res.json({
    success: true,
    data: {
      coverPhoto: signUploadPath(user.coverPhoto),
      user: publicUser,
    },
  });
});

export const removeCoverPhoto = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId);
  if (!user) throw new AppError('User not found', 404);
  const previousCover = user.coverPhoto;
  user.coverPhoto = '';
  await user.save();
  if (previousCover) deleteStoredUpload(previousCover);
  res.json({
    success: true,
    data: { user: user.toPublicJSON() },
  });
});

export const searchUsers = asyncHandler(async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 50);

  if (!q) {
    res.json({ success: true, data: { users: [] } });
    return;
  }

  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 64);
  // Never search by email (enumeration risk)
  const users = await User.find({
    _id: { $ne: req.userId },
    $or: [
      { username: { $regex: safe, $options: 'i' } },
      { displayName: { $regex: safe, $options: 'i' } },
    ],
  })
    .limit(limit)
    .select(
      'username displayName avatar bio isOnline lastSeen identityPublicKey settings.privacy'
    )
    .lean();

  const { redactUserForViewer, usersAreContacts } = await import('../utils/privacy');
  // Contact check is expensive if done per row — batch via shared conversations
  const ids = users.map((u) => String(u._id));
  const contactSet = new Set<string>();
  if (ids.length) {
    const { Conversation } = await import('../models/Conversation');
    const shared = await Conversation.find({
      isActive: true,
      'participants.user': req.userId,
      participants: { $elemMatch: { user: { $in: ids } } },
    })
      .select('participants.user')
      .lean();
    for (const c of shared) {
      for (const p of c.participants || []) {
        const pid = String(p.user);
        if (pid !== req.userId) contactSet.add(pid);
      }
    }
  }
  void usersAreContacts; // reserved for single-user helpers

  res.json({
    success: true,
    data: {
      users: users.map((u) => {
        const id = String(u._id);
        const redacted = redactUserForViewer(
          {
            id,
            username: u.username,
            displayName: u.displayName,
            avatar: u.avatar,
            bio: u.bio,
            identityPublicKey: u.identityPublicKey,
            isOnline: u.isOnline,
            lastSeen: u.lastSeen,
            settings: u.settings as { privacy?: Record<string, unknown> } | undefined,
          } as Parameters<typeof redactUserForViewer>[0],
          { isSelf: false, isContact: contactSet.has(id) }
        );
        return {
          id,
          username: u.username,
          displayName: u.displayName,
          avatar: signMedia(String(redacted.avatar || '')),
          bio: u.bio,
          identityPublicKey: u.identityPublicKey || '',
          isOnline: redacted.isOnline ? isUserOnline(id) : false,
          lastSeen: redacted.lastSeen,
          profilePhotoHidden: redacted.profilePhotoHidden,
          lastSeenHidden: redacted.lastSeenHidden,
        };
      }),
    },
  });
});

export const changePassword = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body;
  const { validatePasswordStrength } = await import('../utils/passwordPolicy');
  const { recordSecurityEvent } = await import('../utils/securityEvents');

  const pw = validatePasswordStrength(newPassword);
  if (!pw.ok) {
    throw new AppError(pw.errors[0] || 'Weak password', 400, 'WEAK_PASSWORD');
  }

  const user = await User.findById(req.userId).select('+password');
  if (!user) throw new AppError('User not found', 404);

  if (!(await user.comparePassword(currentPassword))) {
    throw new AppError('Current password is incorrect', 400, 'INVALID_PASSWORD');
  }

  user.password = newPassword;
  await user.save();

  recordSecurityEvent('password_changed', { userId: req.userId, ip: req.ip });

  // Revoke other sessions; keep current if available
  const { Session } = await import('../models/Session');
  const filter: Record<string, unknown> = { user: req.userId, isValid: true };
  if (req.sessionId) filter._id = { $ne: req.sessionId };
  await Session.updateMany(filter, { isValid: false });

  // Disconnect sockets for revoked sessions (other devices)
  try {
    const { getIO } = await import('../socket');
    const io = getIO();
    const sockets = await io.in(`user:${req.userId}`).fetchSockets();
    for (const s of sockets) {
      const sid =
        (s.data as { sessionId?: string })?.sessionId ||
        (s as unknown as { sessionId?: string }).sessionId;
      if (sid && sid !== req.sessionId) s.disconnect(true);
    }
  } catch {
    /* */
  }

  res.json({ success: true, data: { message: 'Password changed' } });
});

export const getStarredMessages = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { Message } = await import('../models/Message');
  const { Conversation } = await import('../models/Conversation');
  const { formatMessage } = await import('../utils/messageFormat');

  const user = await User.findById(req.userId).select('starredMessages');
  if (!user) throw new AppError('User not found', 404);

  const starIds = user.starredMessages || [];
  if (starIds.length === 0) {
    res.json({ success: true, data: { messages: [] } });
    return;
  }

  const messages = await Message.find({
    _id: { $in: starIds },
    isDeleted: false,
    deletedFor: { $ne: req.userId },
  })
    .populate([
      { path: 'sender', select: 'username displayName avatar' },
      { path: 'replyTo', populate: { path: 'sender', select: 'username displayName avatar' } },
    ])
    .lean({ virtuals: true });

  // Preserve user star order (most recently starred last → reverse for newest first)
  const byId = new Map(messages.map((m) => [m._id.toString(), m]));
  const ordered = [...starIds]
    .map((id) => byId.get(id.toString()))
    .filter(Boolean)
    .reverse();

  const convIds = [
    ...new Set(ordered.map((m) => String((m as { conversation: unknown }).conversation))),
  ];
  const convs = await Conversation.find({
    _id: { $in: convIds },
    'participants.user': req.userId,
    isActive: true,
  })
    .select('_id name type participants')
    .populate({ path: 'participants.user', select: 'username displayName' })
    .lean();

  const allowed = new Set(convs.map((c) => c._id.toString()));
  const chatNameById = new Map<string, string>();
  for (const c of convs) {
    const id = c._id.toString();
    if (c.type === 'group' && c.name) {
      chatNameById.set(id, c.name);
      continue;
    }
    const other = (c.participants || []).find((p) => {
      const raw = p.user as unknown;
      if (raw && typeof raw === 'object' && '_id' in (raw as object)) {
        return String((raw as { _id: { toString(): string } })._id) !== req.userId;
      }
      return String(raw) !== req.userId;
    });
    const ou = other?.user as unknown as { displayName?: string; username?: string } | undefined;
    chatNameById.set(id, ou?.displayName || ou?.username || 'Chat');
  }

  res.json({
    success: true,
    data: {
      messages: ordered
        .filter((m) => allowed.has(String((m as { conversation: unknown }).conversation)))
        .map((m) => {
          const formatted = formatMessage(m as never) as Record<string, unknown>;
          const convId = String(formatted.conversation || '');
          return {
            ...formatted,
            chatName: chatNameById.get(convId) || 'Chat',
          };
        }),
    },
  });
});
