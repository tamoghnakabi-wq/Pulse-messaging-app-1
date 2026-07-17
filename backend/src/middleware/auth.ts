import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/tokens';
import { AppError } from '../utils/AppError';
import { User, IUser } from '../models/User';
import { Session } from '../models/Session';

export interface AuthRequest extends Request {
  user?: IUser;
  userId?: string;
  sessionId?: string;
}

export async function authenticate(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Bearer-only for API auth — avoids CSRF on cookie-authenticated state-changing requests.
    // Cookies remain set for optional same-site helpers; refresh may still use refresh cookie.
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }

    if (!token) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    // Reject obviously malformed tokens early
    if (token.length > 4096 || token.split('.').length !== 3) {
      throw new AppError('Invalid or expired token', 401, 'TOKEN_INVALID');
    }

    const payload = verifyAccessToken(token);
    const session = await Session.findOne({
      _id: payload.sessionId,
      user: payload.userId,
      isValid: true,
    });

    if (!session) {
      throw new AppError('Session expired or invalid', 401, 'SESSION_INVALID');
    }

    if (session.expiresAt && session.expiresAt < new Date()) {
      session.isValid = false;
      await session.save();
      throw new AppError('Session expired', 401, 'SESSION_EXPIRED');
    }

    // Automatic session expiration after inactivity (default 14 days)
    const INACTIVITY_MS =
      parseInt(process.env.SESSION_INACTIVITY_MS || '', 10) || 14 * 24 * 60 * 60 * 1000;
    if (
      session.lastActiveAt &&
      Date.now() - new Date(session.lastActiveAt).getTime() > INACTIVITY_MS
    ) {
      session.isValid = false;
      await session.save();
      throw new AppError('Session expired due to inactivity', 401, 'SESSION_INACTIVE');
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      throw new AppError('User not found', 401, 'USER_NOT_FOUND');
    }

    // Throttle session writes — avoid DB write on every API call
    const STALE_MS = 2 * 60 * 1000;
    if (
      !session.lastActiveAt ||
      Date.now() - new Date(session.lastActiveAt).getTime() > STALE_MS
    ) {
      const ua = String(req.headers['user-agent'] || '').slice(0, 512);
      const ip =
        (req.headers['cf-connecting-ip'] as string) ||
        (typeof req.headers['x-forwarded-for'] === 'string'
          ? req.headers['x-forwarded-for'].split(',')[0]?.trim()
          : '') ||
        req.ip ||
        '';
      Session.updateOne(
        { _id: session._id },
        {
          $set: {
            lastActiveAt: new Date(),
            ...(ua ? { userAgent: ua } : {}),
            ...(ip ? { ip: String(ip).replace(/^::ffff:/, '').slice(0, 64) } : {}),
          },
        }
      ).catch(() => undefined);
    }

    req.user = user;
    req.userId = user._id.toString();
    req.sessionId = session._id.toString();
    next();
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Invalid or expired token', 401, 'TOKEN_INVALID'));
  }
}

export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();
  authenticate(req, res, next);
}
