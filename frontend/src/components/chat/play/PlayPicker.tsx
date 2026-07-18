import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { GameCatalogItem, GameTypeId } from '@/shared/types/game';
import { gameService } from '@/features/chat/services/gameService';
import { cn } from '@/utils/cn';
import toast from 'react-hot-toast';

interface Props {
  conversationId: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (gameId: string) => void;
}

export function PlayPicker({ conversationId, open, onClose, onCreated }: Props) {
  const [catalog, setCatalog] = useState<GameCatalogItem[]>([]);
  const [selected, setSelected] = useState<GameTypeId | null>(null);
  const [rounds, setRounds] = useState(5);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    void gameService
      .catalog()
      .then(setCatalog)
      .catch(() => toast.error('Could not load games'));
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const item = catalog.find((c) => c.type === selected);

  const create = async () => {
    if (!selected) return;
    setSending(true);
    try {
      const options: Record<string, unknown> = {};
      if (selected === 'trivia_duel' || selected === 'emoji_guess') {
        options.rounds = rounds;
      }
      const game = await gameService.create(conversationId, selected, options);
      toast.success('Game invite sent');
      onCreated?.(game.id);
      onClose();
    } catch {
      toast.error('Could not create game');
    } finally {
      setSending(false);
    }
  };

  // Portal to body so chat-pane overflow/transform never clips the 4th game
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Play a game"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        className={cn(
          'relative z-[1] flex w-full max-w-md flex-col',
          'max-h-[min(92dvh,40rem)] sm:max-h-[min(88vh,36rem)]',
          'rounded-t-3xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl sm:rounded-3xl'
        )}
      >
        {/* Sticky header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4 pb-3 pt-4">
          <div className="min-w-0 pr-2">
            <h2 className="text-lg font-semibold tracking-[-0.02em]">Pulse Play</h2>
            <p className="text-xs text-[var(--color-ink-secondary)]">
              Lightweight games in this chat
            </p>
          </div>
          <button
            type="button"
            className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable game list — all catalog items must be reachable */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 scrollbar-thin">
          <div className="grid gap-2 pb-1">
            {catalog.map((g) => (
              <button
                key={g.type}
                type="button"
                onClick={() => setSelected(g.type)}
                className={cn(
                  'flex min-h-[4.25rem] items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-colors',
                  selected === g.type
                    ? 'border-pulse-500/50 bg-pulse-500/10'
                    : 'border-[var(--color-border)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
                )}
              >
                <span className="text-2xl leading-none" aria-hidden>
                  {g.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold tracking-[-0.01em]">{g.displayName}</p>
                  <p className="text-xs leading-snug text-[var(--color-ink-secondary)]">
                    {g.description}
                  </p>
                  <p className="mt-0.5 text-[10px] opacity-60">
                    {g.minPlayers === g.maxPlayers
                      ? `${g.minPlayers} players`
                      : `${g.minPlayers}–${g.maxPlayers} players`}
                  </p>
                </div>
              </button>
            ))}
            {catalog.length === 0 && (
              <p className="py-6 text-center text-xs opacity-50">Loading games…</p>
            )}
          </div>

          {item && (item.type === 'trivia_duel' || item.type === 'emoji_guess') && (
            <label className="mt-3 flex items-center justify-between gap-3 text-sm">
              <span className="text-[var(--color-ink-secondary)]">Rounds</span>
              <select
                value={rounds}
                onChange={(e) => setRounds(Number(e.target.value))}
                className="rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1 text-sm"
              >
                {[3, 5, 7, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="mt-3 text-[11px] leading-snug text-[var(--color-ink-secondary)]">
            Game moves and scores are processed on Pulse servers and are{' '}
            <strong className="font-semibold">not end-to-end encrypted</strong>. Your regular
            messages still use chat E2E when enabled.
          </p>
        </div>

        {/* Sticky footer — always visible */}
        <div className="shrink-0 border-t border-[var(--color-border)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            disabled={!selected || sending}
            onClick={() => void create()}
            className="pressable w-full rounded-2xl bg-pulse-500 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {sending ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
