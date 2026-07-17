import { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';
import { getInitials } from '../../utils/format';
import { mediaUrl } from '../../utils/mediaUrl';

interface AvatarProps {
  src?: string;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  online?: boolean;
  className?: string;
}

const sizes = {
  xs: 'h-7 w-7 text-[10px]',
  sm: 'h-9 w-9 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-14 w-14 text-base',
  xl: 'h-20 w-20 text-xl',
};

const colors = [
  'from-blue-500 to-cyan-400',
  'from-violet-500 to-purple-400',
  'from-pink-500 to-rose-400',
  'from-emerald-500 to-teal-400',
  'from-amber-500 to-orange-400',
  'from-indigo-500 to-blue-400',
];

function colorFor(name?: string) {
  if (!name) return colors[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export function Avatar({ src, name, size = 'md', online, className }: AvatarProps) {
  const resolved = mediaUrl(src);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [resolved]);
  const showImg = Boolean(resolved) && !imgFailed;

  return (
    // Outer must stay circular so ring/shadow from className never form a square
    <div className={cn('relative inline-flex shrink-0 rounded-full', className)}>
      <div
        className={cn(
          'aspect-square overflow-hidden rounded-full bg-[var(--color-surface-elevated)] shadow-md shadow-black/[0.06] ring-2 ring-white/50 dark:shadow-black/35 dark:ring-white/[0.08]',
          sizes[size]
        )}
      >
        {showImg ? (
          <img
            key={resolved}
            src={resolved}
            alt={name || 'Avatar'}
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            className="h-full w-full rounded-full object-cover object-center"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div
            className={cn(
              'flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br font-semibold tracking-tight text-white',
              colorFor(name)
            )}
          >
            {getInitials(name)}
          </div>
        )}
      </div>
      {online !== undefined && (
        <span
          className={cn(
            'presence-dot absolute bottom-0 right-0 rounded-full border-2 border-[var(--color-surface-elevated)]',
            size === 'xs' || size === 'sm' ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5',
            online ? 'presence-dot-online' : 'presence-dot-offline'
          )}
        />
      )}
    </div>
  );
}
