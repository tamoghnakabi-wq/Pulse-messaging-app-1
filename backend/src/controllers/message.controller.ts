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
import logger from '../utils/logger';
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

  // Keyset pagination must use the full sort key (createdAt, _id). Comparing on
  // createdAt alone silently drops every message sharing the cursor's timestamp,
  // which happens routinely for bursts and bulk inserts.
  const cursorClauses: Record<string, unknown>[] = [];

  if (before && isObjectIdString(before)) {
    const beforeOid = new Types.ObjectId(before);
    const beforeMsg = await Message.findById(beforeOid)
      .select('createdAt conversation')
      .lean();
    if (beforeMsg && String(beforeMsg.conversation) === String(conv._id)) {
      cursorClauses.push({
        $or: [
          { createdAt: { $lt: beforeMsg.createdAt } },
          { createdAt: beforeMsg.createdAt, _id: { $lt: beforeOid } },
        ],
      });
    }
  }
  if (after && isObjectIdString(after)) {
    const afterOid = new Types.ObjectId(after);
    const afterMsg = await Message.findById(afterOid)
      .select('createdAt conversation')
      .lean();
    if (afterMsg && String(afterMsg.conversation) === String(conv._id)) {
      cursorClauses.push({
        $or: [
          { createdAt: { $gt: afterMsg.createdAt } },
          { createdAt: afterMsg.createdAt, _id: { $gt: afterOid } },
        ],
      });
    }
  }
  if (cursorClauses.length) query.$and = cursorClauses;

  // Project only fields needed for UI — huge threads stay cheap per page
  const messages = await Message.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .select(
      'conversation sender type content attachments replyTo forwardedFrom reactions mentions deliveredTo readBy isEdited editedAt isDeleted isPinned viewOnce viewOnceViewedBy clientId isE2E gameId pollId linkPreview createdAt updatedAt'
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

  let { content, replyTo, mentions, attachmentIds, e2eMetas, mediaTypes } = req.body;
  const { type, clientId, viewOnce, isE2E } = req.body;

  // E2E ciphertext is base64-expanded; allow more room than plaintext
  if (typeof content === 'string') content = content.slice(0, isE2E ? 20000 : 10000);
  const e2eFlag = isE2E === true || isE2E === 'true';
  if (replyTo === '' || !isObjectIdString(replyTo)) replyTo = undefined;
  if (!Array.isArray(mentions)) mentions = undefined;
  if (!Array.isArray(attachmentIds)) attachmentIds = undefined;
  // Opaque E2E media envelopes — store only, never interpret
  if (!Array.isArray(e2eMetas)) e2eMetas = undefined;
  if (!Array.isArray(mediaTypes)) mediaTypes = undefined;

  const allowedMediaClass = new Set(['image', 'video', 'audio', 'document', 'voice']);
  const normalizeMediaClass = (raw: unknown): string | undefined => {
    const s = String(raw || '').toLowerCase().trim();
    if (allowedMediaClass.has(s)) return s;
    if (s.startsWith('image/')) return 'image';
    if (s.startsWith('video/')) return 'video';
    if (s.startsWith('audio/')) return s.includes('webm') || s.includes('ogg') ? 'voice' : 'audio';
    return undefined;
  };

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
      isE2E: !!d.isE2E,
      e2eMeta: d.e2eMeta,
      mediaClass: d.mediaClass,
    }));
  }

  if (req.files && Array.isArray(req.files) && req.files.length) {
    const { fileMatchesMime, unlinkQuiet } = await import('../utils/fileMagic');
    const { isValidE2EMediaMeta } = await import('../utils/e2eMediaMeta');
    const files = req.files as Express.Multer.File[];

    // Fail-closed: when client claims isE2E, every file must be opaque ciphertext + meta.
    // Never accept plaintext images/docs under an E2E message (downgrade / mixed mode).
    if (e2eFlag) {
      if (!Array.isArray(e2eMetas) || e2eMetas.length !== files.length) {
        for (const f of files) unlinkQuiet(f.path);
        throw new AppError(
          'E2E messages require e2eMetas for every attachment',
          400,
          'E2E_MEDIA_META_REQUIRED'
        );
      }
      for (let i = 0; i < files.length; i++) {
        const metaRaw = String(e2eMetas[i] || '');
        if (!isValidE2EMediaMeta(metaRaw)) {
          for (const f of files) unlinkQuiet(f.path);
          throw new AppError(
            'Invalid E2E media envelope',
            400,
            'E2E_MEDIA_META_INVALID'
          );
        }
        if (files[i].mimetype !== 'application/octet-stream') {
          for (const f of files) unlinkQuiet(f.path);
          throw new AppError(
            'E2E attachments must be application/octet-stream ciphertext',
            400,
            'E2E_MEDIA_PLAINTEXT_REJECTED'
          );
        }
      }
    }

    let fileIndex = 0;
    for (const file of files) {
      const metaRaw =
        Array.isArray(e2eMetas) && typeof e2eMetas[fileIndex] === 'string'
          ? String(e2eMetas[fileIndex]).slice(0, 4096)
          : '';
      const hasValidMeta = isValidE2EMediaMeta(metaRaw);
      // E2E only when envelope is valid — never soft-promote plaintext with a flag
      const isE2EFile =
        hasValidMeta && file.mimetype === 'application/octet-stream';

      // Reject claiming E2E meta on non-ciphertext
      if (hasValidMeta && file.mimetype !== 'application/octet-stream') {
        unlinkQuiet(file.path);
        throw new AppError(
          'E2E media meta requires opaque ciphertext upload',
          400,
          'E2E_MEDIA_PLAINTEXT_REJECTED'
        );
      }

      if (!fileMatchesMime(file.path, file.mimetype)) {
        unlinkQuiet(file.path);
        throw new AppError(
          `File content does not match declared type (${file.mimetype})`,
          400,
          'INVALID_FILE_CONTENT'
        );
      }

      // E2E: never strip EXIF / never trust client original name for storage
      // mediaClass is a non-authoritative UI hint only (real mime sealed in e2eMeta)
      const mediaClass = isE2EFile
        ? normalizeMediaClass(
            Array.isArray(mediaTypes) ? mediaTypes[fileIndex] : undefined
          )
        : undefined;
      const url = toRelativeMediaPath(fileUrl(file.filename, file.mimetype));
      const originalName = isE2EFile
        ? 'encrypted.pme2'
        : sanitizeFilename(file.originalname);
      const att = await Attachment.create({
        uploader: req.userId,
        filename: file.filename,
        originalName,
        mimeType: isE2EFile ? 'application/octet-stream' : file.mimetype,
        size: file.size,
        url,
        conversation: conv._id,
        isE2E: isE2EFile,
        e2eMeta: isE2EFile ? metaRaw : undefined,
        mediaClass,
      });
      attachments.push({
        filename: att.filename,
        originalName: att.originalName,
        mimeType: att.mimeType,
        size: att.size,
        url: att.url,
        isE2E: !!att.isE2E,
        e2eMeta: att.e2eMeta,
        mediaClass: att.mediaClass,
      });
      fileIndex += 1;
    }
  }

  if (!content?.trim() && attachments.length === 0) {
    throw new AppError('Message cannot be empty', 400);
  }

  let msgType = type || 'text';
  if (attachments.length && (msgType === 'text' || !msgType)) {
    // Prefer client-declared type / mediaClass for E2E (mime is opaque)
    const first = attachments[0];
    const cls = String(first.mediaClass || '');
    if (cls === 'image' || cls === 'video' || cls === 'audio' || cls === 'voice' || cls === 'document') {
      msgType = cls;
    } else {
      const mime = String(first.mimeType || '');
      if (mime.startsWith('image/')) msgType = 'image';
      else if (mime.startsWith('video/')) msgType = 'video';
      else if (mime.startsWith('audio/'))
        msgType = mime.includes('webm') || mime.includes('ogg') ? 'voice' : 'audio';
      else if (mime === 'application/octet-stream' && e2eFlag) msgType = 'document';
      else msgType = 'document';
    }
  }

  // View once: only pure image messages (no mixed video/docs)
  // For E2E, trust mediaClass / declared type (ciphertext has no image magic)
  const wantViewOnce = viewOnce === true || viewOnce === 'true' || viewOnce === '1';
  const allImages =
    attachments.length > 0 &&
    attachments.every((a) => {
      if (String(a.mediaClass || '') === 'image') return true;
      return String(a.mimeType || '').startsWith('image/');
    });
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
      await Notification.insertMany(notifDocs, { ordered: false }).catch((err) => {
        // Non-fatal for delivery, but silently dropping these hid a real class
        // of "notifications stopped working" bugs.
        logger.warn('Notification insert failed', {
          conversationId: String(conv._id),
          count: notifDocs.length,
          message: err instanceof Error ? err.message : String(err),
        });
      });
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

  // Toggle atomically. The previous read-modify-write rewrote the whole
  // reactions array, so two people reacting to the same message at once lost
  // one of the reactions — routine in an active group chat.
  const uid = new Types.ObjectId(req.userId);
  const MAX_REACTION_TYPES = 20;

  const removed = await Message.updateOne(
    { _id: message._id, reactions: { $elemMatch: { emoji, users: uid } } },
    { $pull: { 'reactions.$.users': uid } }
  );

  if (removed.modifiedCount > 0) {
    // Drop the bucket if that was the last user for this emoji
    await Message.updateOne(
      { _id: message._id },
      { $pull: { reactions: { users: { $size: 0 } } } }
    );
  } else {
    const added = await Message.updateOne(
      { _id: message._id, 'reactions.emoji': emoji },
      { $addToSet: { 'reactions.$.users': uid } }
    );

    if (added.matchedCount === 0) {
      // No bucket for this emoji yet — create one, capped by a positional
      // existence check so the limit is enforced without reading first.
      const created = await Message.updateOne(
        {
          _id: message._id,
          'reactions.emoji': { $ne: emoji },
          [`reactions.${MAX_REACTION_TYPES - 1}`]: { $exists: false },
        },
        { $push: { reactions: { emoji, users: [uid] } } }
      );
      if (created.matchedCount === 0) {
        // Either the cap is hit or a concurrent request just created the
        // bucket. Only the former is an error.
        const current = await Message.findById(message._id).select('reactions').lean();
        const hasEmoji = (current?.reactions || []).some((r) => r.emoji === emoji);
        if (!hasEmoji) throw new AppError('Too many reaction types', 400);
        await Message.updateOne(
          { _id: message._id, 'reactions.emoji': emoji },
          { $addToSet: { 'reactions.$.users': uid } }
        );
      }
    }
  }

  const updated = await Message.findById(message._id).populate(messagePopulatePaths);
  if (!updated) throw new AppError('Message not found', 404);

  const formatted = formatMessage(updated);
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
  // Atomically claim the single view. A read-then-write here let two concurrent
  // requests both pass the "already viewed" check and both receive the media,
  // which defeats the view-once guarantee.
  const claim = await Message.updateOne(
    { _id: message._id, viewOnceViewedBy: { $ne: new Types.ObjectId(uid) } },
    { $addToSet: { viewOnceViewedBy: new Types.ObjectId(uid) } }
  );

  if (claim.modifiedCount === 0) {
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

  // Reflect the claim on the in-memory doc used for formatting below
  message.viewOnceViewedBy = [
    ...(message.viewOnceViewedBy || []),
    new Types.ObjectId(uid),
  ];
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
        isE2E: a.isE2E,
        e2eMeta: a.e2eMeta,
        mediaClass: a.mediaClass,
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

  // E2E ciphertext + media keys are bound to the source conversation key;
  // forwarding would leave recipients unable to decrypt.
  if (original.isE2E || (original.attachments || []).some((a) => a.isE2E)) {
    throw new AppError(
      'End-to-end encrypted messages cannot be forwarded',
      400,
      'E2E_NO_FORWARD'
    );
  }

  const { conversationIds } = req.body;
  const ids = (conversationIds || []).filter(isObjectIdString).slice(0, 20);
  const created = [];

  const { isEitherBlocked } = await import('./moderation.controller');

  for (const cid of ids) {
    const target = await ensureConversationParticipant(cid, req.userId!);

    // Forwarding must respect blocks the same way sendMessage does — otherwise
    // it is a bypass for delivering messages to someone who blocked you.
    if (target.type === 'direct') {
      const other = target.participants.find((p) => participantUserId(p) !== req.userId);
      const otherId = other ? participantUserId(other) : '';
      if (otherId && (await isEitherBlocked(req.userId!, otherId))) continue;
    }

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

    // Same bookkeeping as a normal send: bump recipients' unread badges and
    // re-surface chats they had hidden with "delete for me". Previously a
    // forwarded message updated only lastMessage, so it arrived with no badge.
    await Conversation.updateOne(
      { _id: cid },
      {
        $set: { lastMessage: msg._id, lastMessageAt: msg.createdAt },
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

    await msg.populate(messagePopulatePaths);
    const formatted = formatMessage(msg);
    created.push(formatted);
    try {
      const io = getIO();
      io.to(`conversation:${cid}`).emit('message:new', formatted);
      // Forwards were silent before: no per-user notification event meant no
      // toast/sound/badge for recipients who did not have the chat open.
      for (const p of target.participants) {
        const pid = participantUserId(p);
        if (pid === req.userId || p.isMuted) continue;
        io.to(`user:${pid}`).emit('notification:message', {
          conversationId: String(cid),
          message: formatted,
        });
      }
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

  // Toggle atomically. Reading the array, mutating it and saving the whole
  // document loses concurrent stars from another device (last write wins).
  const unstarred = await User.updateOne(
    { _id: req.userId, starredMessages: message._id },
    { $pull: { starredMessages: message._id } }
  );

  let starred = false;
  if (unstarred.modifiedCount === 0) {
    const added = await User.updateOne(
      { _id: req.userId },
      // $slice keeps the list bounded without a read-modify-write
      { $push: { starredMessages: { $each: [message._id], $slice: -500 } } }
    );
    if (added.matchedCount === 0) throw new AppError('User not found', 404);
    starred = true;
  }

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
