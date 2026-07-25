/**
 * Request correlation + HTTP metrics.
 *
 * Runs first in the chain so every downstream log line carries a request id and
 * every response is timed, including ones short-circuited by rate limiting.
 */
import { Request, Response, NextFunction } from 'express';
import { normalizeRequestId, runWithRequestId } from '../utils/requestContext';
import { recordHttpRequest } from '../utils/metrics';
import logger from '../utils/logger';

/** Slow-request threshold; override with SLOW_REQUEST_MS. */
const SLOW_MS = parseInt(process.env.SLOW_REQUEST_MS || '', 10) || 1500;

/**
 * Prefer Express's matched route pattern over the raw URL so metrics stay
 * low-cardinality (`/api/messages/:id`, not one series per message id).
 * Falls back to a conservative scrub for unmatched routes (404s).
 */
function routeTemplate(req: Request): string {
  const base = req.baseUrl || '';
  const layer = (req as Request & { route?: { path?: string } }).route?.path;
  if (layer) return `${base}${layer === '/' ? '' : layer}` || '/';
  return (
    (req.path || '/')
      .split('?')[0]
      // Collapse anything id-shaped so unmatched paths cannot explode cardinality
      .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id')
      .replace(/\/\d+(?=\/|$)/g, '/:n')
      .slice(0, 120) || '/'
  );
}

export function observability(req: Request, res: Response, next: NextFunction): void {
  const requestId = normalizeRequestId(req.headers['x-request-id']);
  const start = process.hrtime.bigint();

  // Echo it back so clients and proxies can correlate on their side too
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const route = routeTemplate(req);
    recordHttpRequest(req.method, route, res.statusCode, durationMs);

    if (res.statusCode >= 500) {
      logger.error('Request failed', {
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    } else if (durationMs > SLOW_MS) {
      logger.warn('Slow request', {
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    }
  });

  runWithRequestId(requestId, () => next());
}
