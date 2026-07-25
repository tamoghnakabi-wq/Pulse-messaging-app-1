import { z } from 'zod';

/**
 * Ids reach `new Types.ObjectId(...)` in the controllers, which throws a raw
 * BSON error on malformed input — a 500 for what is plainly a bad request.
 * Reject the wrong shape at the edge instead.
 */
const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const createDirectSchema = z.object({
  userId: objectId,
});

export const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  participantIds: z.array(objectId).min(1).max(100),
});

export const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

export const addParticipantsSchema = z.object({
  userIds: z.array(objectId).min(1).max(50),
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
