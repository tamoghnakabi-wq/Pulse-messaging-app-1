import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: LucideIcon;
  iconNode?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** Shared empty-state layout used across chat lists and modals. */
export function EmptyState({
  icon: Icon,
  iconNode,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`animate-fade-up flex flex-col items-center justify-center px-8 py-16 text-center ${className}`}
    >
      <div className="empty-icon mb-4">
        {iconNode ??
          (Icon ? <Icon className="h-7 w-7 text-pulse-500" /> : null)}
      </div>
      <p className="text-[15px] font-semibold tracking-[-0.02em]">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-[16rem] text-sm leading-relaxed text-[var(--color-ink-secondary)]">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
