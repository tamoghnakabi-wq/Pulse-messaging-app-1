import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config';

export interface AccessTokenPayload {
  userId: string;
  sessionId: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  userId: string;
  sessionId: string;
  type: 'refresh';
}

const JWT_ISS = 'pulse-api';
const JWT_AUD = 'pulse-client';

export function signAccessToken(userId: string, sessionId: string): string {
  const payload: AccessTokenPayload = { userId, sessionId, type: 'access' };
  return jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpires as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: JWT_ISS,
    audience: JWT_AUD,
  });
}

export function signRefreshToken(userId: string, sessionId: string): string {
  const payload: RefreshTokenPayload = { userId, sessionId, type: 'refresh' };
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpires as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: JWT_ISS,
    audience: JWT_AUD,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, config.jwt.accessSecret, {
    algorithms: ['HS256'],
    issuer: JWT_ISS,
    audience: JWT_AUD,
  }) as AccessTokenPayload;
  if (decoded.type !== 'access') throw new Error('Invalid token type');
  return decoded;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, config.jwt.refreshSecret, {
    algorithms: ['HS256'],
    issuer: JWT_ISS,
    audience: JWT_AUD,
  }) as RefreshTokenPayload;
  if (decoded.type !== 'refresh') throw new Error('Invalid token type');
  return decoded;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function generateNumericCode(length = 6): string {
  const max = 10 ** length;
  const num = crypto.randomInt(0, max);
  return num.toString().padStart(length, '0');
}
