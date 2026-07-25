import { Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth';
import { Conversation, directConversationKey } from '../models/Conversation';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { AppError } from '../utils/AppError';
import asyncHandler from '../utils/asyncHandler';
import { generateRandomToken } from '../utils/tokens';
import { fileUrl } from '../middleware/upload';
import { getIO } from '../socket';
import { toRelativeMediaPath, deleteStoredUpload } from '../utils/mediaUrl';
import {
  formatConversation,
  conversationPopulatePaths,
} from '../services/conversation/conversationFormat.service';

/** Participants live in the conversation document; keep it far from the 16 MB cap. */
const MAX_GROUP_PARTICIPANTS = 256;

export const listConversations = asyncHandler(async (req: AuthRequest, res: Response) => {
  const filter = String(req.query.filter || 'all');
  // Cap chat list size for pathological users; cursor pagination can be added later
  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 500);

  // Exclude chats the user has "deleted for me" (soft-hide)
  const conversations = await Conversation.find({
    isActive: true,
    participants: {
      $elemMatch: {
        user: req.userId,
        $or: [{ deletedForMeAt: { $exists: false } }, { deletedForMeAt: null }],
      },
    },
  })
    .populate(conversationPopulatePaths())
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(limit)
    .lean({ virtuals: true });

  let result = conversations.map((c) =>
    formatConversation(c as unknown as InstanceType<typeof Conversation>, req.userId!)
  );

  // Badge flags from denormalized pinnedMessages (no extra query)
  const withPinnedMsgs = new Set(
    conversations
      .filter((c) => (c.pinnedMessages?.length || 0) > 0)
      .map((c) => c._id.toString())
  );

  // Starred badges only for favorites filter — skip extra Message query on main list (cold start)
  let starredConvIds = new Set<string>();
  if (filter === 'favorites') {
    const userDoc = await User.findById(req.userId).select('starredMessages').lean();
    const starredIds = (userDoc?.starredMessages || []).slice(-200);
    if (starredIds.length > 0) {
      const starredMsgs = await Message.find({
        _id: { $in: starredIds },
        deletedFor: { $ne: req.userId },
      })
        .select('conversation')
        .lean();
      starredConvIds = new Set(starredMsgs.map((m) => String(m.conversation)));
    }
  }

  result = result.map((c) => ({
    ...c,
    hasPinnedMessages: withPinnedMsgs.has(c.id),
    hasStarredMessages: filter === 'favorites' ? starredConvIds.has(c.id) : false,
    // Prefer denormalized participant.unreadCount (O(1)); falls back to 0 for legacy rows
    unreadCount: typeof c.unreadCount === 'number' ? c.unreadCount : 0,
  }));

  if (filter === 'pinned') {
    result = result.filter((c) => c.myPrefs?.isPinned);
  } else if (filter === 'archived') {
    result = result.filter((c) => c.myPrefs?.isArchived);
  } else if (filter === 'favorites') {
    result = result.filter((c) => c.myPrefs?.isFavorite);
  } else if (filter === 'groups') {
    result = result.filter((c) => c.type === 'group' && !c.myPrefs?.isArchived);
  } else {
    result = result.filter((c) => !c.myPrefs?.isArchived);
  }

  res.json({ success: true, data: { conversations: result } });
});

export const getConversation = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conv = await Conversation.findOne({
    _id: req.params.id,
    'participants.user': req.userId,
    isActive: true,
  }).populate(conversationPopulatePaths());

  if (!conv) throw new AppError('Conversation not found', 404);

  const me = conv.participants.find((p) => p.user.toString() === req.userId || (p.user as { _id?: Types.ObjectId })._id?.toString() === req.userId);
  if (me?.deletedForMeAt) {
    throw new AppError('Conversation not found', 404);
  }

  res.json({ success: true, data: { conversation: formatConversation(conv, req.userId!) } });
});

export const createDirect = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { userId } = req.body;
  if (userId === req.userId) throw new AppError('Cannot chat with yourself', 400);

  const other = await User.findById(userId);
  if (!other) throw new AppError('User not found', 404);

  const { isEitherBlocked } = await import('./moderation.controller');
  if (await isEitherBlocked(req.userId!, userId)) {
    throw new AppError('You cannot message this user', 403, 'BLOCKED');
  }

  const existing = await Conversation.findOne({
    type: 'direct',
    isActive: true,
    $and: [
      { participants: { $elemMatch: { user: req.userId } } },
      { participants: { $elemMatch: { user: userId } } },
      { 'participants.2': { $exists: false } },
    ],
  }).populate(conversationPopulatePaths());

  if (existing) {
    // Re-open chat if the current user previously deleted it for themselves
    const me = existing.participants.find(
      (p) => p.user.toString() === req.userId || (p.user as { _id?: Types.ObjectId })._id?.toString() === req.userId
    );
    if (me?.deletedForMeAt) {
      await Conversation.updateOne(
        { _id: existing._id, 'participants.user': req.userId },
        { $unset: { 'participants.$.deletedForMeAt': 1 } }
      );
      await existing.populate(conversationPopulatePaths());
      // Refresh local participant flag for formatter
      const refreshed = await Conversation.findById(existing._id).populate(
        conversationPopulatePaths()
      );
      if (refreshed) {
        res.json({
          success: true,
          data: { conversation: formatConversation(refreshed, req.userId!) },
        });
        return;
      }
    }
    res.json({ success: true, data: { conversation: formatConversation(existing, req.userId!) } });
    return;
  }

  // Upsert on the canonical pair key so two people tapping "message" on each
  // other at the same moment converge on one conversation instead of creating
  // two competing threads.
  const key = directConversationKey(req.userId!, String(userId));
  await Conversation.updateOne(
    { directKey: key },
    {
      $setOnInsert: {
        type: 'direct',
        directKey: key,
        createdBy: req.userId,
        isActive: true,
        participants: [
          { user: new Types.ObjectId(req.userId), role: 'member' },
          { user: new Types.ObjectId(String(userId)), role: 'member' },
        ],
      },
    },
    { upsert: true }
  ).catch(async (err: { code?: number }) => {
    // A concurrent upsert won the race; the findOne below picks up its row.
    if (err?.code !== 11000) throw err;
  });

  const conv = await Conversation.findOne({ directKey: key });
  if (!conv) throw new AppError('Conversation not found', 404);

  await conv.populate(conversationPopulatePaths());
  const formatted = formatConversation(conv, req.userId!);

  try {
    const io = getIO();
    io.to(`user:${userId}`).emit('conversation:new', formatted);
    // Sockets only join conversation rooms at connect time, so both parties
    // would otherwise miss `message:new` for this brand-new chat until they
    // reconnected or opened it. Join their live sockets now.
    io.in(`user:${userId}`).socketsJoin(`conversation:${conv._id}`);
    io.in(`user:${req.userId}`).socketsJoin(`conversation:${conv._id}`);
  } catch {
    /* socket may not be ready */
  }

  res.status(201).json({ success: true, data: { conversation: formatted } });
});

export const createGroup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, description, participantIds } = req.body;
  const uniqueIds = [...new Set([req.userId!, ...participantIds])] as string[];

  if (uniqueIds.length > MAX_GROUP_PARTICIPANTS) {
    throw new AppError(
      `Groups are limited to ${MAX_GROUP_PARTICIPANTS} participants`,
      400,
      'GROUP_FULL'
    );
  }

  const users = await User.find({ _id: { $in: uniqueIds } }).select('_id').lean();
  if (users.length !== uniqueIds.length) {
    throw new AppError('One or more users not found', 404);
  }

  const conv = await Conversation.create({
    type: 'group',
    name,
    description: description || '',
    createdBy: req.userId,
    inviteCode: generateRandomToken(8),
    participants: uniqueIds.map((id) => ({
      user: id,
      role: id === req.userId ? 'owner' : 'member',
    })),
  });

  const systemMsg = await Message.create({
    conversation: conv._id,
    sender: req.userId,
    type: 'system',
    content: `Group "${name}" created`,
  });
  conv.lastMessage = systemMsg._id;
  conv.lastMessageAt = systemMsg.createdAt;
  await conv.save();

  await conv.populate(conversationPopulatePaths());
  const formatted = formatConversation(conv, req.userId!);

  try {
    const io = getIO();
    uniqueIds.forEach((id) => {
      if (id !== req.userId) io.to(`user:${id}`).emit('conversation:new', formatted);
      // Same as direct chats: members online at creation time must be placed in
      // the room now, or they receive nothing until they reconnect.
      io.in(`user:${id}`).socketsJoin(`conversation:${conv._id}`);
    });
  } catch {
    /* */
  }

  res.status(201).json({ success: true, data: { conversation: formatted } });
});

export const updateGroup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conv = await Conversation.findOne({
    _id: req.params.id,
    type: 'group',
    'participants.user': req.userId,
  });
  if (!conv) throw new AppError('Group not found', 404);

  const me = conv.participants.find((p) => p.user.toString() === req.userId);
  if (!me || !['admin', 'owner'].includes(me.role)) {
    throw new AppError('Admin access required', 403, 'FORBIDDEN');
  }

  if (req.body.name) conv.name = req.body.name;
  if (req.body.description !== undefined) conv.description = req.body.description;
  await conv.save();
  await conv.populate(conversationPopulatePaths());

  const formatted = formatConversation(conv, req.userId!);
  try {
    getIO().to(`conversation:${conv._id}`).emit('conversation:updated', formatted);
  } catch {
    /* */
  }

  res.json({ success: true, data: { conversation: formatted } });
});

export const uploadGroupAvatar = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.file) throw new AppError('No file uploaded', 400);
  const conv = await Conversation.findOne({
    _id: req.params.id,
    type: 'group',
    'participants.user': req.userId,
  });
  if (!conv) throw new AppError('Group not found', 404);

  const me = conv.participants.find((p) => p.user.toString() === req.userId);
  if (!me || !['admin', 'owner'].includes(me.role)) {
    throw new AppError('Admin access required', 403);
  }

  if (!req.file.mimetype.startsWith('image/')) {
    const { unlinkQuiet } = await import('../utils/fileMagic');
    unlinkQuiet(req.file.path);
    throw new AppError('Group avatar must be an image', 400, 'INVALID_FILE_TYPE');
  }
  const { fileMatchesMime, unlinkQuiet } = await import('../utils/fileMagic');
  if (!fileMatchesMime(req.file.path, req.file.mimetype)) {
    unlinkQuiet(req.file.path);
    throw new AppError('Group avatar file content is invalid', 400, 'INVALID_FILE_CONTENT');
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
        meta: { reason: scan.reason || 'flagged', kind: 'group_avatar' },
      });
      throw new AppError(scan.reason || 'File failed security scan', 400, 'MALWARE_BLOCKED');
    }
    stripImageMetadata(req.file.path, req.file.mimetype);
  }

  // Relative path so group avatars survive ngrok URL changes
  const previousAvatar = conv.avatar;
  conv.avatar = toRelativeMediaPath(fileUrl(req.file.filename, req.file.mimetype));
  await conv.save();
  if (previousAvatar && previousAvatar !== conv.avatar) {
    deleteStoredUpload(previousAvatar);
  }
  await conv.populate(conversationPopulatePaths());

  res.json({
    success: true,
    data: { conversation: formatConversation(conv, req.userId!) },
  });
});

export const addParticipants = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conv = await Conversation.findOne({
    _id: req.params.id,
    type: 'group',
    'participants.user': req.userId,
  });
  if (!conv) throw new AppError('Group not found', 404);

  const me = conv.participants.find((p) => p.user.toString() === req.userId);
  if (!me || !['admin', 'owner'].includes(me.role)) {
    throw new AppError('Admin access required', 403);
  }

  const { userIds } = req.body;
  const existingIds = new Set(conv.participants.map((p) => p.user.toString()));
  const candidates = [...new Set((userIds as string[]).filter((id) => !existingIds.has(id)))];

  // The participants array lives inside the conversation document, so an
  // unbounded group walks toward Mongo's 16 MB document limit and makes every
  // populate progressively more expensive.
  if (existingIds.size + candidates.length > MAX_GROUP_PARTICIPANTS) {
    throw new AppError(
      `Groups are limited to ${MAX_GROUP_PARTICIPANTS} participants`,
      400,
      'GROUP_FULL'
    );
  }

  // Only add real accounts — ids were never checked against the users
  // collection, so a group could accumulate participants that do not exist.
  const realUsers = candidates.length
    ? await User.find({ _id: { $in: candidates } }).select('_id').lean()
    : [];
  const addedIds = realUsers.map((u) => String(u._id));
  if (addedIds.length !== candidates.length) {
    throw new AppError('One or more users not found', 404);
  }

  for (const uid of addedIds) {
    conv.participants.push({
      user: new Types.ObjectId(uid),
      role: 'member',
      joinedAt: new Date(),
      lastReadAt: new Date(),
      isMuted: false,
      isPinned: false,
      isArchived: false,
      isFavorite: false,
      unreadCount: 0,
    });
  }
  await conv.save();
  await conv.populate(conversationPopulatePaths());

  const formatted = formatConversation(conv, req.userId!);
  try {
    const io = getIO();
    for (const id of addedIds) {
      io.to(`user:${id}`).emit('conversation:new', formatted);
      // Join their live sockets to the room now; otherwise a member added while
      // online received no realtime messages until they reconnected.
      io.in(`user:${id}`).socketsJoin(`conversation:${conv._id}`);
    }
    io.to(`conversation:${conv._id}`).emit('conversation:updated', formatted);
  } catch {
    /* */
  }

  res.json({ success: true, data: { conversation: formatted } });
});

export const removeParticipant = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conv = await Conversation.findOne({
    _id: req.params.id,
    type: 'group',
    'participants.user': req.userId,
  });
  if (!conv) throw new AppError('Group not found', 404);

  const targetId = req.params.userId;
  const me = conv.participants.find((p) => p.user.toString() === req.userId);
  const target = conv.participants.find((p) => p.user.toString() === targetId);

  if (!target) throw new AppError('Participant not found', 404);
  if (target.role === 'owner') throw new AppError('Cannot remove owner', 400);

  const isSelf = targetId === req.userId;
  if (!isSelf && (!me || !['admin', 'owner'].includes(me.role))) {
    throw new AppError('Admin access required', 403);
  }

  conv.participants = conv.participants.filter((p) => p.user.toString() !== targetId);
  await conv.save();
  await conv.populate(conversationPopulatePaths());

  // Bust membership cache so removed user cannot re-join via stale true
  try {
    const { membershipCache, contactsCache } = await import('../utils/ttlCache');
    membershipCache.delete(`${targetId}:${conv._id}`);
    contactsCache.delete(targetId);
    contactsCache.delete(req.userId!);
  } catch {
    /* */
  }

  const formatted = formatConversation(conv, req.userId!);
  try {
    const io = getIO();
    const room = `conversation:${conv._id}`;
    // Stop removed user from receiving room broadcasts until reconnect
    io.in(`user:${targetId}`).socketsLeave(room);
    io.to(`user:${targetId}`).emit('conversation:removed', {
      conversationId: conv._id.toString(),
    });
    io.to(room).emit('conversation:updated', formatted);
  } catch {
    /* */
  }

  res.json({ success: true, data: { conversation: formatted } });
});

export const updateParticipantRole = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conv = await Conversation.findOne({
    _id: req.params.id,
    type: 'group',
    'participants.user': req.userId,
  });
  if (!conv) throw new AppError('Group not found', 404);

  const me = conv.participants.find((p) => p.user.toString() === req.userId);
  if (!me || me.role !== 'owner') {
    throw new AppError('Only owner can change roles', 403);
  }

  const target = conv.participants.find((p) => p.user.toString() === req.params.userId);
  if (!target) throw new AppError('Participant not found', 404);
  if (target.role === 'owner') throw new AppError('Cannot change owner role', 400);

  target.role = req.body.role;
  await conv.save();
  await conv.populate(conversationPopulatePaths());

  res.json({
    success: true,
    data: { conversation: formatConversation(conv, req.userId!) },
  });
});

export const deleteGroup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conv = await Conversation.findOne({
    _id: req.params.id,
    type: 'group',
    'participants.user': req.userId,
  });
  if (!conv) throw new AppError('Group not found', 404);

  const me = conv.participants.find((p) => p.user.toString() === req.userId);
  if (!me || me.role !== 'owner') {
    throw new AppError('Only owner can delete group', 403);
  }

  conv.isActive = false;
  await conv.save();

  try {
    getIO()
      .to(`conversation:${conv._id}`)
      .emit('conversation:deleted', { conversationId: conv._id.toString() });
  } catch {
    /* */
  }

  res.json({ success: true, data: { message: 'Group deleted' } });
});

/**
 * Delete chat for the current user only (direct or group).
 * - Hides the conversation from their list
 * - Marks existing messages as deleted-for-them (history stays for others)
 * - New messages re-surface the chat with a fresh thread view
 */
export const deleteConversationForMe = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const conv = await Conversation.findOne({
    _id: req.params.id,
    'participants.user': userId,
    isActive: true,
  });
  if (!conv) throw new AppError('Conversation not found', 404);

  await Conversation.updateOne(
    { _id: conv._id, 'participants.user': userId },
    {
      $set: {
        'participants.$.deletedForMeAt': new Date(),
        'participants.$.unreadCount': 0,
        'participants.$.isPinned': false,
        'participants.$.isArchived': false,
        'participants.$.isFavorite': false,
        'participants.$.isMuted': false,
      },
    }
  );

  // Hide existing history for this user only
  await Message.updateMany(
    { conversation: conv._id, deletedFor: { $ne: userId } },
    { $addToSet: { deletedFor: new Types.ObjectId(userId) } }
  );

  try {
    getIO()
      .to(`user:${userId}`)
      .emit('conversation:removed', { conversationId: conv._id.toString() });
  } catch {
    /* */
  }

  res.json({
    success: true,
    data: { message: 'Chat deleted', conversationId: conv._id.toString() },
  });
});

export const updatePrefs = asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const setFields: Record<string, boolean> = {};
  if (req.body.isPinned !== undefined) setFields['participants.$.isPinned'] = !!req.body.isPinned;
  if (req.body.isArchived !== undefined)
    setFields['participants.$.isArchived'] = !!req.body.isArchived;
  if (req.body.isFavorite !== undefined)
    setFields['participants.$.isFavorite'] = !!req.body.isFavorite;
  if (req.body.isMuted !== undefined) setFields['participants.$.isMuted'] = !!req.body.isMuted;

  if (Object.keys(setFields).length === 0) {
    throw new AppError('No preferences provided', 400, 'VALIDATION_ERROR');
  }

  // Atomic positional update so nested participant flags always persist
  const conv = await Conversation.findOneAndUpdate(
    { _id: req.params.id, 'participants.user': userId, isActive: true },
    { $set: setFields },
    { new: true }
  ).populate(conversationPopulatePaths());

  if (!conv) throw new AppError('Conversation not found', 404);

  res.json({
    success: true,
    data: { conversation: formatConversation(conv, userId) },
  });
});

/**
 * Store group/direct E2E wrapped keys (opaque to the server).
 * Body: { wrappedKeys: [{ userId, wrappedKey }], version?: number }
 *
 * Policy:
 * - owner/admin (and both parties in direct chats) may set wraps for participants
 * - regular group members may only upsert their own entry
 *
 * Uses atomic update (not document.save) to avoid Mongoose VersionError under concurrent re-wraps.
 */
export const setE2EKeys = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conv = await Conversation.findOne({
    _id: req.params.id,
    'participants.user': req.userId,
    isActive: true,
  }).lean();
  if (!conv) throw new AppError('Conversation not found', 404);

  const raw = req.body.wrappedKeys;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError('wrappedKeys required', 400, 'VALIDATION_ERROR');
  }

  const me = (conv.participants || []).find(
    (p) => String((p.user as { toString(): string }).toString?.() || p.user) === req.userId
  );
  // Direct chats: both participants may distribute wraps to each other
  const isDirect = conv.type === 'direct';
  const isPrivileged =
    isDirect || !!(me && (me.role === 'owner' || me.role === 'admin'));

  const participantIds = new Set(
    (conv.participants || []).map((p) =>
      String((p.user as { toString(): string }).toString?.() || p.user)
    )
  );

  const incoming: { userId: string; wrappedKey: string }[] = [];
  for (const item of raw) {
    const uid = String(item?.userId || '');
    const wk = String(item?.wrappedKey || '').trim();
    if (!Types.ObjectId.isValid(uid) || !participantIds.has(uid)) {
      throw new AppError(`Invalid participant for E2E key: ${uid}`, 400, 'INVALID_KEY');
    }
    if (!wk || wk.length > 4096) {
      throw new AppError('Invalid wrapped key', 400, 'INVALID_KEY');
    }
    if (!isPrivileged && uid !== req.userId) {
      throw new AppError('Only admins can distribute keys for other members', 403, 'FORBIDDEN');
    }
    incoming.push({ userId: uid, wrappedKey: wk });
  }

  // Merge with existing wraps (always merge — never wipe peers on partial concurrent updates)
  const map = new Map(
    ((conv as { e2eWrappedKeys?: { userId?: unknown; wrappedKey?: string }[] }).e2eWrappedKeys ||
      []
    ).map((k) => [
      String((k.userId as { toString?: () => string })?.toString?.() || k.userId || ''),
      String(k.wrappedKey || ''),
    ])
  );
  for (const k of incoming) {
    map.set(k.userId, k.wrappedKey);
  }
  const nextWraps = [...map.entries()]
    .filter(([userId, wrappedKey]) => userId && wrappedKey && participantIds.has(userId))
    .map(([userId, wrappedKey]) => ({
      userId: new Types.ObjectId(userId),
      wrappedKey,
    }));

  const nextVersion = Math.max(
    1,
    (typeof conv.e2eVersion === 'number' ? conv.e2eVersion : 0) + 1
  );

  // Atomic $set avoids optimistic-concurrency VersionError under dual-client re-wrap races
  await Conversation.updateOne(
    { _id: conv._id, 'participants.user': req.userId, isActive: true },
    {
      $set: {
        e2eWrappedKeys: nextWraps,
        e2eVersion: nextVersion,
      },
    }
  );

  const populated = await Conversation.findById(conv._id).populate(conversationPopulatePaths());
  if (!populated) throw new AppError('Conversation not found', 404);
  const dto = formatConversation(populated, req.userId!);

  try {
    getIO().to(`conversation:${conv._id}`).emit('conversation:updated', dto);
  } catch {
    /* */
  }

  res.json({ success: true, data: { conversation: dto } });
});

export const markRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conv = await Conversation.findOne({
    _id: req.params.id,
    'participants.user': req.userId,
  });
  if (!conv) throw new AppError('Conversation not found', 404);

  const me = conv.participants.find((p) => p.user.toString() === req.userId);
  if (!me) throw new AppError('Not a participant', 403);

  const previousReadAt = me.lastReadAt || new Date(0);
  const readAt = new Date();

  // Positional update touches only this participant's subdocument. A full
  // conv.save() rewrites the whole participants array, so a concurrent
  // sendMessage $inc on *another* participant's unreadCount was being lost.
  await Conversation.updateOne(
    { _id: conv._id, 'participants.user': req.userId },
    {
      $set: {
        'participants.$.lastReadAt': readAt,
        'participants.$.unreadCount': 0,
        ...(req.body.messageId && Types.ObjectId.isValid(String(req.body.messageId))
          ? {
              'participants.$.lastReadMessageId': new Types.ObjectId(
                String(req.body.messageId)
              ),
            }
          : {}),
      },
    }
  );
  me.lastReadAt = readAt;

  // Bounded by previousReadAt so reopening a fully-read chat is nearly free
  await Message.updateMany(
    {
      conversation: conv._id,
      sender: { $ne: req.userId },
      createdAt: { $gt: previousReadAt },
      'readBy.user': { $ne: req.userId },
    },
    {
      $addToSet: { deliveredTo: req.userId },
      $push: { readBy: { user: req.userId, readAt: new Date() } },
    }
  );

  try {
    getIO()
      .to(`conversation:${conv._id}`)
      .emit('messages:read', {
        conversationId: conv._id.toString(),
        userId: req.userId,
        readAt: me.lastReadAt,
      });
  } catch {
    /* */
  }

  res.json({ success: true, data: { lastReadAt: me.lastReadAt } });
});
