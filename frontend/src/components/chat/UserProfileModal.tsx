import { useEffect, useState } from 'react';
import {
  AtSign,
  Mail,
  Calendar,
  FileText,
  Copy,
  Check,
  Ban,
  Flag,
  ShieldCheck,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { chatService } from '../../services/chat.service';
import { formatLastSeen } from '../../utils/format';
import { mediaUrl } from '../../utils/mediaUrl';
import { useAuthStore } from '../../store/authStore';
import { ensureIdentityKeys, safetyNumber } from '../../services/e2e';
import type { User } from '../../types';
import toast from 'react-hot-toast';
import { format, parseISO } from 'date-fns';

interface Props {
  open: boolean;
  userId: string | null;
  onClose: () => void;
  /** Optional seed data from the conversation while loading full profile */
  seed?: Partial<User> | null;
}

export function UserProfileModal({ open, userId, onClose, seed }: Props) {
  const me = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [profile, setProfile] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<'email' | 'username' | null>(null);
  const [safety, setSafety] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only re-fetch when open/userId changes — not when parent re-creates seed object
  useEffect(() => {
    if (!open || !userId) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Seed once from current props (not in deps to avoid fetch loop)
    if (seed) {
      setProfile({
        id: userId,
        username: seed.username || '',
        displayName: seed.displayName || seed.username || 'User',
        bio: seed.bio,
        avatar: seed.avatar,
        coverPhoto: seed.coverPhoto,
        isOnline: seed.isOnline,
        lastSeen: seed.lastSeen,
        email: seed.email,
      });
    }
    chatService
      .getUser(userId)
      .then((u) => {
        if (!cancelled) setProfile(u);
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load profile');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed is intentional one-shot
  }, [open, userId]);

  const copy = async (value: string, kind: 'email' | 'username') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      toast.success('Copied');
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };

  // Safety number (key fingerprint) for E2E verification
  useEffect(() => {
    if (!open || !userId || !me?.id || userId === me.id) {
      setSafety(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const myPub = await ensureIdentityKeys(me?.id);
        const their =
          profile?.identityPublicKey ||
          seed?.identityPublicKey ||
          (await chatService
            .getUser(userId)
            .then((u) => u.identityPublicKey)
            .catch(() => ''));
        if (!their || !myPub) {
          if (!cancelled) setSafety(null);
          return;
        }
        const sn = await safetyNumber(myPub, their);
        if (!cancelled) setSafety(sn);
      } catch {
        if (!cancelled) setSafety(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, userId, me?.id, profile?.identityPublicKey, seed?.identityPublicKey]);

  const isSelf = !!me?.id && !!userId && me.id === userId;
  const isBlocked = !!me?.blockedUsers?.includes(userId || '');

  const onBlock = async () => {
    if (!userId || isSelf) return;
    setBusy(true);
    try {
      if (isBlocked) {
        await chatService.unblockUser(userId);
        if (me) {
          setUser({
            ...me,
            blockedUsers: (me.blockedUsers || []).filter((id) => id !== userId),
          });
        }
        toast.success('User unblocked');
      } else {
        await chatService.blockUser(userId);
        if (me) {
          setUser({
            ...me,
            blockedUsers: [...(me.blockedUsers || []), userId],
          });
        }
        toast.success('User blocked');
      }
    } catch {
      toast.error(isBlocked ? 'Could not unblock' : 'Could not block user');
    } finally {
      setBusy(false);
    }
  };

  const onReport = async () => {
    if (!userId || isSelf) return;
    const reason = window.prompt(
      'Report reason (spam, harassment, hate, scam, impersonation, other):',
      'spam'
    );
    if (!reason) return;
    setBusy(true);
    try {
      await chatService.reportUser(userId, reason.trim().toLowerCase() || 'other');
      toast.success('Report submitted');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
          ?.error?.message || 'Could not submit report';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const name = profile?.displayName || seed?.displayName || 'User';
  const online = profile?.isOnline ?? seed?.isOnline;
  const lastSeen = profile?.lastSeen || seed?.lastSeen;
  const cover = profile?.coverPhoto || seed?.coverPhoto;
  const joined =
    profile?.createdAt &&
    (() => {
      try {
        const d =
          typeof profile.createdAt === 'string'
            ? parseISO(profile.createdAt)
            : new Date(profile.createdAt);
        return format(d, 'MMM d, yyyy');
      } catch {
        return null;
      }
    })();

  return (
    <Modal open={open} onClose={onClose} title="Contact info" size="sm">
      {/* Cover: 3:1 frame fully filled via object-fit:cover (inline styles) */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)]">
        <div
          className="relative w-full overflow-hidden rounded-t-2xl"
          style={{
            aspectRatio: '3 / 1',
            background:
              'linear-gradient(135deg, color-mix(in srgb, var(--color-pulse-500) 32%, transparent), color-mix(in srgb, #8b5cf6 22%, transparent))',
          }}
        >
          {cover ? (
            <img
              key={cover}
              src={mediaUrl(cover)}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'center',
                display: 'block',
              }}
            />
          ) : null}
        </div>
        <div className="relative flex flex-col items-center px-4 pb-4 text-center">
          <div className="relative z-[2] -mt-10">
            <Avatar
              src={profile?.avatar || seed?.avatar}
              name={name}
              size="xl"
              online={online}
              className="ring-4 ring-[var(--color-surface-elevated)]"
            />
          </div>
          <h3 className="mt-3 text-xl font-semibold tracking-[-0.03em]">{name}</h3>
          <p className="mt-1 text-sm tracking-[-0.01em] text-[var(--color-ink-secondary)]">
            {formatLastSeen(lastSeen, online)}
          </p>
          {loading && !profile?.email && !profile?.bio && (
            <div className="mt-3 w-full max-w-[12rem] space-y-2">
              <div className="skeleton mx-auto h-2.5 w-24" />
              <div className="skeleton mx-auto h-2.5 w-16" />
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 space-y-2">
        {(profile?.username || seed?.username) && (
          <InfoRow
            icon={<AtSign className="h-4 w-4" />}
            label="Username"
            value={`@${profile?.username || seed?.username}`}
            action={
              <button
                type="button"
                className="rounded-full p-2 text-[var(--color-ink-secondary)] active:bg-black/5"
                aria-label="Copy username"
                onClick={() =>
                  void copy(profile?.username || seed?.username || '', 'username')
                }
              >
                {copied === 'username' ? (
                  <Check className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            }
          />
        )}

        {profile?.email ? (
          <InfoRow
            icon={<Mail className="h-4 w-4" />}
            label="Email"
            value={profile.email}
            action={
              <button
                type="button"
                className="rounded-full p-2 text-[var(--color-ink-secondary)] active:bg-black/5"
                aria-label="Copy email"
                onClick={() => void copy(profile.email!, 'email')}
              >
                {copied === 'email' ? (
                  <Check className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            }
          />
        ) : (
          !loading && (
            <InfoRow
              icon={<Mail className="h-4 w-4" />}
              label="Email"
              value={
                profile?.emailHidden
                  ? 'Hidden by this user'
                  : 'Not available'
              }
              muted
            />
          )
        )}

        <InfoRow
          icon={<FileText className="h-4 w-4" />}
          label="About"
          value={
            (profile?.bio ?? seed?.bio)?.trim()
              ? (profile?.bio || seed?.bio || '').trim()
              : 'No bio yet'
          }
          muted={!(profile?.bio ?? seed?.bio)?.trim()}
        />

        {joined && (
          <InfoRow
            icon={<Calendar className="h-4 w-4" />}
            label="Joined Pulse"
            value={joined}
          />
        )}
      </div>

      {safety && (
        <div className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
          <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--color-ink-secondary)]">
            <ShieldCheck className="h-3.5 w-3.5 text-pulse-500" />
            Safety number
          </p>
          <p className="mt-1.5 break-all font-mono text-[11px] leading-relaxed tracking-wide">
            {safety}
          </p>
          <p className="mt-1.5 text-[11px] text-[var(--color-ink-secondary)]">
            Compare this number with your contact on another channel to verify encryption keys.
          </p>
        </div>
      )}

      {profile?.email && (
        <div className="mt-5">
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => {
              window.location.href = `mailto:${profile.email}`;
            }}
          >
            <Mail className="h-4 w-4" />
            Send email
          </Button>
        </div>
      )}

      {!isSelf && userId && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Button
            variant="secondary"
            className="w-full"
            loading={busy}
            onClick={() => void onBlock()}
          >
            <Ban className="h-4 w-4" />
            {isBlocked ? 'Unblock' : 'Block'}
          </Button>
          <Button
            variant="ghost"
            className="w-full text-red-600"
            loading={busy}
            onClick={() => void onReport()}
          >
            <Flag className="h-4 w-4" />
            Report
          </Button>
        </div>
      )}
    </Modal>
  );
}

function InfoRow({
  icon,
  label,
  value,
  action,
  muted,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  action?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 text-left transition-colors duration-150 hover:border-pulse-500/20">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pulse-500/10 text-pulse-500">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--color-ink-secondary)]">
          {label}
        </p>
        <p
          className={
            muted
              ? 'mt-0.5 break-words text-sm tracking-[-0.01em] text-[var(--color-ink-secondary)]'
              : 'mt-0.5 break-words text-sm font-medium tracking-[-0.01em]'
          }
        >
          {value}
        </p>
      </div>
      {action}
    </div>
  );
}
