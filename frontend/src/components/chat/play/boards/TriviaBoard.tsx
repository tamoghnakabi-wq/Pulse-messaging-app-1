import { useEffect, useState } from 'react';
import type { PulseGame } from '@/shared/types/game';
import { cn } from '@/utils/cn';

interface Props {
  game: PulseGame;
  myId: string;
  disabled?: boolean;
  onAnswer: (choice: number) => void;
  onResolve: () => void;
}

export function TriviaBoard({ game, myId, disabled, onAnswer, onResolve }: Props) {
  const round = game.state?.round as
    | {
        prompt?: string;
        choices?: string[];
        endsAt?: number;
        revealed?: boolean;
        correctIndex?: number;
        answered?: string[];
        revealEndsAt?: number;
      }
    | null
    | undefined;
  const [left, setLeft] = useState(0);

  // Question timer → resolve; reveal timer → advance
  useEffect(() => {
    if (!round) return;
    const tick = () => {
      if (!round.revealed && round.endsAt) {
        const ms = Math.max(0, round.endsAt - Date.now());
        setLeft(Math.ceil(ms / 1000));
        if (ms <= 0) onResolve();
        return;
      }
      if (round.revealed && round.revealEndsAt) {
        const ms = Math.max(0, round.revealEndsAt - Date.now());
        setLeft(Math.ceil(ms / 1000));
        if (ms <= 0) onResolve();
      }
    };
    tick();
    const id = window.setInterval(tick, 400);
    return () => window.clearInterval(id);
  }, [round?.endsAt, round?.revealed, round?.revealEndsAt, onResolve]);

  if (!round?.prompt) {
    return <p className="text-xs opacity-60">Waiting for next question…</p>;
  }

  const answered = (round.answered || []).includes(myId);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{round.prompt}</p>
        <span className="shrink-0 rounded-full bg-black/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums dark:bg-white/10">
          {round.revealed ? (left > 0 ? `Next ${left}s` : '…') : `${left}s`}
        </span>
      </div>
      {round.revealed && typeof round.correctIndex === 'number' && (
        <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
          Correct answer highlighted
        </p>
      )}
      <div className="grid gap-1.5">
        {(round.choices || []).map((c, i) => {
          const showCorrect = round.revealed && round.correctIndex === i;
          return (
            <button
              key={i}
              type="button"
              disabled={disabled || answered || !!round.revealed}
              className={cn(
                'rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors',
                'bg-black/[0.05] dark:bg-white/[0.08]',
                !answered && !round.revealed && 'hover:bg-pulse-500/15 pressable',
                showCorrect && 'bg-emerald-500/20 ring-1 ring-emerald-500/40'
              )}
              onClick={() => onAnswer(i)}
            >
              {c}
            </button>
          );
        })}
      </div>
      {answered && !round.revealed && (
        <p className="text-[11px] opacity-60">Answer locked — waiting for others…</p>
      )}
    </div>
  );
}
