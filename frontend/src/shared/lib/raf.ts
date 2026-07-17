/**
 * Display-refresh utilities — schedule work on the next animation frame(s)
 * so UI tracks 60 / 90 / 120 Hz (and ProMotion) instead of fixed timers.
 */

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Coalesce high-frequency events (scroll, resize, pointer) to one update per frame. */
export function rafThrottle<T extends (...args: never[]) => void>(fn: T): T {
  let raf = 0;
  let latestArgs: Parameters<T> | null = null;

  const run = () => {
    raf = 0;
    if (!latestArgs) return;
    const args = latestArgs;
    latestArgs = null;
    fn(...args);
  };

  const throttled = ((...args: Parameters<T>) => {
    latestArgs = args;
    if (raf) return;
    raf = requestAnimationFrame(run);
  }) as T;

  return throttled;
}

/** Run after layout paint (useful before measuring scrollHeight). */
export function afterNextPaint(fn: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(fn);
  });
}

/**
 * Smooth-scroll an element using requestAnimationFrame (refresh-rate locked).
 * Falls back to instant jump when the user prefers reduced motion.
 */
export function smoothScrollTo(
  el: HTMLElement,
  top: number,
  opts?: { durationMs?: number }
): void {
  const target = Math.max(0, top);
  if (prefersReducedMotion()) {
    el.scrollTop = target;
    return;
  }

  const start = el.scrollTop;
  const delta = target - start;
  if (Math.abs(delta) < 1) {
    el.scrollTop = target;
    return;
  }

  // Longer distances get a bit more time, still capped for snappiness
  const base = opts?.durationMs ?? 280;
  const duration = Math.min(420, Math.max(140, base * Math.min(1.6, Math.abs(delta) / 480)));
  const t0 = performance.now();

  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / duration);
    // ease-out expo (matches --ease-out-expo feel)
    const eased = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
    el.scrollTop = start + delta * eased;
    if (t < 1) requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}

/** Scroll an element so its bottom is visible (chat stick-to-bottom). */
export function smoothScrollToBottom(el: HTMLElement, durationMs?: number): void {
  const top = el.scrollHeight - el.clientHeight;
  smoothScrollTo(el, top, { durationMs });
}
