import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { AppError } from '../utils/AppError';

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const storage = multer.diskStorage({
  destination: (_req, file, cb) => {
    let sub = 'misc';
    if (file.mimetype === 'application/octet-stream') sub = 'documents';
    else if (file.mimetype.startsWith('image/')) sub = 'images';
    else if (file.mimetype.startsWith('video/')) sub = 'videos';
    else if (file.mimetype.startsWith('audio/')) sub = 'audio';
    else sub = 'documents';
    const dest = path.join(config.uploadDir, sub);
    ensureDir(dest);
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    // E2E: force .pme2 so path never leaks original extension
    if (file.mimetype === 'application/octet-stream') {
      cb(null, `${uuidv4()}.pme2`);
      return;
    }
    const rawExt = path.extname(file.originalname).toLowerCase() || '';
    const ext = /^(\.[a-z0-9]{1,10})$/.test(rawExt) ? rawExt : '';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const allowedMimes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // SVG intentionally excluded (XSS vector when served inline)
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'text/plain',
  'text/csv',
  // Client-side E2E media ciphertext (PME2 envelope) — no plaintext mime on server
  'application/octet-stream',
]);

const dangerousExt = new Set([
  '.html',
  '.htm',
  '.svg',
  '.js',
  '.mjs',
  '.php',
  '.exe',
  '.sh',
  '.bat',
  '.cmd',
]);

function fileFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
): void {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (dangerousExt.has(ext)) {
    cb(new AppError(`File extension not allowed: ${ext}`, 400, 'INVALID_FILE_TYPE'));
    return;
  }
  // E2E ciphertext uses .pme2 or no extension + octet-stream
  if (file.mimetype === 'application/octet-stream') {
    if (ext && ext !== '.pme2' && ext !== '.bin') {
      cb(new AppError(`Encrypted attachment extension not allowed: ${ext}`, 400, 'INVALID_FILE_TYPE'));
      return;
    }
    cb(null, true);
    return;
  }
  if (allowedMimes.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError(`File type not allowed: ${file.mimetype}`, 400, 'INVALID_FILE_TYPE'));
  }
}

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.maxFileSize,
    files: 10,
  },
});

export function fileUrl(filename: string, mimetype: string): string {
  let sub = 'misc';
  // E2E ciphertext is opaque — store under documents (no type leak via path)
  if (mimetype === 'application/octet-stream') sub = 'documents';
  else if (mimetype.startsWith('image/')) sub = 'images';
  else if (mimetype.startsWith('video/')) sub = 'videos';
  else if (mimetype.startsWith('audio/')) sub = 'audio';
  else sub = 'documents';
  return `/uploads/${sub}/${filename}`;
}
