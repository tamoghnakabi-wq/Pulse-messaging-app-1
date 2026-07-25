import http from 'http';
import app from './app';
import config from './config';
import { connectDatabase } from './config/database';
import {
  initSocket,
  resetPresenceOnBoot,
  initCluster,
  shutdownCluster,
  getLocalOnlineUserIds,
} from './socket';
import logger from './utils/logger';
import { checkMediaIntegrity } from './utils/mediaIntegrity';
import {
  startGameScheduler,
  stopGameScheduler,
} from './services/game/gameScheduler';

async function bootstrap() {
  try {
    await connectDatabase();

    const server = http.createServer(app);
    // Behind a proxy/LB these must exceed the upstream idle timeout, otherwise
    // Node closes a pooled connection mid-request and the client sees a 502.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 70_000;
    const io = initSocket(server);

    // Attach the Redis adapter before accepting connections so no socket joins
    // rooms that only this instance knows about. No-op without REDIS_URL.
    await initCluster(io, getLocalOnlineUserIds);

    // Anyone left "online" from a previous process is actually offline.
    // Must run after initCluster: in clustered mode this is skipped entirely,
    // because peers' users are legitimately still connected.
    await resetPresenceOnBoot();

    // Surface UPLOAD_DIR / database drift loudly rather than as blank avatars.
    // Read-only and non-blocking — never hold up serving for a diagnostic.
    void checkMediaIntegrity().catch(() => undefined);

    // Trusted in-process sweep: timed rounds + abandoned stats leases
    startGameScheduler(7_000);

    server.listen(config.port, '0.0.0.0', () => {
      logger.info(`Pulse API running on port ${config.port}`);
      logger.info(`Environment: ${config.env}`);
      logger.info(`Client URL: ${config.clientUrl}`);
      logger.info(`API URL: ${config.apiUrl}`);
      logger.info(`CORS origins: ${config.corsOrigins.join(', ')}`);
    });

    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`${signal} received, shutting down...`);
      stopGameScheduler();
      // Drop our presence key so peers stop counting this instance's users
      void shutdownCluster();
      server.close(() => {
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // A rejected promise with no handler would otherwise terminate the process
    // silently on Node 20. Log it and keep serving — one bad request must not
    // take down every connected socket.
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled promise rejection', {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });

    // An uncaught exception leaves the process in an undefined state: log it,
    // then exit so the supervisor restarts a clean one.
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception — exiting', {
        message: err.message,
        stack: err.stack,
      });
      shutdown('uncaughtException');
    });
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
}

bootstrap();
