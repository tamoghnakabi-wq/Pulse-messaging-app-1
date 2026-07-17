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

  // Optional E2E media flags (parallel arrays) — server stores opaque meta only
  let e2eMetas: string[] | undefined;
  try {
    const raw = req.body.e2eMetas;
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) e2eMetas = parsed.filter((x) => typeof x === 'string').slice(0, 10);
    } else if (Array.isArray(raw)) {
      e2eMetas = raw.filter((x): x is string => typeof x === 'string').slice(0, 10);
    }
  } catch {
    e2eMetas = undefined;
  }

  const attachments = [];
  let fileIndex = 0;
  for (const file of files) {
    if (!fileMatchesMime(file.path, file.mimetype)) {
      unlinkQuiet(file.path);
      throw new AppError(
        `File content does not match declared type (${file.mimetype})`,
        400,
        'INVALID_FILE_CONTENT'
      );
    }

    const metaRaw =
      e2eMetas && typeof e2eMetas[fileIndex] === 'string'
        ? String(e2eMetas[fileIndex]).slice(0, 4096)
        : '';
    const isE2EFile =
      file.mimetype === 'application/octet-stream' &&
      metaRaw.startsWith('e2e-media:');

    // Optional malware scan (MALWARE_SCAN_CMD) — E2E ciphertext is opaque; scan still OK
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

    // Strip GPS/EXIF from plaintext images only — never touch E2E ciphertext
    if (!isE2EFile && file.mimetype.startsWith('image/')) {
      stripImageMetadata(file.path, file.mimetype);
    }

    const url = toRelativeMediaPath(fileUrl(file.filename, file.mimetype));
    const doc = await Attachment.create({
      uploader: req.userId,
      filename: file.filename,
      originalName: isE2EFile ? 'encrypted.pme2' : sanitizeFilename(file.originalname),
      mimeType: isE2EFile ? 'application/octet-stream' : file.mimetype,
      size: file.size,
      url,
      conversation: safeConversation,
      isE2E: isE2EFile,
      e2eMeta: isE2EFile ? metaRaw : undefined,
    });
    attachments.push({
      id: doc._id.toString(),
      filename: doc.filename,
      originalName: doc.originalName,
      mimeType: doc.mimeType,
      size: doc.size,
      url: signUploadPath(doc.url),
      isE2E: !!doc.isE2E,
      e2eMeta: doc.e2eMeta,
    });
    fileIndex += 1;
  }

  res.status(201).json({ success: true, data: { attachments } });
});
