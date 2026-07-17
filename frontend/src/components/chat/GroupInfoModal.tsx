import { useMemo, useState } from 'react';
import { Crown, Shield, User as UserIcon } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useAuthStore } from '../../store/authStore';
import type { Conversation, Participant } from '../../types';
import { cn } from '../../utils/cn';
import { formatLastSeen } from '../../utils/format';

interface Props {
  open: boolean;
  conversation: Conversation | null;
  onClose: () => void;
  /** Open a member's profile */
  onSelectMember: (userId: string) => void;
}

function roleLabel(role?: string) {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Member';
}

function RoleIcon({ role }: { role?: string }) {
  if (role === 'owner') return <Crown className="h-3.5 w-3.5 text-amber-500" />;
  if (role === 'admin') return <Shield className="h-3.5 w-3.5 text-pulse-500" />;
  return <UserIcon className="h-3.5 w-3.5 text-[var(--color-ink-secondary)]" />;
}

export function GroupInfoModal({ open, conversation, onClose, onSelectMember }: Props) {
  const meId = useAuthStore((s) => s.user?.id);
  const [query, setQuery] = useState('');

  const members = useMemo(() => {
    const list = conversation?.participants || [];
    // Owner / admin first, then A–Z
    const rank = (p: Participant) =>
      p.role === 'owner' ? 0 : p.role === 'admin' ? 1 : 2;
    return [...list].sort((a, b) => {
      const rd = rank(a) - rank(b);
      if (rd !== 0) return rd;
      const an = (a.user.displayName || a.user.username || '').toLowerCase();
      const bn = (b.user.displayName || b.user.username || '').toLowerCase();
      return an.localeCompare(bn);
    });
  }, [conversation?.participants]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (p) =>
        p.user.displayName?.toLowerCase().includes(q) ||
        p.user.username?.toLowerCase().includes(q)
    );
  }, [members, query]);

  if (!conversation) return null;

  return (
    <Modal
      open={open}
      onClose={() => {
        setQuery('');
        onClose();
      }}
      title="Group info"
      size="sm"
    >
      <div className="flex flex-col items-center text-center">
        <Avatar src={conversation.avatar} name={conversation.displayName} size="xl" />
        <h3 className="mt-3 text-xl font-semibold tracking-[-0.03em]">
          {conversation.displayName}
        </h3>
        {conversation.description?.trim() ? (
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-[var(--color-ink-secondary)]">
            {conversation.description.trim()}
          </p>
        ) : null}
        <p className="mt-1 text-xs font-medium text-[var(--color-ink-secondary)]">
          {members.length} {members.length === 1 ? 'member' : 'members'}
        </p>
      </div>

      <div className="mt-5">
        <label className="mb-1.5 block text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--color-ink-secondary)]">
          Members
        </label>
        {members.length > 6 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members…"
            className="mb-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-pulse-500 focus:ring-2 focus:ring-pulse-500/15"
          />
        )}
        <div className="max-h-[min(50dvh,20rem)] space-y-1 overflow-y-auto overscroll-contain scrollbar-thin">
          {filtered.map((p) => {
            const uid = p.user.id;
            const isMe = uid === meId;
            return (
              <button
                key={uid || p.user.username}
                type="button"
                disabled={!uid}
                onClick={() => {
                  if (!uid) return;
                  onClose();
                  onSelectMember(uid);
                }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-2xl border border-transparent px-2.5 py-2.5 text-left transition-colors',
                  'hover:border-[var(--color-border)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
                  'active:bg-black/[0.05] disabled:opacity-60'
                )}
              >
                <Avatar
                  src={p.user.avatar}
                  name={p.user.displayName || p.user.username}
                  size="md"
                  online={p.user.isOnline}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold tracking-[-0.01em]">
                    {p.user.displayName || p.user.username}
                    {isMe ? (
                      <span className="ml-1.5 text-xs font-medium text-pulse-500">You</span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-[var(--color-ink-secondary)]">
                    @{p.user.username}
                    {!isMe && p.user.lastSeen
                      ? ` · ${formatLastSeen(p.user.lastSeen, p.user.isOnline)}`
                      : ''}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-secondary)] dark:bg-white/[0.06]">
                  <RoleIcon role={p.role} />
                  {roleLabel(p.role)}
                </span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="py-6 text-center text-sm text-[var(--color-ink-secondary)]">
              No members match
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
