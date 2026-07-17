import { Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { Attachment } from '../models/Attachment';
import { Notification } from '../models/Notification';
import { AppError } from '../utils/AppError';
import asyncHandler from '../utils/asyncHandler';
import { getIO, isUserOnline } from '../socket';
import { fileUrl } from '../middleware/upload';
import { formatMessage, participantUserId } from '../utils/messageFormat';
import { escapeRegex, isObjectIdString, sanitizeFilename } from '../utils/sanitize';
import { toRelativeMediaPath } from '../utils/mediaUrl';
import {
  ensureConversationParticipant,
  ensureConversationParticipantId,
  ensureMessageAccess,
  messagePopulatePaths,
} from '../services/message/messageAccess.service';

export const getMessages = asyncHandler(async (req: AuthRequest, res: Response) => {
  // Lean access check — list path does not need full conversation document
  const conv = await ensureConversationParticipantId(req.params.conversationId, req.userId!);
  // Default 20 for first-open TTFP; client can request more
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 80);
  const before = req.query.before as string | undefined;
  const after = req.query.after as string | undefined;

  const query: Record<string, unknown> = {
    conversation: conv._id,
    deletedFor: { $ne: req.userId },
  };

  if (before && isObjectIdString(before)) {
    // Cursor from ObjectId timestamp when possible (avoids extra findById)
    const beforeOid = new Types.ObjectId(before);
    const beforeMsg = await Message.findById(beforeOid)
      .select('createdAt conversation')
      .lean();
    if (beforeMsg && String(beforeMsg.conversation) === String(conv._id)) {
      query.createdAt = { $lt: beforeMsg.createdAt };
    }
  }
  if (after && isObjectIdString(after)) {
    const afterMsg = await Message.findById(after).select('createdAt conversation').lean();
    if (afterMsg && String(afterMsg.conversation) === String(conv._id)) {
      query.createdAt = { $gt: afterMsg.createdAt };
    }
  }

  // Project only fields needed for UI — huge threads stay cheap per page
  const messages = await Message.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .select(
      'conversation sender type content attachments replyTo forwardedFrom reactions mentions deliveredTo readBy isEdited editedAt isDeleted isPinned viewOnce viewOnceViewedBy clientId isE2E linkPreview createdAt updatedAt'
    )
    .populate(messagePopulatePaths)
    .lean({ virtuals: true });

  const hasMore = messages.length > limit;
  const page = (hasMore ? messages.slice(0, limit) : messages).reverse();

  res.json({
    success: true,
    data: {
      messages: page.map((m) => formatMessage(m as never, { viewerId: req.userId! })),
      hasMore,
      nextCursor: page.length ? String((page[0] as { _id: Types.ObjectId })._id) : null,
    },
  });
});

export const sendMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conv = await ensureConversationParticipant(req.params.conversationId, req.userId!);

  // Block enforcement (direct chats)
  if (conv.type === 'direct') {
    const other = conv.participants.find(
      (p) => String((p.user as { _id?: unknown; toString?: () => string })._id || p.user) !== req.userId
    );
    const otherId = other
      ? String((other.user as { _id?: { toString(): string } })._id || other.user)
      : '';
    if (otherId) {
      const { isEitherBlocked } = await import('./moderation.controller');
      if (await isEitherBlocked(req.userId!, otherId)) {
        throw new AppError('You cannot message this user', 403, 'BLOCKED');
      }
    }
  }

  let { content, type, replyTo, mentions, attachmentIds, clientId, viewOnce, isE2E } =
    req.body;

  // E2E ciphertext is base64-expanded; allow more room than plaintext
  if (typeof content === 'string') content = content.slice(0, isE2E ? 20000 : 10000);
  const e2eFlag = isE2E === true || isE2E === 'true';
  if (replyTo === '' || !isObjectIdString(replyTo)) replyTo = undefined;
  if (!Array.isArray(mentions)) mentions = undefined;
  if (!Array.isArray(attachmentIds)) attachmentIds = undefined;

  let attachments: Array<Record<string, unknown>> = [];

  if (attachmentIds?.length) {
    const validIds = attachmentIds.filter(isObjectIdString).slice(0, 10);
    const docs = await Attachment.find({
      _id: { $in: validIds },
      uploader: req.userId,
    });
    attachments = docs.map((d) => ({
      filename: d.filename,
      originalName: sanitizeFilename(d.originalName),
      mimeType: d.mimeType,
      size: d.size,
      url: d.url,
      thumbnailUrl: d.thumbnailUrl,
      duration: d.duration,
      width: d.width,
      height: d.height,
    }));
  }

  if (req.files && Array.isArray(req.files) && req.files.length) {
    const { fileMatchesMime, unlinkQuiet } = await import('../utils/fileMagic');
    for (const file of req.files as Express.Multer.File[]) {
      if (!fileMatchesMime(file.path, file.mimetype)) {
        unlinkQuiet(file.path);
        throw new AppError(
          `File content does not match declared type (${file.mimetype})`,
          400,
          'INVALID_FILE_CONTENT'
        );
      }
      // Relative URL — works across ngrok restarts
      const url = toRelativeMediaPath(fileUrl(file.filename, file.mimetype));
      const originalName = sanitizeFilename(file.originalname);
      const att = await Attachment.create({
        uploader: req.userId,
        filename: file.filename,
        originalName,
        mimeType: file.mimetype,
        size: file.size,
        url,
        conversation: conv._id,
      });
      attachments.push({
        filename: att.filename,
        originalName: att.originalName,
        mimeType: att.mimeType,
        size: att.size,
        url: att.url,
      });
    }
  }

  if (!content?.trim() && attachments.length === 0) {
    throw new AppError('Message cannot be empty', 400);
  }

  let msgType = type || 'text';
  if (attachments.length && msgType === 'text') {
    const mime = String(attachments[0].mimeType || '');
    if (mime.startsWith('image/')) msgType = 'image';
    else if (mime.startsWith('video/')) msgType = 'video';
    else if (mime.startsWith('audio/'))
      msgType = mime.includes('webm') || mime.includes('ogg') ? 'voice' : 'audio';
    else msgType = 'document';
  }

  // View once: only pure image messages (no mixed video/docs)
  const wantViewOnce = viewOnce === true || viewOnce === 'true' || viewOnce === '1';
  const allImages =
    attachments.length > 0 &&
    attachments.every((a) => String(a.mimeType || '').startsWith('image/'));
  const isViewOnce = wantViewOnce && allImages && msgType === 'image';
  if (wantViewOnce && !isViewOnce) {
    throw new AppError('View once is only available for photos', 400, 'VIEW_ONCE_IMAGES_ONLY');
  }

  // Never parse link previews from ciphertext
  let linkPreview;
  if (!e2eFlag) {
    const urlMatch = typeof content === 'string' ? content.match(/https?:\/\/[^\s<>"']+/i) : null;
    if (urlMatch) {
      try {
        const u = new URL(urlMatch[0]);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          u.username = '';
          u.password = '';
          const safeUrl = u.toString().slice(0, 2048);
          linkPreview = { url: safeUrl, title: safeUrl.slice(0, 200) };
        }
      } catch {
        /* ignore malformed URL */
      }
    }
  }

  // Idempotency via clientId (retry-safe) — also protects against duplicate posts
  let safeClientId: string | undefined;
  if (clientId && typeof clientId === 'string' && clientId.length <= 64) {
    safeClientId = clientId;
    const existing = await Message.findOne({
      conversation: conv._id,
      sender: req.userId,
      clientId: safeClientId,
    });
    if (existing) {
      await existing.populate(messagePopulatePaths);
      res.status(200).json({
        success: true,
        data: { message: { ...formatMessage(existing), clientId: safeClientId } },
      });
      return;
    }
  }

  // Basic spam / flood: identical body spam within a short window
  if (typeof content === 'string' && content.length > 0 && !e2eFlag) {
    const recent = await Message.findOne({
      conversation: conv._id,
      sender: req.userId,
      content,
      createdAt: { $gte: new Date(Date.now() - 8_000) },
    })
      .select('_id')
      .lean();
    if (recent) {
      throw new AppError('Duplicate message — slow down', 429, 'DUPLICATE_MESSAGE');
    }
  }

  const message = await Message.create({
    conversation: conv._id,
    sender: req.userId,
    type: msgType,
    content: content || '',
    attachments,
    replyTo: replyTo || undefined,
    mentions: (mentions || []).filter(isObjectIdString),
    deliveredTo: [req.userId],
    readBy: [{ user: req.userId, readAt: new Date() }],
    linkPreview: isViewOnce || e2eFlag ? undefined : linkPreview,
    viewOnce: isViewOnce,
    viewOnceViewedBy: [],
    clientId: safeClientId,
    isE2E: e2eFlag,
  });

  // Atomic last-message + per-participant unread increment (scales past aggregation on list)
  // Also re-surface chats that participants had "deleted for me"
  await Conversation.updateOne(
    { _id: conv._id },
    {
      $set: { lastMessage: message._id, lastMessageAt: message.createdAt },
      $inc: { 'participants.$[others].unreadCount': 1 },
      $unset: { 'participants.$[hidden].deletedForMeAt': 1 },
    },
    {
      arrayFilters: [
        { 'others.user': { $ne: new Types.ObjectId(req.userId) } },
        { 'hidden.deletedForMeAt': { $type: 'date' } },
      ],
    }
  );

  await message.populate(messagePopulatePaths);
  // Response to sender includes their media; room broadcast must NOT use sender as viewer
  // (that made recipients see view-once as already opened).
  const formatted = {
    ...formatMessage(message, { viewerId: req.userId! }),
    clientId,
  };
  const broadcast = {
    ...formatMessage(message),
    clientId,
  };

  const senderName =
    typeof message.sender === 'object' && message.sender && 'displayName' in message.sender
      ? (message.sender as { displayName?: string }).displayName || 'New message'
      : 'New message';

  try {
    const io = getIO();
    io.to(`conversation:${conv._id}`).emit('message:new', broadcast);

    // Persist notifications only for offline / muted-aware recipients (batch)
    const notifDocs = [];
    for (const p of conv.participants) {
      const pid = participantUserId(p);
      if (pid === req.userId || p.isMuted) continue;

      io.to(`user:${pid}`).emit('notification:message', {
        conversationId: conv._id.toString(),
        message: formatted,
      });

      // Skip DB notification spam for online users unless mentioned
      const isMention = Array.isArray(mentions) && mentions.includes(pid);
      if (!isUserOnline(pid) || isMention) {
        notifDocs.push({
          user: pid,
          type: isMention ? 'mention' : 'message',
          title: senderName,
          body: e2eFlag
            ? '🔒 Encrypted message'
            : (content || `Sent a ${msgType}`).slice(0, 120),
          actor: req.userId,
          conversation: conv._id,
          message: message._id,
        });
      }
    }
    if (notifDocs.length) {
      await Notification.insertMany(notifDocs, { ordered: false }).catch(() => undefined);
    }
  } catch {
    /* socket optional */
  }

  res.status(201).json({ success: true, data: { message: formatted } });
});

export const editMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const message = await ensureMessageAccess(req.params.id, req.userId!);
  if (message.sender.toString() !== req.userId) {
    throw new AppError('Can only edit your own messages', 403);
  }
  if (message.isDeleted) throw new AppError('Message deleted', 400);
  if (message.type === 'system') throw new AppError('Cannot edit system messages', 400);

  // Preserve E2E ciphertext length allowance
  const editE2E = message.isE2E || req.body.isE2E === true || req.body.isE2E === 'true';
  message.content = String(req.body.content || '').slice(0, editE2E ? 20000 : 10000);
  if (editE2E) message.isE2E = true;
  message.isEdited = true;
  message.editedAt = new Date();
  await message.save();
  await message.populate(messagePopulatePaths);

  const formatted = formatMessage(message);
  try {
    getIO().to(`conversation:${message.conversation}`).emit('message:updated', formatted);
  } catch {
    /* */
  }

  res.json({ success: true, data: { message: formatted } });
});

export const deleteForMe = asyncHandler(async (req: AuthRequest, res: Response) => {
  const message = await ensureMessageAccess(req.params.id, req.userId!);

  if (!message.deletedFor.some((id) => id.toString() === req.userId)) {
    message.deletedFor.push(new Types.ObjectId(req.userId));
    await message.save();
  }

  res.json({ success: true, data: { message: 'Deleted for you' } });
});

export const deleteForEveryone = asyncHandler(async (req: AuthRequest, res: Response) => {
  const message = await ensureMessageAccess(req.params.id, req.userId!);
  if (message.sender.toString() !== req.userId) {
    throw new AppError('Can only delete your own messages for everyone', 403);
  }

  message.isDeleted = true;
  message.deletedAt = new Date();
  message.content = '';
  message.attachments = [];
  await message.save();
  await message.populate(messagePopulatePaths);

  const formatted = formatMessage(message);
  try {
    getIO().to(`conversation:${message.conversation}`).emit('message:deleted', formatted);
  } catch {
    /* */
  }

  res.json({ success: true, data: { message: formatted } });
});

export const reactToMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const message = await ensureMessageAccess(req.params.id, req.userId!);

  const { emoji } = req.body;
  if (!emoji || typeof emoji !== 'string' || emoji.length > 32) {
    throw new AppError('Invalid emoji', 400);
  }

  const existing = message.reactions.find((r) => r.emoji === emoji);

  if (existing) {
    const idx = existing.users.findIndex((u) => u.toString() === req.userId);
    if (idx >= 0) {
      existing.users.splice(idx, 1);
      if (existing.users.length === 0) {
        message.reactions = message.reactions.filter((r) => r.emoji !== emoji);
      }
    } else {
      existing.users.push(new Types.ObjectId(req.userId));
    }
  } else {
    if (message.reactions.length >= 20) {
      throw new AppError('Too many reaction types', 400);
    }
    message.reactions.push({ emoji, users: [new Types.ObjectId(req.userId)] });
  }

  await message.save();
  await message.populate(messagePopulatePaths);

  const formatted = formatMessage(message);
  try {
    getIO().to(`conversation:${message.conversation}`).emit('message:reaction', formatted);
  } catch {
    /* */
  }

  res.json({ success: true, data: { message: formatted } });
});

export const openViewOnce = asyncHandler(async (req: AuthRequest, res: Response) => {
  const message = await ensureMessageAccess(req.params.id, req.userId!);
  if (message.isDeleted) throw new AppError('Message not found', 404);
  if (!message.viewOnce) {
    throw new AppError('Not a view-once message', 400, 'NOT_VIEW_ONCE');
  }
  if (message.sender.toString() === req.userId) {
    // Sender already has access via normal format
    await message.populate(messagePopulatePaths);
    res.json({
      success: true,
      data: {
        message: formatMessage(message, {
          viewerId: req.userId!,
          includeViewOnceMedia: true,
        }),
      },
    });
    return;
  }

  const uid = String(req.userId);
  const already = (message.viewOnceViewedBy || []).some((id) => String(id) === uid);
  if (already) {
    // Idempotent: return locked shape so clients can sync UI without looking "openable"
    await message.populate(messagePopulatePaths);
    const locked = formatMessage(message, { viewerId: uid });
    res.status(200).json({
      success: true,
      data: {
        message: locked,
        media: [],
        locked,
        alreadyOpened: true,
      },
    });
    return;
  }

  message.viewOnceViewedBy = message.viewOnceViewedBy || [];
  message.viewOnceViewedBy.push(new Types.ObjectId(uid));
  await message.save();
  await message.populate(messagePopulatePaths);

  // One-time media for this response only
  const withMedia = formatMessage(message, {
    viewerId: req.userId!,
    includeViewOnceMedia: true,
  });
  // Locked shape for this viewer's cache after open
  const locked = formatMessage(message, { viewerId: req.userId! });

  try {
    // Broadcast without media URLs (no viewerId → locked for everyone except we
    // still need sender to see "Opened" — they re-format with their viewerId on next fetch)
    getIO()
      .to(`conversation:${message.conversation}`)
      .emit('message:updated', formatMessage(message));
  } catch {
    /* */
  }

  res.json({
    success: true,
    data: {
      message: withMedia,
      media: (withMedia.attachments as Array<Record<string, unknown>> | undefined)?.map((a) => ({
        url: a.url,
        mimeType: a.mimeType,
        originalName: a.originalName,
      })),
      locked,
    },
  });
});

export const forwardMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const original = await ensureMessageAccess(req.params.id, req.userId!);
  if (original.isDeleted) throw new AppError('Message not found', 404);
  if (original.viewOnce) {
    throw new AppError('View-once photos cannot be forwarded', 400, 'VIEW_ONCE_NO_FORWARD');
  }

  const { conversationIds } = req.body;
  const ids = (conversationIds || []).filter(isObjectIdString).slice(0, 20);
  const created = [];

  for (const cid of ids) {
    await ensureConversationParticipant(cid, req.userId!);
    const msg = await Message.create({
      conversation: cid,
      sender: req.userId,
      type: original.type,
      content: original.content,
      attachments: original.attachments,
      forwardedFrom: original._id,
      deliveredTo: [req.userId],
      readBy: [{ user: req.userId, readAt: new Date() }],
    });
    await Conversation.findByIdAndUpdate(cid, {
      lastMessage: msg._id,
      lastMessageAt: msg.createdAt,
    });
    await msg.populate(messagePopulatePaths);
    const formatted = formatMessage(msg);
    created.push(formatted);
    try {
      getIO().to(`conversation:${cid}`).emit('message:new', formatted);
    } catch {
      /* */
    }
  }

  res.status(201).json({ success: true, data: { messages: created } });
});

export const pinMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const message = await ensureMessageAccess(req.params.id, req.userId!);
  const conv = await ensureConversationParticipant(message.conversation.toString(), req.userId!);

  const findMe = () =>
    conv.participants.find((p) => participantUserId(p) === req.userId);

  if (conv.type === 'group') {
    const me = findMe();
    if (!me || !['admin', 'owner'].includes(me.role)) {
      throw new AppError('Only group admins can pin messages', 403, 'FORBIDDEN');
    }
  }

  message.isPinned = !message.isPinned;
  await message.save();

  if (message.isPinned) {
    if (!conv.pinnedMessages.some((id) => id.toString() === message._id.toString())) {
      conv.pinnedMessages = [...conv.pinnedMessages.slice(-49), message._id];
    }
  } else {
    conv.pinnedMessages = conv.pinnedMessages.filter(
      (id) => id.toString() !== message._id.toString()
    );
  }
  await conv.save();
  await message.populate(messagePopulatePaths);

  const formatted = formatMessage(message);
  try {
    getIO().to(`conversation:${conv._id}`).emit('message:pinned', formatted);
  } catch {
    /* */
  }

  res.json({
    success: true,
    data: {
      message: formatted,
    },
  });
});

export const starMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  const message = await ensureMessageAccess(req.params.id, req.userId!);

  const user = await User.findById(req.userId);
  if (!user) throw new AppError('User not found', 404);

  const idx = user.starredMessages.findIndex((id) => id.toString() === message._id.toString());
  let starred = false;
  if (idx >= 0) {
    user.starredMessages.splice(idx, 1);
  } else {
    if (user.starredMessages.length >= 500) {
      user.starredMessages = user.starredMessages.slice(-499);
    }
    user.starredMessages.push(message._id);
    starred = true;
  }
  await user.save();

  res.json({
    success: true,
    data: {
      starred,
      messageId: message._id.toString(),
      conversationId: message.conversation.toString(),
    },
  });
});

/** Pinned messages across all chats the user is in (not whole chats). */
export const getPinnedMessages = asyncHandler(async (req: AuthRequest, res: Response) => {
  const convs = await Conversation.find({
    'participants.user': req.userId,
    isActive: true,
  })
    .select('_id name type participants')
    .populate({ path: 'participants.user', select: 'username displayName avatar' })
    .lean();

  const convIds = convs.map((c) => c._id);
  if (convIds.length === 0) {
    res.json({ success: true, data: { messages: [] } });
    return;
  }

  const messages = await Message.find({
    conversation: { $in: convIds },
    isPinned: true,
    isDeleted: false,
    deletedFor: { $ne: req.userId },
  })
    .sort({ updatedAt: -1 })
    .limit(100)
    .populate(messagePopulatePaths)
    .lean({ virtuals: true });

  const chatNameById = new Map<string, string>();
  for (const c of convs) {
    const id = c._id.toString();
    if (c.type === 'group' && c.name) {
      chatNameById.set(id, c.name);
      continue;
    }
    const other = (c.participants || []).find(
      (p) => participantUserId(p as { user: unknown }) !== req.userId
    );
    const ou = other?.user as unknown as { displayName?: string; username?: string } | undefined;
    chatNameById.set(id, ou?.displayName || ou?.username || 'Chat');
  }

  res.json({
    success: true,
    data: {
      messages: messages.map((m) => {
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

export const searchMessages = asyncHandler(async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  const limit = Math.min(parseInt(String(req.query.limit || '30'), 10) || 30, 50);
  const conversationId = req.query.conversationId as string | undefined;

  if (!q) {
    res.json({ success: true, data: { messages: [] } });
    return;
  }

  const convFilter: Record<string, unknown> = {
    'participants.user': req.userId,
    isActive: true,
  };
  if (conversationId) {
    if (!isObjectIdString(conversationId)) {
      res.json({ success: true, data: { messages: [] } });
      return;
    }
    convFilter._id = conversationId;
  }

  const convs = await Conversation.find(convFilter).select('_id').lean();
  const convIds = convs.map((c) => c._id);

  const messages = await Message.find({
    conversation: { $in: convIds },
    isDeleted: false,
    deletedFor: { $ne: req.userId },
    content: { $regex: escapeRegex(q), $options: 'i' },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate(messagePopulatePaths)
    .lean({ virtuals: true });

  res.json({
    success: true,
    data: { messages: messages.map((m) => formatMessage(m as never)) },
  });
});
