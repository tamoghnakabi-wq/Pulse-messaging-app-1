/**
 * Background maintenance for Pulse Play:
 * - advances timed trivia/emoji rounds without clients
 * - expires abandoned invites/games
 * - retries recoverable stats leases
 *
 * Single interval per process; non-overlapping; unref'd so tests can exit.
 */
import logger from '../../utils/logger';
import { gameService } from './game.service';

const DEFAULT_INTERVAL_MS = 7_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let started = false;

async function sweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await gameService.expireStale(40);
  } catch (err) {
    logger.warn('Pulse Play scheduler sweep failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running = false;
  }
}

/**
 * Start the trusted background interval (once per process).
 * Disabled when GAME_SCHEDULER=0 (tests / special deploys).
 */
export function startGameScheduler(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (process.env.GAME_SCHEDULER === '0' || process.env.GAME_SCHEDULER === 'false') {
    logger.info('Pulse Play scheduler disabled (GAME_SCHEDULER=0)');
    return;
  }
  if (started || timer) return;
  started = true;

  // First pass shortly after boot so abandoned timers recover quickly
  void sweep();

  timer = setInterval(() => {
    void sweep();
  }, Math.max(3_000, intervalMs));

  // Do not keep the process alive solely for the scheduler (tests / short scripts)
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  logger.info(`Pulse Play scheduler started (every ${Math.max(3_000, intervalMs)}ms)`);
}

export function stopGameScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  running = false;
}

/** Test helper: run one sweep now (awaits completion). */
export async function runGameSchedulerOnce(): Promise<void> {
  await sweep();
}

export function isGameSchedulerRunning(): boolean {
  return timer != null;
}
