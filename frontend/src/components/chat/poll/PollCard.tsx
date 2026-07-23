/**
 * Interactive poll card — votes and tallies from the server (not E2E).
 */
import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Check, Loader2, Lock } from 'lucide-react';
import type { PulsePoll } from '@/shared/types/poll';
import { pollService } from '@/features/chat/services/pollService';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';
import toast from 'react-hot-toast';

interface Props {
  pollId: string;
  initial?: PulsePoll | null;
}

export function PollCard({ pollId, initial }: Props) {
  const myId = useAuthStore((s) => s.user?.id) || '';
  const [poll, setPoll] = useState<PulsePoll | null>(initial || null);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const p = await pollService.get(pollId);
      setPoll(p);
      setPending(p.myOptionIds || []);
    } catch {
      /* keep previous */
    } finally {
      setLoading(false);
    }
  }, [pollId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onUpd = (e: Event) => {
      const detail = (e as CustomEvent).detail as PulsePoll | undefined;
      if (detail?.id !== pollId) return;
      // Re-fetch so myOptionIds match this viewer (broadcast is not user-specific)
      void pollService
        .get(pollId)
        .then((p) => {
          setPoll(p);
          setPending(p.myOptionIds || []);
        })
        .catch(() => {
          setPoll(detail);
        });
    };
    window.addEventListener('pulse:poll-updated', onUpd);
    return () => window.removeEventListener('pulse:poll-updated', onUpd);
  }, [pollId]);

  const toggleOption = (optionId: string) => {
    if (!poll || poll.isClosed || busy) return;
    if (poll.allowMultiple) {
      setPending((prev) =>
        prev.includes(optionId) ? prev.filter((id) => id !== optionId) : [...prev, optionId]
      );
    } else {
      setPending([optionId]);
    }
  };

  const submitVote = async () => {
    if (!poll || poll.isClosed || !pending.length) return;
    setBusy(true);
    try {
      const p = await pollService.vote(pollId, pending);
      setPoll(p);
      setPending(p.myOptionIds || []);
    } catch {
      toast.error('Could not record vote');
    } finally {
      setBusy(false);
    }
  };

  const closePoll = async () => {
    if (!poll || poll.isClosed) return;
    setBusy(true);
    try {
      const p = await pollService.close(pollId);
      setPoll(p);
      toast.success('Poll closed');
    } catch {
      toast.error('Could not close poll');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !poll) {
    return (
      <div className="flex min-h-[5rem] w-[min(85vw,20rem)] items-center justify-center rounded-2xl bg-black/[0.04] dark:bg-white/[0.06]">
        <Loader2 className="h-5 w-5 animate-spin opacity-50" />
      </div>
    );
  }
  if (!poll) {
    return (
      <div className="rounded-2xl bg-black/[0.04] px-3 py-2 text-xs opacity-70 dark:bg-white/[0.06]">
        Poll unavailable
      </div>
    );
  }

  const total = Math.max(1, poll.totalVotes);
  const isCreator = myId && poll.creator === myId;
  const hasVoted = (poll.myOptionIds?.length || 0) > 0;
  const selectionChanged =
    pending.length !== (poll.myOptionIds?.length || 0) ||
    pending.some((id) => !poll.myOptionIds.includes(id));
  const showResults = hasVoted || poll.isClosed;

  return (
    <div
      className={cn(
        'w-[min(88vw,22rem)] rounded-2xl border border-[var(--color-border)]',
        'bg-[var(--color-surface)] p-3 shadow-sm'
      )}
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-pulse-500/15 text-pulse-600 dark:text-pulse-400">
          <BarChart3 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-secondary)]">
            Poll
            {poll.isAnonymous ? ' · Anonymous' : ''}
            {poll.allowMultiple ? ' · Multi' : ''}
          </p>
          <p className="text-sm font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
            {poll.question}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        {poll.options.map((opt) => {
          const selected = pending.includes(opt.id);
          const pct = showResults ? Math.round(((opt.voteCount || 0) / total) * 100) : 0;
          const isMine = poll.myOptionIds.includes(opt.id);
          return (
            <button
              key={opt.id}
              type="button"
              disabled={poll.isClosed || busy}
              onClick={() => toggleOption(opt.id)}
              className={cn(
                'relative w-full overflow-hidden rounded-xl border px-3 py-2.5 text-left text-sm transition',
                selected
                  ? 'border-pulse-500/50 bg-pulse-500/10'
                  : 'border-[var(--color-border)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
                poll.isClosed && 'cursor-default opacity-90'
              )}
            >
              {showResults && (
                <span
                  className="absolute inset-y-0 left-0 bg-pulse-500/15 transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              )}
              <span className="relative z-[1] flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 font-medium">
                  {selected && <Check className="h-3.5 w-3.5 shrink-0 text-pulse-600" />}
                  <span className="truncate">{opt.text}</span>
                  {isMine && showResults && (
                    <span className="text-[10px] font-semibold text-pulse-600">yours</span>
                  )}
                </span>
                {showResults && (
                  <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-secondary)]">
                    {opt.voteCount} · {pct}%
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {!poll.isClosed && (
          <button
            type="button"
            disabled={busy || !pending.length || (!selectionChanged && hasVoted)}
            onClick={() => void submitVote()}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-semibold transition',
              'bg-pulse-500 text-white hover:bg-pulse-600 disabled:opacity-40'
            )}
          >
            {busy ? '…' : hasVoted ? 'Update vote' : 'Vote'}
          </button>
        )}
        {isCreator && !poll.isClosed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void closePoll()}
            className="rounded-full px-3 py-1.5 text-xs font-semibold text-[var(--color-ink-secondary)] hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          >
            Close poll
          </button>
        )}
        <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-ink-secondary)]">
          {poll.isClosed ? (
            <>
              <Lock className="h-3 w-3" /> Closed · {poll.totalVotes} vote
              {poll.totalVotes === 1 ? '' : 's'}
            </>
          ) : (
            <>
              {poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}
              {!hasVoted && !showResults ? ' · vote to see results' : ''}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
