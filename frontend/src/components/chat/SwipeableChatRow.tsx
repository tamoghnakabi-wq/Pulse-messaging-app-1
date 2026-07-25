import { useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { Archive, Pin, Trash2, MailOpen } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

const ACTION_W = 76;
const THRESHOLD = 56;

interface Props {
  children: ReactNode;
  active?: boolean;
  /**
   * Accessible name for the row. The visible content is a composed block of
   * avatar + name + preview + badges, which screen readers announce as one
   * run-on string (or, when the avatar is an image, as nothing at all).
   */
  label?: string;
  onOpen: () => void;
  onPin: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onMarkUnread: () => void;
  /** Disable swipe on desktop / when not needed */
  enabled?: boolean;
}

/**
 * Mobile swipeable chat row:
 * - Swipe left → Pin / Delete
 * - Swipe right → Archive / Mark unread
 */
export function SwipeableChatRow({
  children,
  active,
  label,
  onOpen,
  onPin,
  onDelete,
  onArchive,
  onMarkUnread,
  enabled = true,
}: Props) {
  const [dx, setDx] = useState(0);
  const startX = useRef(0);
  const startY = useRef(0);
  const axis = useRef<'none' | 'x' | 'y'>('none');
  const open = useRef(0); // settled offset

  const clamp = (v: number) => Math.max(-ACTION_W * 2, Math.min(ACTION_W * 2, v));

  const onTouchStart = (e: TouchEvent) => {
    if (!enabled) return;
    const t = e.touches[0];
    startX.current = t.clientX;
    startY.current = t.clientY;
    axis.current = 'none';
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!enabled) return;
    const t = e.touches[0];
    const mx = t.clientX - startX.current;
    const my = t.clientY - startY.current;
    if (axis.current === 'none') {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      axis.current = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    }
    if (axis.current !== 'x') return;
    // prevent vertical scroll fight when swiping actions
    e.preventDefault();
    setDx(clamp(open.current + mx));
  };

  const settle = (value: number) => {
    let next = 0;
    if (value <= -THRESHOLD) next = -ACTION_W * 2;
    else if (value >= THRESHOLD) next = ACTION_W * 2;
    open.current = next;
    setDx(next);
  };

  const onTouchEnd = () => {
    if (!enabled || axis.current !== 'x') {
      axis.current = 'none';
      return;
    }
    settle(dx);
    axis.current = 'none';
  };

  const close = () => {
    open.current = 0;
    setDx(0);
  };

  const run = (fn: () => void) => {
    close();
    fn();
  };

  // Only paint action layers while swiping — otherwise solid red/amber/violet/blue
  // panels peek through rounded chat-row margins as multicolour bars.
  const actionsVisible = dx !== 0 || open.current !== 0;

  return (
    <div className={cn('relative overflow-hidden', active && 'z-[1]')}>
      {/* Right actions (revealed by swipe left) — solid muted tones, not rainbow gradients */}
      <div
        className={cn(
          'absolute inset-y-0 right-0 flex w-[152px] transition-opacity duration-150',
          actionsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
        aria-hidden={!actionsVisible}
      >
        <button
          type="button"
          className="flex w-[76px] flex-col items-center justify-center gap-0.5 bg-pulse-600 text-white active:bg-pulse-700"
          style={{ minWidth: 44, minHeight: 44 }}
          tabIndex={actionsVisible ? 0 : -1}
          onClick={() => run(onPin)}
        >
          <Pin className="h-4 w-4" />
          <span className="text-[10px] font-semibold tracking-[-0.01em]">Pin</span>
        </button>
        <button
          type="button"
          className="flex w-[76px] flex-col items-center justify-center gap-0.5 bg-neutral-700 text-white active:bg-neutral-800 dark:bg-neutral-600"
          style={{ minWidth: 44, minHeight: 44 }}
          tabIndex={actionsVisible ? 0 : -1}
          onClick={() => run(onDelete)}
        >
          <Trash2 className="h-4 w-4" />
          <span className="text-[10px] font-semibold tracking-[-0.01em]">Delete</span>
        </button>
      </div>
      {/* Left actions (revealed by swipe right) */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 flex w-[152px] transition-opacity duration-150',
          actionsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
        aria-hidden={!actionsVisible}
      >
        <button
          type="button"
          className="flex w-[76px] flex-col items-center justify-center gap-0.5 bg-neutral-600 text-white active:bg-neutral-700"
          style={{ minWidth: 44, minHeight: 44 }}
          tabIndex={actionsVisible ? 0 : -1}
          onClick={() => run(onArchive)}
        >
          <Archive className="h-4 w-4" />
          <span className="text-[10px] font-semibold tracking-[-0.01em]">Archive</span>
        </button>
        <button
          type="button"
          className="flex w-[76px] flex-col items-center justify-center gap-0.5 bg-pulse-600 text-white active:bg-pulse-700"
          style={{ minWidth: 44, minHeight: 44 }}
          tabIndex={actionsVisible ? 0 : -1}
          onClick={() => run(onMarkUnread)}
        >
          <MailOpen className="h-4 w-4" />
          <span className="text-[10px] font-semibold tracking-[-0.01em]">Unread</span>
        </button>
      </div>

      <div
        className="relative z-[2] bg-[var(--color-surface-elevated)] dark:bg-[var(--color-surface-elevated)]"
        style={{
          transform: `translate3d(${dx}px,0,0)`,
          // Promote layer only while swiping / open — permanent will-change costs VRAM on long lists
          willChange: actionsVisible ? 'transform' : 'auto',
          // No CSS transition while finger is down; short ease only when settling
          transition:
            axis.current === 'x' ? 'none' : 'transform 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
          // Reduce subpixel blur during swipe
          backfaceVisibility: 'hidden',
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <button
          type="button"
          aria-label={label}
          aria-current={active ? 'true' : undefined}
          className={cn(
            'chat-row touch-row pressable flex w-full items-center gap-3 px-3 py-3.5 text-left sm:px-4 sm:py-3',
            active && 'chat-row-active'
          )}
          onClick={() => {
            if (Math.abs(open.current) > 8) {
              close();
              return;
            }
            onOpen();
          }}
        >
          {children}
        </button>
      </div>
    </div>
  );
}
