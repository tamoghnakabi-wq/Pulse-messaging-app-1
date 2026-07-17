import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/AppError';
import logger from '../utils/logger';
import config from '../config';

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError('Route not found', 404, 'NOT_FOUND'));
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        message: err.message,
        code: err.code || 'ERROR',
      },
    });
    return;
  }

  // Mongoose duplicate key
  if ((err as { code?: number }).code === 11000) {
    const field = Object.keys((err as { keyPattern?: Record<string, number> }).keyPattern || {})[0];
    res.status(409).json({
      success: false,
      error: {
        message: `${field || 'Field'} already exists`,
        code: 'DUPLICATE',
      },
    });
    return;
  }

  // Invalid ObjectId / bad params
  if (err.name === 'CastError') {
    res.status(400).json({
      success: false,
      error: { message: 'Invalid id', code: 'INVALID_ID' },
    });
    return;
  }

  // Multer upload errors
  if (err.name === 'MulterError') {
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        success: false,
        error: { message: 'File too large', code: 'FILE_TOO_LARGE' },
      });
      return;
    }
    res.status(400).json({
      success: false,
      error: { message: err.message || 'Upload failed', code: 'UPLOAD_ERROR' },
    });
    return;
  }

  logger.error('Unhandled error', { message: err.message, stack: err.stack });

  res.status(500).json({
    success: false,
    error: {
      message: config.env === 'production' ? 'Internal server error' : err.message,
      code: 'INTERNAL_ERROR',
    },
  });
}
