import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../utils/cn';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      loading,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const variants = {
      primary:
        'bg-gradient-to-b from-pulse-400 to-pulse-600 text-white shadow-lg shadow-pulse-500/28 ring-1 ring-white/18 hover:from-pulse-500 hover:to-pulse-700 hover:shadow-pulse-500/38 active:scale-[0.975]',
      secondary:
        'bg-[var(--color-surface-elevated)] text-[var(--color-ink)] border border-[var(--color-border)] shadow-sm hover:bg-black/[0.03] hover:border-black/10 hover:shadow-md dark:hover:bg-white/[0.055] dark:hover:border-white/12',
      ghost:
        'bg-transparent text-[var(--color-ink)] hover:bg-black/[0.05] active:bg-black/[0.08] dark:hover:bg-white/[0.07]',
      danger:
        'bg-gradient-to-b from-red-400 to-red-600 text-white shadow-lg shadow-red-500/22 ring-1 ring-white/10 hover:from-red-500 hover:to-red-700 active:scale-[0.975]',
      glass: 'glass text-[var(--color-ink)] hover:bg-white/30 dark:hover:bg-white/10',
    };

    const sizes = {
      sm: 'min-h-11 h-9 sm:h-8 px-3.5 text-sm rounded-xl tracking-[-0.01em]',
      md: 'min-h-11 h-11 sm:h-10 px-4.5 text-sm rounded-2xl tracking-[-0.01em]',
      lg: 'min-h-12 h-12 px-6 text-[15px] rounded-2xl tracking-[-0.015em]',
      icon: 'h-11 w-11 min-h-11 min-w-11 sm:h-10 sm:w-10 rounded-full p-0 inline-flex items-center justify-center',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center gap-2 font-semibold transition-[transform,background-color,box-shadow,opacity,border-color,filter] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] disabled:opacity-45 disabled:pointer-events-none touch-manipulation select-none active:brightness-[0.98]',
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      >
        {loading && (
          <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-90" />
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
