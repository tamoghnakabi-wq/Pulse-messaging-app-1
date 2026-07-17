import { z } from 'zod';

export const createDirectSchema = z.object({
  userId: z.string().min(1),
});

export const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  participantIds: z.array(z.string()).min(1).max(100),
});

export const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

export const addParticipantsSchema = z.object({
  userIds: z.array(z.string()).min(1).max(50),
});

export const updateParticipantRoleSchema = z.object({
  role: z.enum(['member', 'admin']),
});

export const conversationPrefsSchema = z.object({
  isPinned: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
  isMuted: z.boolean().optional(),
});
