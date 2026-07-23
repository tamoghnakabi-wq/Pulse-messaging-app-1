import { z } from 'zod';

export const createPollSchema = z.object({
  conversationId: z.string().min(1),
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).min(2).max(12),
  allowMultiple: z.boolean().optional(),
  isAnonymous: z.boolean().optional(),
  closesAt: z.union([z.string(), z.null()]).optional(),
});

export const votePollSchema = z.object({
  optionIds: z.array(z.string().min(1)).min(1).max(12).optional(),
  optionId: z.string().min(1).optional(),
});
