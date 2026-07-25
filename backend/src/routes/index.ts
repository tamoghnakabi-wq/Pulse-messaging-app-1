import { Router } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { renderMetrics } from '../utils/metrics';
import { getOnlineUserIds } from '../socket/presence';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import conversationRoutes from './conversation.routes';
import messageRoutes from './message.routes';
import uploadRoutes from './upload.routes';
import notificationRoutes from './notification.routes';
import callRoutes from './call.routes';
import gameRoutes from './game.routes';
import pollRoutes from './poll.routes';

const router = Router();

/**
 * Liveness — cheap, always 200 while the process is serving. Load balancers use
 * this to decide whether to restart the container.
 */
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      service: 'pulse-api',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
});

/**
 * Readiness — reports whether dependencies are usable, so a pod with a dead DB
 * connection is pulled out of rotation instead of serving 500s.
 */
router.get('/ready', (_req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({
    success: dbConnected,
    data: {
      status: dbConnected ? 'ready' : 'degraded',
      database: dbConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    },
  });
});

/**
 * Prometheus metrics.
 *
 * Requires METRICS_TOKEN in production — the payload exposes traffic shape,
 * memory and online-user counts, which is not public information. Open in
 * development so local scraping needs no setup.
 */
router.get('/metrics', (req, res) => {
  const expected = process.env.METRICS_TOKEN || '';
  if (process.env.NODE_ENV === 'production' || expected) {
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    const okToken =
      expected.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!okToken) {
      res.status(404).json({
        success: false,
        error: { message: 'Route not found', code: 'NOT_FOUND' },
      });
      return;
    }
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(
    renderMetrics({
      dbConnected: mongoose.connection.readyState === 1,
      onlineUsers: getOnlineUserIds().length,
    })
  );
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/conversations', conversationRoutes);
router.use('/messages', messageRoutes);
router.use('/uploads', uploadRoutes);
router.use('/notifications', notificationRoutes);
router.use('/calls', callRoutes);
router.use('/games', gameRoutes);
router.use('/polls', pollRoutes);

export default router;
