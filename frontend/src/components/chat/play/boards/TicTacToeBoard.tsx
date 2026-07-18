import type { PulseGame } from '@/shared/types/game';
import { cn } from '@/utils/cn';

interface Props {
  game: PulseGame;
  myId: string;
  disabled?: boolean;
  onMove: (cell: number) => void;
}

export function TicTacToeBoard({ game, disabled, onMove }: Props) {
  const board = (game.state?.board as (string | null)[]) || Array(9).fill(null);
  return (
    <div
      className="grid grid-cols-3 gap-1.5"
      role="grid"
      aria-label="Tic-tac-toe board"
    >
      {board.map((cell, i) => (
        <button
          key={i}
          type="button"
          role="gridcell"
          disabled={disabled || cell != null}
          aria-label={cell ? `Cell ${i + 1} ${cell}` : `Empty cell ${i + 1}`}
          className={cn(
            'flex h-12 w-12 items-center justify-center rounded-xl text-xl font-bold transition-colors',
            'bg-black/[0.05] dark:bg-white/[0.08]',
            !disabled && !cell && 'hover:bg-pulse-500/15 pressable',
            cell === 'X' && 'text-sky-600 dark:text-sky-400',
            cell === 'O' && 'text-rose-500 dark:text-rose-400'
          )}
          onClick={() => onMove(i)}
        >
          {cell || ''}
        </button>
      ))}
    </div>
  );
}
