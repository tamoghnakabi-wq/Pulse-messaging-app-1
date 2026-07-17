import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { Attachment } from '../models/Attachment';
import { Conversation } from '../models/Conversation';
import { AppError } from '../utils/AppError';
import asyncHandler from '../utils/asyncHandler';
import { fileUrl } from '../middleware/upload';
import { isObjectIdString, sanitizeFilename } from '../utils/sanitize';
import { toRelativeMediaPath } from '../utils/mediaUrl';
import { fileMatchesMime, unlinkQuiet } from '../utils/fileMagic';
import { signUploadPath } from '../utils/mediaSign';
import { scanUploadedFile } from '../utils/malwareScan';
import { stripImageMetadata } from '../utils/imageSanitize';
import { recordSecurityEvent } from '../utils/securityEvents';

export const uploadFiles = asyncHandler(async (req: AuthRequest, res: Response) => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) throw new AppError('No files uploaded', 400, 'NO_FILE');

  const conversationId = req.body.conversationId;
  let safeConversation: string | undefined;
  if (conversationId && isObjectIdString(conversationId)) {
    // Only attach conversation metadata if caller is a participant
    const ok = await Conversation.exists({
      _id: conversationId,
      'participants.user': req.userId,
      isActive: true,
    });
    if (ok) safeConversation = conversationId;
  }

  const attachments = [];
  for (const file of files) {
    if (!fileMatchesMime(file.path, file.mimetype)) {
      unlinkQuiet(file.path);
      throw new AppError(
        `File content does not match declared type (${file.mimetype})`,
        400,
        'INVALID_FILE_CONTENT'
      );
    }

    // Optional malware scan (MALWARE_SCAN_CMD)
    const scan = await scanUploadedFile(file.path);
    if (!scan.clean) {
      unlinkQuiet(file.path);
      recordSecurityEvent('malware_blocked', {
        userId: req.userId,
        ip: req.ip,
        meta: { reason: scan.reason || 'flagged' },
      });
      throw new AppError(scan.reason || 'File failed security scan', 400, 'MALWARE_BLOCKED');
    }

    // Strip GPS/EXIF from images when practical
    if (file.mimetype.startsWith('image/')) {
      stripImageMetadata(file.path, file.mimetype);
    }

    const url = toRelativeMediaPath(fileUrl(file.filename, file.mimetype));
    const doc = await Attachment.create({
      uploader: req.userId,
      filename: file.filename,
      originalName: sanitizeFilename(file.originalname),
      mimeType: file.mimetype,
      size: file.size,
      url,
      conversation: safeConversation,
    });
    attachments.push({
      id: doc._id.toString(),
      filename: doc.filename,
      originalName: doc.originalName,
      mimeType: doc.mimeType,
      size: doc.size,
      url: signUploadPath(doc.url),
    });
  }

  res.status(201).json({ success: true, data: { attachments } });
});
