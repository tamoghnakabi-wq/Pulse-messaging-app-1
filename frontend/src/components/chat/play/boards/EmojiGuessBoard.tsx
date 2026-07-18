import { useEffect, useState } from 'react';
import type { PulseGame } from '@/shared/types/game';

interface Props {
  game: PulseGame;
  myId: string;
  disabled?: boolean;
  onGuess: (guess: string) => void;
  onResolve: () => void;
}

export function EmojiGuessBoard({ game, myId, disabled, onGuess, onResolve }: Props) {
  const round = game.state?.round as
    | {
        emoji?: string;
        hint?: string;
        endsAt?: number;
        revealed?: boolean;
        answerReveal?: string;
        answered?: string[];
        solvedBy?: string;
        revealEndsAt?: number;
      }
    | null
    | undefined;
  const [text, setText] = useState('');
  const [left, setLeft] = useState(0);

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

  if (!round?.emoji) {
    return <p className="text-xs opacity-60">Waiting for next riddle…</p>;
  }

  const answered = (round.answered || []).includes(myId);

  return (
    <div className="space-y-2">
      <div className="text-center text-3xl leading-none">{round.emoji}</div>
      {round.hint && (
        <p className="text-center text-[11px] opacity-60">Hint: {round.hint}</p>
      )}
      <p className="text-center text-[11px] font-semibold tabular-nums opacity-70">
        {round.revealed ? (left > 0 ? `Next in ${left}s` : '…') : `${left}s`}
      </p>
      {round.revealed && round.answerReveal && (
        <p className="text-center text-sm font-semibold text-emerald-600 dark:text-emerald-400">
          Answer: {round.answerReveal}
        </p>
      )}
      {!round.revealed && !answered && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onGuess(text.trim());
            setText('');
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={disabled}
            maxLength={80}
            placeholder="Your guess…"
            className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-pulse-500/40"
          />
          <button
            type="submit"
            disabled={disabled || !text.trim()}
            className="pressable rounded-xl bg-pulse-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            Go
          </button>
        </form>
      )}
      {answered && !round.revealed && (
        <p className="text-center text-[11px] opacity-60">Guess submitted…</p>
      )}
    </div>
  );
}
