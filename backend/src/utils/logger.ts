import { redactSecrets } from './securityEvents';

type Level = 'info' | 'warn' | 'error' | 'debug';

function log(level: Level, message: string, meta?: unknown): void {
  const ts = new Date().toISOString();
  // Never log secrets / ciphertext / tokens
  const safeMeta = meta !== undefined ? redactSecrets(meta) : undefined;
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    console.error(line, safeMeta ?? '');
  } else if (level === 'warn') {
    console.warn(line, safeMeta ?? '');
  } else {
    console.log(line, safeMeta ?? '');
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
  debug: (msg: string, meta?: unknown) => {
    if (process.env.NODE_ENV !== 'production') log('debug', msg, meta);
  },
};

export default logger;
