/**
 * Interactive Pulse Play card — state is always loaded from server (gameId).
 * Game activity is server-authoritative and not E2E encrypted.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trophy, Users } from 'lucide-react';
import type { PulseGame } from '@/shared/types/game';
import { gameService } from '@/features/chat/services/gameService';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';
import toast from 'react-hot-toast';
import { TicTacToeBoard } from './boards/TicTacToeBoard';
import { ConnectFourBoard } from './boards/ConnectFourBoard';
import { TriviaBoard } from './boards/TriviaBoard';
import { EmojiGuessBoard } from './boards/EmojiGuessBoard';

interface Props {
  gameId: string;
  /** Seed from parent if already known */
  initial?: PulseGame | null;
  compact?: boolean;
}

function statusLabel(g: PulseGame): string {
  switch (g.status) {
    case 'invited':
      return 'Waiting for players';
    case 'active':
      return g.currentTurnUserId ? 'In progress' : 'Playing';
    case 'completed':
      return g.isDraw ? 'Draw' : 'Finished';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    case 'declined':
      return 'Declined';
    default:
      return g.status;
  }
}

function playerName(p: PulseGame['players'][0]): string {
  if (p.user && typeof p.user === 'object') {
    return p.user.displayName || p.user.username || 'Player';
  }
  return 'Player';
}

export function GameCard({ gameId, initial, compact }: Props) {
  const myId = useAuthStore((s) => s.user?.id) || '';
  const [game, setGame] = useState<PulseGame | null>(initial || null);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const g = await gameService.get(gameId);
      setGame(g);
    } catch {
      /* keep previous */
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for store/socket patches via custom event
  useEffect(() => {
    const onUpd = (e: Event) => {
      const detail = (e as CustomEvent).detail as PulseGame | undefined;
      if (detail?.id === gameId) setGame(detail);
    };
    window.addEventListener('pulse:game-updated', onUpd);
    return () => window.removeEventListener('pulse:game-updated', onUpd);
  }, [gameId]);

  const run = async (fn: () => Promise<PulseGame>) => {
    setBusy(true);
    try {
      const g = await fn();
      setGame(g);
      window.dispatchEvent(new CustomEvent('pulse:game-updated', { detail: g }));
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? (e as { response?: { data?: { error?: { message?: string } } } }).response?.data
              ?.error?.message
          : undefined;
      toast.error(msg || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !game) {
    return (
      <div className="mb-1.5 flex min-h-[5rem] items-center justify-center gap-2 rounded-2xl bg-black/[0.04] px-4 py-6 dark:bg-white/[0.06]">
        <Loader2 className="h-4 w-4 animate-spin opacity-50" />
        <span className="text-xs opacity-50">Loading game…</span>
      </div>
    );
  }
  if (!game) return null;

  const joined = game.players.filter((p) => p.status === 'joined');
  const meJoined = game.players.some((p) => p.userId === myId && p.status === 'joined');
  const isCreator = game.creatorId === myId;
  const myTurn = game.status === 'active' && game.currentTurnUserId === myId;
  const winners = new Set(game.winnerIds || []);
  const iWon = winners.has(myId);

  return (
    <div
      className={cn(
        'game-card mb-1.5 w-[min(100%,20rem)] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] shadow-sm',
        compact && 'w-full'
      )}
    >
      <div className="flex items-start gap-2.5 border-b border-[var(--color-border)] bg-gradient-to-br from-pulse-500/10 to-transparent px-3 py-2.5">
        <span className="text-2xl leading-none" aria-hidden>
          {game.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold tracking-[-0.02em] text-[15px]">{game.displayName}</p>
          <p className="text-[11px] text-[var(--color-ink-secondary)]">{statusLabel(game)}</p>
        </div>
        {game.status === 'completed' && (
          <Trophy
            className={cn('h-5 w-5 shrink-0', iWon ? 'text-amber-500' : 'opacity-40')}
          />
        )}
      </div>

      <div className="space-y-2 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-ink-secondary)]">
          <Users className="h-3.5 w-3.5" />
          {joined.map((p) => (
            <span
              key={p.userId}
              className={cn(
                'rounded-full bg-black/[0.05] px-2 py-0.5 dark:bg-white/[0.08]',
                winners.has(p.userId) && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
                p.userId === myId && 'ring-1 ring-pulse-500/40'
              )}
            >
              {playerName(p)}
              {p.symbol ? ` (${p.symbol})` : ''}
              {typeof p.score === 'number' && game.gameType !== 'tic_tac_toe' && game.gameType !== 'connect_four'
                ? ` · ${p.score}`
                : ''}
            </span>
          ))}
        </div>

        {game.status === 'active' && game.currentTurnUserId && (
          <p className="text-xs font-medium text-pulse-600 dark:text-pulse-400">
            {myTurn ? 'Your turn' : 'Waiting for opponent…'}
          </p>
        )}

        {game.status === 'completed' && (
          <p className="text-xs font-medium">
            {game.isDraw
              ? 'It’s a draw!'
              : iWon
                ? 'You won! 🎉'
                : winners.size
                  ? 'Game over'
                  : 'Finished'}
          </p>
        )}

        {/* Boards */}
        {game.status === 'active' && meJoined && (
          <div className="pt-1">
            {game.gameType === 'tic_tac_toe' && (
              <TicTacToeBoard
                game={game}
                myId={myId}
                disabled={busy || !myTurn}
                onMove={(cell) =>
                  void run(() =>
                    gameService.action(game.id, { cell }, { expectedVersion: game.version })
                  )
                }
              />
            )}
            {game.gameType === 'connect_four' && (
              <ConnectFourBoard
                game={game}
                myId={myId}
                disabled={busy || !myTurn}
                onMove={(column) =>
                  void run(() =>
                    gameService.action(
                      game.id,
                      { column },
                      { expectedVersion: game.version }
                    )
                  )
                }
              />
            )}
            {game.gameType === 'trivia_duel' && (
              <TriviaBoard
                game={game}
                myId={myId}
                disabled={busy}
                onAnswer={(choice) =>
                  void run(() =>
                    gameService.action(
                      game.id,
                      { type: 'answer', choice },
                      { expectedVersion: game.version }
                    )
                  )
                }
                onResolve={() =>
                  void run(() =>
                    gameService.action(
                      game.id,
                      { type: 'resolve' },
                      { expectedVersion: game.version }
                    )
                  )
                }
              />
            )}
            {game.gameType === 'emoji_guess' && (
              <EmojiGuessBoard
                game={game}
                myId={myId}
                disabled={busy}
                onGuess={(guess) =>
                  void run(() =>
                    gameService.action(
                      game.id,
                      { type: 'guess', guess },
                      { expectedVersion: game.version }
                    )
                  )
                }
                onResolve={() =>
                  void run(() =>
                    gameService.action(
                      game.id,
                      { type: 'resolve' },
                      { expectedVersion: game.version }
                    )
                  )
                }
              />
            )}
          </div>
        )}

        {/* Read-only completed board peek for TTT/C4 */}
        {game.status === 'completed' &&
          (game.gameType === 'tic_tac_toe' || game.gameType === 'connect_four') && (
            <div className="pointer-events-none opacity-90">
              {game.gameType === 'tic_tac_toe' && (
                <TicTacToeBoard game={game} myId={myId} disabled onMove={() => {}} />
              )}
              {game.gameType === 'connect_four' && (
                <ConnectFourBoard game={game} myId={myId} disabled onMove={() => {}} />
              )}
            </div>
          )}

        <div className="flex flex-wrap gap-1.5 pt-1">
          {game.status === 'invited' && !meJoined && (
            <>
              <button
                type="button"
                disabled={busy}
                className="pressable rounded-full bg-pulse-500 px-3 py-1.5 text-xs font-semibold text-white"
                onClick={() => void run(() => gameService.join(game.id))}
              >
                Join
              </button>
              <button
                type="button"
                disabled={busy}
                className="pressable rounded-full bg-black/5 px-3 py-1.5 text-xs font-medium dark:bg-white/10"
                onClick={() => void run(() => gameService.decline(game.id))}
              >
                Decline
              </button>
            </>
          )}
          {game.status === 'invited' && isCreator && (
            <>
              {joined.length >= 2 && (
                <button
                  type="button"
                  disabled={busy}
                  className="pressable rounded-full bg-pulse-500 px-3 py-1.5 text-xs font-semibold text-white"
                  onClick={() => void run(() => gameService.start(game.id))}
                >
                  Start
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                className="pressable rounded-full bg-black/5 px-3 py-1.5 text-xs font-medium dark:bg-white/10"
                onClick={() => void run(() => gameService.cancel(game.id))}
              >
                Cancel
              </button>
            </>
          )}
          {game.status === 'invited' && meJoined && !isCreator && (
            <span className="text-[11px] opacity-60">Joined — waiting to start</span>
          )}
          {game.status === 'completed' && meJoined && (
            <button
              type="button"
              disabled={busy}
              className="pressable rounded-full bg-pulse-500 px-3 py-1.5 text-xs font-semibold text-white"
              onClick={() => void run(() => gameService.rematch(game.id))}
            >
              Rematch
            </button>
          )}
        </div>

        <p className="text-[10px] leading-snug text-[var(--color-ink-secondary)] opacity-70">
          Game moves are server-managed and not end-to-end encrypted — unlike your chat
          messages.
        </p>
      </div>
    </div>
  );
}
