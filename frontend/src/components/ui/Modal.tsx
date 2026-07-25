import { useEffect, type ReactNode } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../../utils/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  /**
   * Keep panel height stable so tab switches (e.g. Settings) don't resize the window.
   * Content scrolls inside instead.
   */
  stableHeight?: boolean;
  /** When true, body does not scroll — children own overflow (e.g. split-pane settings). */
  bodyScroll?: boolean;
  /**
   * Stack above fixed call UI (z-100). Use for pickers opened from CallOverlay.
   */
  elevated?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  size = 'md',
  stableHeight = false,
  bodyScroll = true,
  elevated = false,
}: ModalProps) {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const widths = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
  };

  // Springs / fades are frame-synced by Framer (rAF → display refresh)
  const panelTransition = reduceMotion
    ? { duration: 0.01 }
    : { type: 'spring' as const, damping: 32, stiffness: 380, mass: 0.85 };
  const fadeTransition = reduceMotion ? { duration: 0.01 } : { duration: 0.18 };

  return (
    <AnimatePresence>
      {open && (
        <div
          className={cn(
            'modal-sheet fixed inset-0 flex items-center justify-center p-3 sm:p-4',
            elevated ? 'z-[200]' : 'z-50'
          )}
        >
          <motion.div
            className="absolute inset-0 bg-black/55 md:bg-black/50 md:backdrop-blur-[8px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fadeTransition}
            onClick={onClose}
          />
          <motion.div
            data-modal-panel
            className={cn(
              // glass-panel (not glass-strong): a dialog has to be readable over
              // whatever is behind it — see the token comment in index.css.
              'relative z-10 flex w-full max-h-[min(90dvh,var(--app-height,100dvh))] flex-col overflow-hidden rounded-3xl glass-panel gpu-boost',
              widths[size],
              // Fixed height so switching internal tabs never reflows the shell
              stableHeight &&
                'h-[min(88dvh,42rem)] max-h-[min(90dvh,var(--app-height,100dvh))] sm:h-[min(85dvh,40rem)]',
              className
            )}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 28 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 18 }}
            transition={panelTransition}
          >
            {/* Mobile drag affordance */}
            <div className="flex shrink-0 justify-center pt-2.5 sm:hidden" aria-hidden>
              <div className="h-1 w-10 rounded-full bg-black/15 dark:bg-white/20" />
            </div>
            {title && (
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4 py-3.5 sm:px-5 sm:py-4">
                <h2 className="text-base font-semibold tracking-[-0.025em] sm:text-lg">{title}</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-[var(--color-ink-secondary)]"
                  onClick={onClose}
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </Button>
              </div>
            )}
            <div
              className={cn(
                'min-h-0 flex-1 overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))]',
                bodyScroll
                  ? 'overflow-y-auto p-4 sm:p-5 scrollbar-thin'
                  : 'flex flex-col overflow-hidden p-0'
              )}
            >
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
