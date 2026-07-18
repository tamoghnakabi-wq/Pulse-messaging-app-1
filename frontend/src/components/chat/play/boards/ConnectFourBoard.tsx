import type { PulseGame } from '@/shared/types/game';
import { cn } from '@/utils/cn';

interface Props {
  game: PulseGame;
  myId: string;
  disabled?: boolean;
  onMove: (column: number) => void;
}

export function ConnectFourBoard({ game, disabled, onMove }: Props) {
  const grid = (game.state?.grid as (string | null)[][]) || [];
  const cols = 7;
  return (
    <div className="space-y-1">
      <div className="flex justify-center gap-0.5">
        {Array.from({ length: cols }, (_, c) => (
          <button
            key={c}
            type="button"
            disabled={disabled}
            aria-label={`Drop in column ${c + 1}`}
            className={cn(
              'h-6 w-8 rounded-md text-[10px] font-semibold',
              'bg-black/[0.05] dark:bg-white/[0.08]',
              !disabled && 'hover:bg-pulse-500/20 pressable'
            )}
            onClick={() => onMove(c)}
          >
            ↓
          </button>
        ))}
      </div>
      <div
        className="inline-grid gap-0.5 rounded-xl bg-sky-700/80 p-1.5"
        style={{ gridTemplateColumns: `repeat(${cols}, 1.75rem)` }}
        role="grid"
        aria-label="Connect Four board"
      >
        {grid.flatMap((row, r) =>
          row.map((cell, c) => (
            <div
              key={`${r}-${c}`}
              role="gridcell"
              className={cn(
                'h-7 w-7 rounded-full bg-sky-900/40',
                cell === 'R' && 'bg-rose-500 shadow-inner',
                cell === 'Y' && 'bg-amber-400 shadow-inner'
              )}
            />
          ))
        )}
      </div>
    </div>
  );
}
