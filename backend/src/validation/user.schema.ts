import { z } from 'zod';

export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  bio: z.string().max(300).optional(),
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/)
    .transform((s) => s.toLowerCase())
    .optional(),
});

export const updateSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  chatBackground: z
    .enum([
      'default',
      'pulse',
      'midnight',
      'aurora',
      'sunset',
      'ocean',
      'forest',
      'graphite',
      'dusk',
      'sand',
      'ember',
      'frost',
    ])
    .optional(),
  notifications: z
    .object({
      browser: z.boolean().optional(),
      sound: z.boolean().optional(),
      mentions: z.boolean().optional(),
      messages: z.boolean().optional(),
    })
    .optional(),
  privacy: z
    .object({
      lastSeen: z.enum(['everyone', 'contacts', 'nobody']).optional(),
      readReceipts: z.boolean().optional(),
      profilePhoto: z.enum(['everyone', 'contacts', 'nobody']).optional(),
      showEmail: z.boolean().optional(),
      onlineStatus: z.enum(['everyone', 'contacts', 'nobody']).optional(),
      calls: z.enum(['everyone', 'contacts', 'nobody']).optional(),
    })
    .optional(),
});

export const searchUsersSchema = z.object({
  q: z.string().min(1).max(64),
  limit: z.coerce.number().min(1).max(50).optional().default(20),
});
