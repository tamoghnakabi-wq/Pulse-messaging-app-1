import { Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth';
import { User } from '../models/User';
import { UserReport } from '../models/UserReport';
import { AppError } from '../utils/AppError';
import asyncHandler from '../utils/asyncHandler';
import { recordSecurityEvent } from '../utils/securityEvents';

export const blockUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const targetId = String(req.params.userId || '');
  if (!Types.ObjectId.isValid(targetId) || targetId === req.userId) {
    throw new AppError('Invalid user', 400, 'INVALID_USER');
  }
  const target = await User.findById(targetId).select('_id');
  if (!target) throw new AppError('User not found', 404, 'NOT_FOUND');

  await User.updateOne(
    { _id: req.userId },
    { $addToSet: { blockedUsers: new Types.ObjectId(targetId) } }
  );

  res.json({ success: true, data: { blocked: true, userId: targetId } });
});

export const unblockUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const targetId = String(req.params.userId || '');
  await User.updateOne(
    { _id: req.userId },
    { $pull: { blockedUsers: new Types.ObjectId(targetId) } }
  );
  res.json({ success: true, data: { blocked: false, userId: targetId } });
});

export const listBlocked = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId)
    .select('blockedUsers')
    .populate({ path: 'blockedUsers', select: 'username displayName avatar' });
  if (!user) throw new AppError('User not found', 404);

  const blocked = (user.blockedUsers || []).map((u) => {
    if (u && typeof u === 'object' && '_id' in u) {
      const doc = u as { _id: Types.ObjectId; username?: string; displayName?: string; avatar?: string };
      return {
        id: doc._id.toString(),
        username: doc.username,
        displayName: doc.displayName,
        avatar: doc.avatar || '',
      };
    }
    return { id: String(u) };
  });

  res.json({ success: true, data: { blocked } });
});

export const reportUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  const targetId = String(req.body.userId || req.params.userId || '');
  const reason = String(req.body.reason || 'other');
  const details = String(req.body.details || '').slice(0, 1000);

  if (!Types.ObjectId.isValid(targetId) || targetId === req.userId) {
    throw new AppError('Invalid user', 400, 'INVALID_USER');
  }
  const allowed = ['spam', 'harassment', 'hate', 'scam', 'impersonation', 'other'];
  if (!allowed.includes(reason)) {
    throw new AppError('Invalid reason', 400, 'INVALID_REASON');
  }

  // Rate: max 5 reports per day per reporter
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await UserReport.countDocuments({
    reporter: req.userId,
    createdAt: { $gte: dayAgo },
  });
  if (recent >= 5) {
    throw new AppError('Too many reports today', 429, 'RATE_LIMIT');
  }

  const report = await UserReport.create({
    reporter: req.userId,
    reported: targetId,
    reason,
    details,
  });

  recordSecurityEvent('account_report', {
    userId: req.userId,
    ip: req.ip,
    meta: { reported: targetId, reason },
  });

  res.status(201).json({
    success: true,
    data: { id: report._id.toString(), message: 'Report submitted' },
  });
});

/** Shared helper for message/call gates */
export async function isEitherBlocked(a: string, b: string): Promise<boolean> {
  const [ua, ub] = await Promise.all([
    User.findById(a).select('blockedUsers').lean(),
    User.findById(b).select('blockedUsers').lean(),
  ]);
  const aBlocks = (ua?.blockedUsers || []).some((id) => String(id) === b);
  const bBlocks = (ub?.blockedUsers || []).some((id) => String(id) === a);
  return aBlocks || bBlocks;
}
