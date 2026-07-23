import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import asyncHandler from '../utils/asyncHandler';
import { pollService } from '../services/poll/poll.service';

export const createPoll = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { conversationId, question, options, allowMultiple, isAnonymous, closesAt } =
    req.body;
  const result = await pollService.create(req.userId!, conversationId, {
    question,
    options,
    allowMultiple,
    isAnonymous,
    closesAt,
  });
  res.status(201).json({ success: true, data: result });
});

export const getPoll = asyncHandler(async (req: AuthRequest, res: Response) => {
  const poll = await pollService.get(req.userId!, req.params.id);
  res.json({ success: true, data: { poll } });
});

export const votePoll = asyncHandler(async (req: AuthRequest, res: Response) => {
  const optionIds = Array.isArray(req.body.optionIds)
    ? req.body.optionIds
    : req.body.optionId
      ? [req.body.optionId]
      : [];
  const poll = await pollService.vote(req.userId!, req.params.id, optionIds);
  res.json({ success: true, data: { poll } });
});

export const closePoll = asyncHandler(async (req: AuthRequest, res: Response) => {
  const poll = await pollService.close(req.userId!, req.params.id);
  res.json({ success: true, data: { poll } });
});
