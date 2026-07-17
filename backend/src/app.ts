import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import fs from 'fs';
import config from './config';
import routes from './routes';
import { notFound, errorHandler } from './middleware/errorHandler';
import { verifyUploadSignature } from './utils/mediaSign';

// xss-clean has no types

const xss = require('xss-clean');

const app = express();

// Trust proxy (needed for ngrok / reverse proxies)
app.set('trust proxy', 1);

// Auth API must never be HTTP-cached (stale empty filter lists via 304)
app.set('etag', false);
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

// Security
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // API is JSON-only; tight CSP for any accidental HTML error pages
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS when served over HTTPS (proxied production)
    hsts:
      config.env === 'production'
        ? { maxAge: 31536000, includeSubDomains: true, preload: false }
        : false,
    noSniff: true,
    frameguard: { action: 'deny' },
    xssFilter: true,
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  })
);
// Extra clickjacking / MIME / permissions hardening
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});
app.use(mongoSanitize());
app.use(xss());
app.use(hpp());

// CORS — exact allowlist; flexible only in development
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const isDev = config.env === 'development';
      if (config.corsOrigins.includes('*')) {
        // Never reflect * with credentials in production
        if (config.env === 'production') {
          return callback(null, false);
        }
        return callback(null, true);
      }
      if (config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Dev: localhost + any ngrok (tunnels rotate)
      if (
        isDev &&
        (origin.includes('localhost') ||
          origin.includes('127.0.0.1') ||
          origin.includes('ngrok'))
      ) {
        return callback(null, true);
      }
      // Production: only exact CORS_ORIGINS (no substring ngrok match)
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'ngrok-skip-browser-warning',
    ],
  })
);

app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

if (config.env !== 'test') {
  app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
}

// Global API rate limiting (IP-based).
// Dev + Cloudflare tunnels: many clients share one IP and E2E setup is chatty —
// use a much higher ceiling so normal use never looks like "Failed to load messages".
const isDev = config.env === 'development';
const limiter = rateLimit({
  windowMs: isDev ? 60_000 : config.rateLimit.windowMs,
  max: isDev ? Math.max(config.rateLimit.max, 2000) : config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
  // Health checks shouldn't burn budget
  skip: (req) => req.path === '/health' || req.path === '/api/health',
  message: {
    success: false,
    error: {
      message: 'Too many requests — slow down and try again',
      code: 'RATE_LIMIT',
    },
  },
});
app.use('/api', limiter);

// Ensure upload dir exists
if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

// Static uploads — HMAC-signed URLs only.
// IMPORTANT: Do NOT allow bare Bearer access (was a media IDOR: any logged-in user
// could fetch any /uploads path). Clients must use ?exp=&sig= from the API.
app.use('/uploads', (req, res, next) => {
  try {
    // req.path here is relative to the mount (e.g. /images/uuid.jpg)
    const relative = path.posix.normalize(req.path.startsWith('/') ? req.path : `/${req.path}`);
    if (
      relative.includes('..') ||
      relative.includes('\\') ||
      relative.includes('\0') ||
      relative === '/' ||
      relative.startsWith('/.')
    ) {
      res.status(400).json({
        success: false,
        error: { message: 'Invalid media path', code: 'MEDIA_BAD_PATH' },
      });
      return;
    }

    const pathname = `/uploads${relative}`;
    const exp = typeof req.query.exp === 'string' ? req.query.exp : undefined;
    const sig = typeof req.query.sig === 'string' ? req.query.sig : undefined;

    if (!verifyUploadSignature(pathname, exp, sig)) {
      res.status(401).json({
        success: false,
        error: { message: 'Unauthorized media access', code: 'MEDIA_UNAUTHORIZED' },
      });
      return;
    }
    next();
  } catch {
    res.status(401).json({
      success: false,
      error: { message: 'Unauthorized media access', code: 'MEDIA_UNAUTHORIZED' },
    });
  }
});

app.use(
  '/uploads',
  express.static(config.uploadDir, {
    // Content-addressed UUID filenames — safe to cache longer (signed URL still gates access)
    maxAge: '7d',
    immutable: true,
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      // Images/media: long private cache; HTML/JS still forced download
      const lower = filePath.toLowerCase();
      if (
        lower.endsWith('.html') ||
        lower.endsWith('.svg') ||
        lower.endsWith('.js') ||
        lower.endsWith('.mjs') ||
        lower.endsWith('.xml')
      ) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', 'attachment');
        res.setHeader('Content-Type', 'application/octet-stream');
      } else {
        res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
      }
    },
  })
);

// API routes
app.use('/api', routes);

// Health at root for probes
app.get('/', (_req, res) => {
  res.json({
    success: true,
    data: { name: 'Pulse API', version: '1.0.0', docs: '/api/health' },
  });
});

app.use(notFound);
app.use(errorHandler);

export default app;
