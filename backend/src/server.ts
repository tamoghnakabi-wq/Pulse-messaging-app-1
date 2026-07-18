import http from 'http';
import app from './app';
import config from './config';
import { connectDatabase } from './config/database';
import { initSocket, resetPresenceOnBoot } from './socket';
import logger from './utils/logger';
import {
  startGameScheduler,
  stopGameScheduler,
} from './services/game/gameScheduler';

async function bootstrap() {
  try {
    await connectDatabase();

    // Anyone left "online" from a previous process is actually offline
    await resetPresenceOnBoot();

    const server = http.createServer(app);
    initSocket(server);

    // Trusted in-process sweep: timed rounds + abandoned stats leases
    startGameScheduler(7_000);

    server.listen(config.port, '0.0.0.0', () => {
      logger.info(`Pulse API running on port ${config.port}`);
      logger.info(`Environment: ${config.env}`);
      logger.info(`Client URL: ${config.clientUrl}`);
      logger.info(`API URL: ${config.apiUrl}`);
      logger.info(`CORS origins: ${config.corsOrigins.join(', ')}`);
    });

    const shutdown = (signal: string) => {
      logger.info(`${signal} received, shutting down...`);
      stopGameScheduler();
      server.close(() => {
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
}

bootstrap();
