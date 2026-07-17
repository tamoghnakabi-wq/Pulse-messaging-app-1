import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { Notification } from '../models/Notification';
import asyncHandler from '../utils/asyncHandler';

export const listNotifications = asyncHandler(async (req: AuthRequest, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '40'), 10) || 40, 100);
  const unreadOnly = req.query.unread === 'true';

  const query: Record<string, unknown> = { user: req.userId };
  if (unreadOnly) query.isRead = false;

  const notifications = await Notification.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('actor', 'username displayName avatar')
    .populate('conversation', 'name type avatar');

  const unreadCount = await Notification.countDocuments({
    user: req.userId,
    isRead: false,
  });

  res.json({
    success: true,
    data: {
      notifications: notifications.map((n) => ({
        id: n._id.toString(),
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data,
        isRead: n.isRead,
        actor: n.actor,
        conversation: n.conversation,
        message: n.message,
        createdAt: n.createdAt,
      })),
      unreadCount,
    },
  });
});

export const markNotificationRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  await Notification.updateOne(
    { _id: req.params.id, user: req.userId },
    { isRead: true, readAt: new Date() }
  );
  res.json({ success: true, data: { message: 'Marked as read' } });
});

export const markAllRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  await Notification.updateMany(
    { user: req.userId, isRead: false },
    { isRead: true, readAt: new Date() }
  );
  res.json({ success: true, data: { message: 'All marked as read' } });
});
