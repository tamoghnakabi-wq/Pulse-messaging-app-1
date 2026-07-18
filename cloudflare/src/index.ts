/**
 * Pulse API on Cloudflare Containers
 *
 * Pure Workers isolates cannot run Express + Socket.IO + Mongoose as-is.
 * This Worker routes HTTP + WebSocket traffic into a single Docker container
 * that runs the real backend (backend/Dockerfile). Deploy with:
 *
 *   npx wrangler deploy
 *
 * Requires Workers Paid (Containers) + MongoDB Atlas (or other external Mongo).
 */
import { Container, getContainer } from '@cloudflare/containers';

/** Single sticky instance name — Socket.IO + in-process presence need one process. */
const PULSE_INSTANCE = 'pulse-api';

export interface Env {
  PULSE_API: DurableObjectNamespace<PulseApiContainer>;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  MONGODB_URI: string;
  CLIENT_URL: string;
  API_URL: string;
  CORS_ORIGINS: string;
  MEDIA_SIGNING_SECRET?: string;
}

/**
 * Long-running Pulse API container (Express + Socket.IO + game scheduler).
 * Secrets / vars are Worker bindings, injected as process env in the container.
 */
export class PulseApiContainer extends Container<Env> {
  defaultPort = 8080;
  /** Keep warm for realtime; sleeps only after long idle (no HTTP/WS activity). */
  sleepAfter = '24h';
  enableInternet = true;
  /** Health path used while waiting for the Node process to listen. */
  pingEndpoint = 'localhost/api/health';

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: 'production',
      PORT: '8080',
      UPLOAD_DIR: '/app/uploads',
      COOKIE_SECURE: 'true',
      GAME_SCHEDULER: '1',
      // Secrets: npx wrangler secret put ...
      JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET ?? '',
      JWT_REFRESH_SECRET: env.JWT_REFRESH_SECRET ?? '',
      MONGODB_URI: env.MONGODB_URI ?? '',
      // Non-secret vars (wrangler.jsonc vars)
      CLIENT_URL: env.CLIENT_URL ?? '',
      API_URL: env.API_URL ?? '',
      CORS_ORIGINS: env.CORS_ORIGINS || env.CLIENT_URL || '',
      MEDIA_SIGNING_SECRET: env.MEDIA_SIGNING_SECRET ?? '',
    };
  }

  override onStart(): void {
    console.log('[pulse-api] container started');
  }

  override onStop(params: { exitCode: number; reason: string }): void {
    console.log('[pulse-api] container stopped', params);
  }

  override onError(error: unknown): void {
    console.error('[pulse-api] container error', error);
    throw error;
  }
}

export default {
  async fetch(request: Request, workerEnv: Env): Promise<Response> {
    const url = new URL(request.url);

    // Lightweight Worker-level probe (does not boot the container).
    if (url.pathname === '/__worker_health') {
      return Response.json({
        ok: true,
        service: 'pulse-api-worker',
        routes: 'container',
      });
    }

    // Everything else (REST, uploads, Socket.IO) → single sticky container.
    // WebSockets are supported via Container.fetch (see CF websocket example).
    const container = getContainer(workerEnv.PULSE_API, PULSE_INSTANCE);
    return container.fetch(request);
  },
};
