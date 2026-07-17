/** Lightweight loading UI — no framer-motion (keeps critical path small). */

export function LoadingScreen({ message = 'Loading Pulse…' }: { message?: string }) {
  return (
    <div className="relative flex h-full min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-[var(--color-surface)]">
      <div className="pointer-events-none absolute -left-24 top-1/4 h-64 w-64 rounded-full bg-pulse-500/18 blur-3xl" />
      <div className="pointer-events-none absolute -right-20 bottom-1/4 h-56 w-56 rounded-full bg-pulse-600/10 blur-3xl" />

      <div className="relative mb-6 h-[5.25rem] w-[5.25rem]">
        <div className="absolute inset-0 animate-pulse rounded-[24px] bg-pulse-500/30 blur-xl" />
        <div className="relative flex h-full w-full items-center justify-center rounded-[24px] bg-gradient-to-br from-pulse-300 via-pulse-500 to-pulse-700 shadow-2xl shadow-pulse-500/45 ring-4 ring-white/25 dark:ring-white/10">
          <svg viewBox="0 0 64 64" className="h-12 w-12 drop-shadow-sm" aria-hidden>
            <path
              d="M18 34c0-8 6-14 14-14s14 6 14 14c0 3-1 6-3 8l3 8-9-4c-1.5.5-3.2.8-5 .8-8 0-14-6-14-12.8z"
              fill="white"
            />
          </svg>
        </div>
      </div>
      <p className="brand-eyebrow mb-2">Pulse</p>
      <p className="text-sm font-semibold tracking-[-0.018em] text-[var(--color-ink)]">
        {message}
      </p>
      <div className="mt-5 flex gap-1.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="typing-dot h-1.5 w-1.5 rounded-full bg-pulse-500"
            style={{ animationDelay: `${i * 0.14}s` }}
          />
        ))}
      </div>
    </div>
  );
}

export function ChatSkeleton() {
  return (
    <div className="flex h-full animate-fade-in">
      <div className="flex w-full max-w-sm flex-col gap-3 border-r border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-4">
        <div className="mb-1 flex items-center gap-3">
          <div className="skeleton h-11 w-11 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-24" />
            <div className="skeleton h-2.5 w-16" />
          </div>
        </div>
        <div className="skeleton h-11 w-full rounded-2xl" />
        <div className="flex gap-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-8 w-16 rounded-full" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 py-1">
            <div className="skeleton h-12 w-12 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-3 w-2/3" />
              <div className="skeleton h-2.5 w-1/2" />
            </div>
          </div>
        ))}
      </div>
      <div className="hidden flex-1 flex-col p-6 md:flex">
        <div className="skeleton mb-4 h-14 w-full rounded-2xl" />
        <div className="flex flex-1 flex-col justify-end gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className={`skeleton h-12 rounded-2xl ${i % 2 ? 'ml-auto w-2/5' : 'w-1/2'}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
