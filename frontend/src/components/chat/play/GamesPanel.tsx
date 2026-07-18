import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Trophy } from 'lucide-react';
import type { LeaderboardRow, PulseGame } from '@/shared/types/game';
import { gameService } from '@/features/chat/services/gameService';
import { GameCard } from './GameCard';
import { cn } from '@/utils/cn';

interface Props {
  conversationId: string;
  open: boolean;
  onClose: () => void;
}

export function GamesPanel({ conversationId, open, onClose }: Props) {
  const [tab, setTab] = useState<'history' | 'board'>('history');
  const [games, setGames] = useState<PulseGame[]>([]);
  const [board, setBoard] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void Promise.all([
      gameService.list(conversationId, 40),
      gameService.leaderboard(conversationId),
    ])
      .then(([g, b]) => {
        setGames(g);
        setBoard(b);
      })
      .finally(() => setLoading(false));
  }, [open, conversationId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/45"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        className={cn(
          'relative z-[1] flex w-full max-w-md flex-col overflow-hidden',
          'max-h-[min(92dvh,40rem)] sm:max-h-[min(88vh,36rem)]',
          'rounded-t-3xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl sm:rounded-3xl'
        )}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="font-semibold tracking-[-0.02em]">Games</h2>
          <button
            type="button"
            className="pressable flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex shrink-0 gap-1 border-b border-[var(--color-border)] px-3 py-2">
          {(['history', 'board'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs font-semibold',
                tab === t ? 'bg-pulse-500 text-white' : 'bg-black/5 dark:bg-white/10'
              )}
            >
              {t === 'history' ? 'History' : 'Leaderboard'}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] scrollbar-thin">
          {loading && (
            <p className="py-8 text-center text-xs opacity-50">Loading…</p>
          )}
          {!loading && tab === 'history' && (
            <div className="space-y-2">
              {games.length === 0 && (
                <p className="py-8 text-center text-xs opacity-50">
                  No games yet — tap Play in the composer.
                </p>
              )}
              {games.map((g) => (
                <GameCard key={g.id} gameId={g.id} initial={g} compact />
              ))}
            </div>
          )}
          {!loading && tab === 'board' && (
            <div className="space-y-2">
              {board.length === 0 && (
                <p className="py-8 text-center text-xs opacity-50">
                  Play a few games to fill the board.
                </p>
              )}
              {board.map((row) => (
                <div
                  key={row.user.id}
                  className="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] px-3 py-2.5"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-500/15 text-sm font-bold text-amber-700 dark:text-amber-300">
                    {row.rank <= 3 ? <Trophy className="h-4 w-4" /> : row.rank}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {row.user.displayName || row.user.username || 'Player'}
                    </p>
                    <p className="text-[11px] opacity-60">
                      {row.wins}W · {row.losses}L · {row.draws}D · {row.winRate}%
                    </p>
                  </div>
                  {row.currentStreak > 0 && (
                    <span className="text-[11px] font-semibold text-pulse-600">
                      🔥{row.currentStreak}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
