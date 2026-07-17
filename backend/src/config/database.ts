import mongoose from 'mongoose';
import config from './index';
import logger from '../utils/logger';

let memoryServer: { stop: () => Promise<boolean>; getUri: () => string } | null = null;

export async function connectDatabase(): Promise<void> {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    logger.info('MongoDB connected');
  });

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB error', err.message);
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  const uri = config.mongodbUri;

  // Retry real MongoDB first — never silently lose data by jumping to memory DB
  const maxAttempts = config.env === 'production' ? 5 : 10;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
        // Connection pool for concurrent API + socket workers (1k online class)
        maxPoolSize: config.env === 'production' ? 50 : 20,
        minPoolSize: config.env === 'production' ? 5 : 1,
        maxIdleTimeMS: 30_000,
      });
      logger.info(`MongoDB connected (${uri.replace(/\/\/.*@/, '//***@')})`);

      // Fix absolute ngrok media URLs → relative (safe, non-destructive)
      try {
        const { migrateMediaUrlsToRelative } = await import('../utils/migrateMediaUrls');
        await migrateMediaUrlsToRelative();
      } catch (migErr) {
        logger.warn('Media URL migration skipped', migErr);
      }
      return;
    } catch (err) {
      lastErr = err;
      logger.warn(
        `MongoDB connect attempt ${attempt}/${maxAttempts} failed: ${(err as Error).message}`
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  if (config.env === 'production') {
    throw lastErr;
  }

  // Dev-only ephemeral fallback — WARN loudly (data will NOT persist)
  logger.error(
    '⚠️  Falling back to in-memory MongoDB — data will be LOST on restart. Start Docker MongoDB or set MONGODB_URI.'
  );
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create({
      instance: { dbName: 'pulse' },
    });
    const memUri = memoryServer.getUri();
    await mongoose.connect(memUri);
    logger.info(`MongoDB Memory Server ready at ${memUri}`);
  } catch (memErr) {
    logger.error(
      'Failed to start MongoDB Memory Server. Install Docker MongoDB or set MONGODB_URI (Atlas).',
      memErr
    );
    throw memErr;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

export default connectDatabase;
