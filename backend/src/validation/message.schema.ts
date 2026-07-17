import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    return v === 'true' || v === '1';
  });

export const sendMessageSchema = z.object({
  // E2E ciphertext needs more room than plaintext
  content: z.string().max(20000).optional().default(''),
  type: z
    .enum(['text', 'image', 'video', 'audio', 'document', 'voice'])
    .optional()
    .default('text'),
  replyTo: z.string().optional().or(z.literal('')),
  mentions: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      if (Array.isArray(v)) return v;
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }),
  attachmentIds: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      if (Array.isArray(v)) return v;
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }),
  clientId: z.string().optional(),
  /** View-once photo (image messages only) */
  viewOnce: boolish,
  /** Client-side end-to-end encrypted content */
  isE2E: boolish,
});

export const editMessageSchema = z.object({
  content: z.string().min(1).max(20000),
  isE2E: boolish,
});

export const reactMessageSchema = z.object({
  emoji: z.string().min(1).max(32),
});

export const forwardMessageSchema = z.object({
  conversationIds: z.array(z.string()).min(1).max(20),
});

export const searchMessagesSchema = z.object({
  q: z.string().min(1).max(200),
  conversationId: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).optional().default(30),
  cursor: z.string().optional(),
});

export const getMessagesSchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional().default(40),
  before: z.string().optional(),
  after: z.string().optional(),
});
