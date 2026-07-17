import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { listCallHistoryForUser } from '../services/call/callLog.service';

export const getCallHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
  const items = await listCallHistoryForUser(req.userId!, limit);
  res.json({ success: true, data: { items } });
});
