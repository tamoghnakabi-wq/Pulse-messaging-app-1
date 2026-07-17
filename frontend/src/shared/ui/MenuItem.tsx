import { useRef, type ReactNode, type PointerEvent, type MouseEvent } from 'react';
import { cn } from '@/shared/lib/cn';

interface MenuItemProps {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  dense?: boolean;
  role?: string;
}

/**
 * Shared list-row for desktop menus + mobile action sheets.
 * Mobile: run on pointerup and latch so the delayed "ghost click" cannot re-fire
 * (that ghost click was reopening the message ⋮ menu under the sheet).
 */
export function MenuItem({
  icon,
  label,
  onClick: onSelect,
  danger,
  dense = true,
  role = 'menuitem',
}: MenuItemProps) {
  const pressed = useRef(false);
  const lastRun = useRef(0);

  const runOnce = () => {
    const now = Date.now();
    if (now - lastRun.current < 500) return;
    lastRun.current = now;
    onSelect();
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    pressed.current = true;
  };

  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!pressed.current) return;
    pressed.current = false;
    e.preventDefault();
    e.stopPropagation();
    runOnce();
  };

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Keyboard (detail === 0) or engines that skip pointer events
    if (!lastRun.current || Date.now() - lastRun.current > 500) {
      // If pointerup already ran within 500ms, runOnce no-ops
      runOnce();
    }
  };

  return (
    <button
      type="button"
      role={role}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        pressed.current = false;
      }}
      onPointerLeave={() => {
        if (pressed.current) pressed.current = false;
      }}
      onClick={handleClick}
      className={cn(
        'menu-item flex w-full items-center gap-3 px-4 text-left touch-manipulation select-none',
        dense ? 'min-h-11 gap-2.5 px-3.5 py-2.5 text-sm' : 'min-h-12 py-3.5 text-[15px]',
        danger && 'text-red-500'
      )}
    >
      {icon != null && (
        <span className={cn(!danger && 'text-[var(--color-ink-secondary)]')}>{icon}</span>
      )}
      <span className="flex-1 font-medium tracking-[-0.01em]">{label}</span>
    </button>
  );
}
