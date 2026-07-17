import { type ReactNode } from 'react';
import { motion } from 'framer-motion';

export function AuthLayout({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--color-surface)] p-4 safe-top safe-bottom">
      {/* Ambient mesh — brand blue only */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-pulse-500/22 blur-3xl" />
        <div className="absolute -bottom-40 -right-24 h-[26rem] w-[26rem] rounded-full bg-pulse-600/12 blur-3xl" />
        <div className="absolute left-1/2 top-1/4 h-72 w-72 -translate-x-1/2 rounded-full bg-pulse-400/10 blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.28] dark:opacity-[0.16]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-ink) 7%, transparent) 1px, transparent 0)',
            backgroundSize: '22px 22px',
          }}
        />
      </div>

      <motion.div
        className="relative w-full max-w-[26rem]"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.48, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="mb-8 text-center">
          <div className="relative mx-auto mb-5 h-[4.5rem] w-[4.5rem]">
            <div className="absolute inset-0 rounded-[22px] bg-pulse-500/30 blur-xl" />
            <div className="relative flex h-full w-full items-center justify-center rounded-[22px] bg-gradient-to-br from-pulse-300 via-pulse-500 to-pulse-700 shadow-2xl shadow-pulse-500/45 ring-4 ring-white/30 dark:ring-white/10">
              <svg viewBox="0 0 64 64" className="h-10 w-10 drop-shadow-sm" aria-hidden>
                <path
                  d="M18 34c0-8 6-14 14-14s14 6 14 14c0 3-1 6-3 8l3 8-9-4c-1.5.5-3.2.8-5 .8-8 0-14-6-14-12.8z"
                  fill="white"
                />
              </svg>
            </div>
          </div>
          <p className="brand-eyebrow mb-1.5">Pulse</p>
          <h1 className="text-[1.7rem] font-extrabold tracking-[-0.04em] sm:text-[1.8rem]">
            {title}
          </h1>
          {subtitle && (
            <p className="mx-auto mt-2.5 max-w-sm text-sm leading-relaxed tracking-[-0.012em] text-[var(--color-ink-secondary)]">
              {subtitle}
            </p>
          )}
        </div>

        <div className="glass-strong rounded-[1.9rem] p-6 shadow-2xl ring-1 ring-black/[0.04] dark:ring-white/[0.05] sm:p-8">
          {children}
        </div>
      </motion.div>
    </div>
  );
}
