import { useEffect, useMemo, useState } from 'react';
import { Phone, Video, Check } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Avatar } from '../ui/Avatar';
import { cn } from '../../utils/cn';
import type { Conversation, CallType } from '../../types';
import { useAuthStore } from '../../store/authStore';

interface GroupCallPickerProps {
  open: boolean;
  onClose: () => void;
  conversation: Conversation;
  /** When set, invite into an existing call instead of starting a new one. */
  mode?: 'start' | 'invite';
  /** User IDs already in the call (joined or invited) — excluded from invite list. */
  excludeUserIds?: string[];
  defaultCallType?: CallType;
  /** Stack above CallOverlay (z-100). */
  elevated?: boolean;
  onConfirm: (opts: { inviteUserIds: string[]; callType: CallType }) => void;
}

/**
 * Pick group members to ring for a multi-party call, or add mid-call.
 */
export function GroupCallPicker({
  open,
  onClose,
  conversation,
  mode = 'start',
  excludeUserIds = [],
  defaultCallType = 'audio',
  elevated = false,
  onConfirm,
}: GroupCallPickerProps) {
  const meId = useAuthStore((s) => s.user?.id);
  const [callType, setCallType] = useState<CallType>(
    defaultCallType === 'screen' ? 'video' : defaultCallType
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const candidates = useMemo(() => {
    const excl = new Set(excludeUserIds.map(String));
    if (meId) excl.add(meId);
    return (conversation.participants || [])
      .map((p) => p.user)
      .filter((u) => u?.id && !excl.has(u.id));
  }, [conversation.participants, excludeUserIds, meId]);

  // Reset selection when opened
  useEffect(() => {
    if (!open) return;
    if (mode === 'start') {
      setSelected(new Set(candidates.map((u) => u.id)));
    } else {
      setSelected(new Set());
    }
    setCallType(defaultCallType === 'screen' ? 'video' : defaultCallType || 'audio');
    // Only re-init when the modal opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(candidates.map((u) => u.id)));
  const clearAll = () => setSelected(new Set());

  const confirm = () => {
    const inviteUserIds = [...selected];
    if (!inviteUserIds.length) return;
    onConfirm({ inviteUserIds, callType });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'invite' ? 'Add people to call' : 'Start group call'}
      size="md"
      elevated={elevated || mode === 'invite'}
    >
      <div className="space-y-4">
        {mode === 'start' && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCallType('audio')}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors',
                callType === 'audio'
                  ? 'border-pulse-500/40 bg-pulse-500/15 text-pulse-600 dark:text-pulse-300'
                  : 'border-[var(--color-border)] text-[var(--color-ink-secondary)] hover:bg-[var(--color-surface-hover)]'
              )}
            >
              <Phone className="h-4 w-4" /> Voice
            </button>
            <button
              type="button"
              onClick={() => setCallType('video')}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors',
                callType === 'video'
                  ? 'border-pulse-500/40 bg-pulse-500/15 text-pulse-600 dark:text-pulse-300'
                  : 'border-[var(--color-border)] text-[var(--color-ink-secondary)] hover:bg-[var(--color-surface-hover)]'
              )}
            >
              <Video className="h-4 w-4" /> Video
            </button>
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-[var(--color-ink-muted)]">
          <span>
            {selected.size} of {candidates.length} selected
          </span>
          <div className="flex gap-2">
            <button type="button" className="font-medium text-pulse-500 hover:underline" onClick={selectAll}>
              All
            </button>
            <button type="button" className="font-medium hover:underline" onClick={clearAll}>
              Clear
            </button>
          </div>
        </div>

        <ul className="max-h-[min(50vh,20rem)] space-y-1 overflow-y-auto overscroll-contain pr-0.5">
          {candidates.length === 0 ? (
            <li className="py-8 text-center text-sm text-[var(--color-ink-muted)]">
              {mode === 'invite' ? 'Everyone is already on the call' : 'No other members'}
            </li>
          ) : (
            candidates.map((u) => {
              const on = selected.has(u.id);
              const name = u.displayName || u.username || 'User';
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => toggle(u.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors',
                      on
                        ? 'bg-pulse-500/12 ring-1 ring-pulse-500/25'
                        : 'hover:bg-[var(--color-surface-hover)]'
                    )}
                  >
                    <Avatar src={u.avatar} name={name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--color-ink)]">{name}</p>
                      {u.username && (
                        <p className="truncate text-xs text-[var(--color-ink-muted)]">@{u.username}</p>
                      )}
                    </div>
                    <span
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded-full border',
                        on
                          ? 'border-pulse-500 bg-pulse-500 text-white'
                          : 'border-[var(--color-border)] text-transparent'
                      )}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            disabled={!selected.size}
            onClick={confirm}
          >
            {mode === 'invite'
              ? `Add (${selected.size})`
              : callType === 'video'
                ? `Video call (${selected.size})`
                : `Voice call (${selected.size})`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
