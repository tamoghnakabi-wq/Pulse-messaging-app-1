import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../utils/cn';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, leftIcon, rightIcon, id, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={id}
            className="mb-1.5 block text-[13px] font-semibold tracking-[-0.01em] text-[var(--color-ink-secondary)]"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-secondary)] opacity-80">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            id={id}
            className={cn(
              'min-h-11 w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-4 py-2.5 text-[15px] tracking-[-0.015em] text-[var(--color-ink)] outline-none shadow-sm transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-[var(--color-ink-secondary)]/50 focus:border-pulse-500 focus:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--color-pulse-500)_15%,transparent),0_2px_12px_color-mix(in_srgb,var(--color-pulse-500)_8%,transparent)] sm:text-sm',
              leftIcon && 'pl-10',
              rightIcon && 'pr-10',
              error &&
                'border-red-500 focus:border-red-500 focus:shadow-[0_0_0_3.5px_rgba(239,68,68,0.14)]',
              className
            )}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-secondary)]">
              {rightIcon}
            </div>
          )}
        </div>
        {error && <p className="mt-1.5 text-xs font-medium text-red-500">{error}</p>}
      </div>
    );
  }
);

Input.displayName = 'Input';
