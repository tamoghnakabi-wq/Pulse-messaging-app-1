import { useEffect, useState, type FormEvent } from 'react';
import {
  User,
  Palette,
  Shield,
  Bell,
  Lock,
  Monitor,
  LogOut,
  Camera,
  ImagePlus,
  Trash2,
  KeyRound,
  Smartphone,
  Tablet,
  Clock,
  MapPin,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Avatar } from '../ui/Avatar';
import { ImageCropModal, type CropShape } from '../ui/ImageCropModal';
import { PasswordStrength, passwordErrors, scorePassword } from '../ui/PasswordStrength';
import { useUIStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { chatService } from '../../services/chat.service';
import { authService } from '../../services/auth.service';
import { cn } from '../../utils/cn';
import { mediaUrl } from '../../utils/mediaUrl';
import { CHAT_BACKGROUNDS } from '../../shared/lib/chatBackgrounds';
import toast from 'react-hot-toast';
import type { SessionInfo } from '../../types';

const tabs = [
  { id: 'profile' as const, label: 'Profile', icon: User },
  { id: 'theme' as const, label: 'Theme', icon: Palette },
  { id: 'privacy' as const, label: 'Privacy', icon: Shield },
  { id: 'notifications' as const, label: 'Notifications', icon: Bell },
  { id: 'security' as const, label: 'Security', icon: Lock },
];

export function SettingsModal() {
  const open = useUIStore((s) => s.showSettings);
  const setOpen = useUIStore((s) => s.setShowSettings);
  const tab = useUIStore((s) => s.settingsTab);
  const setTab = useUIStore((s) => s.setSettingsTab);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const chatBackground = useUIStore((s) => s.chatBackground);
  const setChatBackground = useUIStore((s) => s.setChatBackground);
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);
  const logoutEverywhere = useAuthStore((s) => s.logoutEverywhere);
  const refreshUser = useAuthStore((s) => s.refreshUser);

  const [profile, setProfile] = useState({
    displayName: '',
    username: '',
    bio: '',
  });
  const [passwords, setPasswords] = useState({ current: '', next: '' });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [saving, setSaving] = useState(false);
  /** In-progress crop after picking a file */
  const [crop, setCrop] = useState<{
    src: string;
    shape: CropShape;
  } | null>(null);

  useEffect(() => {
    if (user) {
      setProfile({
        displayName: user.displayName || '',
        username: user.username || '',
        bio: user.bio || '',
      });
    }
  }, [user, open]);

  useEffect(() => {
    if (open && tab === 'security') {
      authService.getSessions().then(setSessions).catch(() => undefined);
    }
  }, [open, tab]);

  // Restore Settings after Safari reload mid–2FA setup (app switch to Authenticator)
  useEffect(() => {
    try {
      if (sessionStorage.getItem('pulse_settings_open') === '1') {
        setOpen(true);
        const t = sessionStorage.getItem('pulse_settings_tab');
        if (t === 'security' || t === 'profile' || t === 'privacy' || t === 'theme' || t === 'notifications') {
          setTab(t);
        } else {
          setTab('security');
        }
      }
    } catch {
      /* */
    }
  }, [setOpen, setTab]);

  // Revoke object URLs when crop closes
  useEffect(() => {
    return () => {
      if (crop?.src?.startsWith('blob:')) URL.revokeObjectURL(crop.src);
    };
  }, [crop]);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await chatService.updateProfile(profile);
      setUser(updated);
      toast.success('Profile updated');
    } catch {
      toast.error('Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const pickImage = (shape: CropShape, file?: File | null) => {
    if (!file || !file.type.startsWith('image/')) {
      if (file) toast.error('Please choose an image file');
      return;
    }
    if (crop?.src?.startsWith('blob:')) URL.revokeObjectURL(crop.src);
    setCrop({ src: URL.createObjectURL(file), shape });
  };

  const closeCrop = () => {
    if (crop?.src?.startsWith('blob:')) URL.revokeObjectURL(crop.src);
    setCrop(null);
  };

  const onCropConfirm = async (file: File) => {
    try {
      if (crop?.shape === 'circle') {
        const updated = await chatService.uploadAvatar(file);
        setUser(updated);
        toast.success('Profile photo updated');
      } else {
        const updated = await chatService.uploadCoverPhoto(file);
        setUser(updated);
        toast.success('Cover photo updated');
      }
      closeCrop();
    } catch {
      toast.error('Upload failed');
    }
  };

  const removeCover = async () => {
    try {
      const updated = await chatService.removeCoverPhoto();
      setUser(updated);
      toast.success('Cover photo removed');
    } catch {
      toast.error('Could not remove cover');
    }
  };

  const saveSettings = async (partial: Record<string, unknown>) => {
    try {
      await chatService.updateSettings(partial);
      await refreshUser();
      toast.success('Settings saved');
    } catch {
      toast.error('Failed to save');
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    const errs = passwordErrors(passwords.next);
    if (errs.length || scorePassword(passwords.next) < 2) {
      toast.error(errs[0] || 'Please choose a stronger password');
      return;
    }
    try {
      await chatService.changePassword(passwords.current, passwords.next);
      setPasswords({ current: '', next: '' });
      toast.success('Password changed');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
          ?.error?.message || 'Could not change password';
      toast.error(msg);
    }
  };

  return (
    <>
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Settings"
      size="lg"
      stableHeight
      bodyScroll={false}
    >
      <div className="flex h-full min-h-0 flex-col gap-0 sm:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-border)] px-3 py-2.5 scrollbar-thin sm:w-44 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden sm:border-b-0 sm:border-r sm:px-3 sm:py-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium tracking-[-0.01em] whitespace-nowrap transition-[background-color,color,box-shadow,border-color] duration-200 touch-manipulation',
                  tab === t.id
                    ? 'bg-pulse-500/12 text-pulse-600 ring-1 ring-pulse-500/15 dark:text-pulse-300'
                    : 'text-[var(--color-ink-secondary)] hover:bg-black/5 dark:hover:bg-white/5'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {t.label}
              </button>
            );
          })}
        </nav>

        {/* Fixed-height body: only this pane scrolls when tab content changes */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-5 scrollbar-thin">
          <div className="min-w-0 space-y-1">
          {tab === 'profile' && (
            <form onSubmit={saveProfile} className="space-y-4">
              {/* Cover banner: fixed 3:1 box + img object-fit cover (inline styles — no black letterbox) */}
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)]">
                <div
                  className="relative w-full overflow-hidden rounded-t-2xl"
                  style={{
                    aspectRatio: '3 / 1',
                    background:
                      'linear-gradient(135deg, color-mix(in srgb, var(--color-pulse-500) 32%, transparent), color-mix(in srgb, #8b5cf6 22%, transparent))',
                  }}
                >
                  {user?.coverPhoto ? (
                    <img
                      key={user.coverPhoto}
                      src={mediaUrl(user.coverPhoto)}
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
                  <div className="absolute inset-x-0 bottom-0 z-[1] flex justify-end gap-1.5 p-2">
                    <label className="pressable flex cursor-pointer items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1.5 text-[11px] font-semibold text-white backdrop-blur-sm hover:bg-black/65">
                      <ImagePlus className="h-3.5 w-3.5" />
                      {user?.coverPhoto ? 'Change cover' : 'Add cover'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          pickImage('rect', f);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {user?.coverPhoto && (
                      <button
                        type="button"
                        className="pressable flex items-center gap-1 rounded-full bg-black/50 px-2.5 py-1.5 text-[11px] font-semibold text-white backdrop-blur-sm hover:bg-red-600/90"
                        onClick={() => void removeCover()}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                <div className="relative px-4 pb-4 pt-3">
                  <div className="absolute left-4 top-0 z-[2] -translate-y-1/2">
                    <div className="relative">
                      <Avatar
                        src={user?.avatar}
                        name={user?.displayName}
                        size="xl"
                        className="ring-4 ring-[var(--color-surface-elevated)]"
                      />
                      <label
                        className="pressable absolute bottom-0 right-0 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-pulse-500 text-white shadow-lg shadow-pulse-500/30 transition-transform hover:scale-105"
                        title="Change profile photo (circular)"
                      >
                        <Camera className="h-4 w-4" />
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            pickImage('circle', f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="min-w-0 pl-[5.5rem] pt-1">
                    <p className="truncate font-semibold tracking-[-0.02em]">{user?.displayName}</p>
                    <p className="truncate text-sm tracking-[-0.01em] text-[var(--color-ink-secondary)]">
                      @{user?.username}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[var(--color-ink-secondary)]">
                      Profile photo is always circular
                    </p>
                  </div>
                </div>
              </div>
              <Input
                label="Display name"
                value={profile.displayName}
                onChange={(e) => setProfile({ ...profile, displayName: e.target.value })}
              />
              <Input
                label="Username"
                value={profile.username}
                onChange={(e) => setProfile({ ...profile, username: e.target.value })}
              />
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-secondary)]">
                  Bio
                </label>
                <textarea
                  value={profile.bio}
                  onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
                  maxLength={300}
                  rows={3}
                  className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-4 py-2.5 text-[15px] tracking-[-0.01em] outline-none transition-[border-color,box-shadow] duration-200 focus:border-pulse-500 focus:ring-4 focus:ring-pulse-500/12 sm:text-sm"
                />
              </div>
              <Button type="submit" loading={saving}>
                Save profile
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={async () => {
                  await logout();
                  setOpen(false);
                  toast.success('Signed out');
                }}
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
            </form>
          )}

          {tab === 'theme' && (
            <div className="space-y-6">
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold tracking-[-0.02em]">Appearance</h3>
                  <p className="mt-0.5 text-sm text-[var(--color-ink-secondary)]">
                    Light, dark, or match your system
                  </p>
                </div>
                {(
                  [
                    { id: 'light', label: 'Light', icon: '☀️' },
                    { id: 'dark', label: 'Dark', icon: '🌙' },
                    { id: 'system', label: 'System', icon: '💻' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setTheme(opt.id);
                      void saveSettings({ theme: opt.id });
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-[border-color,background-color,box-shadow] duration-200',
                      theme === opt.id
                        ? 'border-pulse-500 bg-pulse-500/10 shadow-sm shadow-pulse-500/10'
                        : 'border-[var(--color-border)] hover:bg-black/5 dark:hover:bg-white/5'
                    )}
                  >
                    <span className="text-xl">{opt.icon}</span>
                    <span className="font-medium">{opt.label}</span>
                  </button>
                ))}
              </div>

              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold tracking-[-0.02em]">Chat background</h3>
                  <p className="mt-0.5 text-sm text-[var(--color-ink-secondary)]">
                    Wallpaper for your conversation view
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {CHAT_BACKGROUNDS.map((bg) => {
                    const active = chatBackground === bg.id;
                    return (
                      <button
                        key={bg.id}
                        type="button"
                        onClick={() => {
                          setChatBackground(bg.id);
                          void saveSettings({ chatBackground: bg.id });
                        }}
                        className={cn(
                          'group flex flex-col overflow-hidden rounded-2xl border text-left transition-[border-color,box-shadow,transform] duration-200',
                          active
                            ? 'border-pulse-500 shadow-md shadow-pulse-500/15 ring-2 ring-pulse-500/25'
                            : 'border-[var(--color-border)] hover:border-pulse-500/40 hover:shadow-sm'
                        )}
                      >
                        <div
                          className="relative h-16 w-full sm:h-[4.5rem]"
                          style={{ background: bg.preview }}
                        >
                          {active && (
                            <span className="absolute right-1.5 top-1.5 rounded-full bg-pulse-500 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
                              On
                            </span>
                          )}
                          {/* Mini message bubbles preview */}
                          <div className="absolute inset-x-2 bottom-2 flex flex-col gap-1">
                            <div className="h-2 w-[42%] rounded-full bg-white/70 shadow-sm dark:bg-white/25" />
                            <div className="ml-auto h-2 w-[48%] rounded-full bg-pulse-500/80 shadow-sm" />
                          </div>
                        </div>
                        <div className="px-2.5 py-2">
                          <p className="truncate text-xs font-semibold tracking-[-0.01em]">
                            {bg.label}
                          </p>
                          <p className="truncate text-[11px] text-[var(--color-ink-secondary)]">
                            {bg.description}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === 'privacy' && (
            <div className="space-y-4">
              <Toggle
                label="Show my email"
                description="People you chat with can see the email you signed up with on your contact info"
                checked={user?.settings?.privacy?.showEmail !== false}
                onChange={(v) => void saveSettings({ privacy: { showEmail: v } })}
              />
              <Toggle
                label="Read receipts"
                description="Let others know when you've read their messages"
                checked={user?.settings?.privacy?.readReceipts !== false}
                onChange={(v) => void saveSettings({ privacy: { readReceipts: v } })}
              />
              <SelectRow
                label="Last seen"
                value={user?.settings?.privacy?.lastSeen || 'everyone'}
                options={[
                  { value: 'everyone', label: 'Everyone' },
                  { value: 'contacts', label: 'Contacts' },
                  { value: 'nobody', label: 'Nobody' },
                ]}
                onChange={(v) => void saveSettings({ privacy: { lastSeen: v } })}
              />
              <SelectRow
                label="Profile photo"
                value={user?.settings?.privacy?.profilePhoto || 'everyone'}
                options={[
                  { value: 'everyone', label: 'Everyone' },
                  { value: 'contacts', label: 'Contacts' },
                  { value: 'nobody', label: 'Nobody' },
                ]}
                onChange={(v) => void saveSettings({ privacy: { profilePhoto: v } })}
              />
              <SelectRow
                label="Online status"
                value={user?.settings?.privacy?.onlineStatus || 'everyone'}
                options={[
                  { value: 'everyone', label: 'Everyone' },
                  { value: 'contacts', label: 'Contacts' },
                  { value: 'nobody', label: 'Nobody' },
                ]}
                onChange={(v) => void saveSettings({ privacy: { onlineStatus: v } })}
              />
              <SelectRow
                label="Who can call me"
                value={user?.settings?.privacy?.calls || 'everyone'}
                options={[
                  { value: 'everyone', label: 'Everyone' },
                  { value: 'contacts', label: 'Contacts' },
                  { value: 'nobody', label: 'Nobody' },
                ]}
                onChange={(v) => void saveSettings({ privacy: { calls: v } })}
              />
            </div>
          )}

          {tab === 'notifications' && (
            <div className="space-y-4">
              <Toggle
                label="Browser notifications"
                description="Show desktop notifications for new messages"
                checked={user?.settings?.notifications?.browser !== false}
                onChange={(v) => {
                  if (v && 'Notification' in window) void Notification.requestPermission();
                  void saveSettings({ notifications: { browser: v } });
                }}
              />
              <Toggle
                label="Sound"
                description="Play a sound for incoming messages"
                checked={user?.settings?.notifications?.sound !== false}
                onChange={(v) => void saveSettings({ notifications: { sound: v } })}
              />
              <Toggle
                label="Mentions"
                description="Notify when someone mentions you"
                checked={user?.settings?.notifications?.mentions !== false}
                onChange={(v) => void saveSettings({ notifications: { mentions: v } })}
              />
              <Toggle
                label="Messages"
                description="Notify for all new messages"
                checked={user?.settings?.notifications?.messages !== false}
                onChange={(v) => void saveSettings({ notifications: { messages: v } })}
              />
            </div>
          )}

          {tab === 'security' && (
            <div className="space-y-6">
              <form onSubmit={changePassword} className="space-y-3">
                <h3 className="font-semibold">Change password</h3>
                <Input
                  type="password"
                  label="Current password"
                  value={passwords.current}
                  onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                  required
                />
                <Input
                  type="password"
                  label="New password"
                  value={passwords.next}
                  onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
                  required
                  minLength={8}
                  maxLength={72}
                />
                <PasswordStrength password={passwords.next} />
                <Button type="submit">Update password</Button>
              </form>

              <TwoFactorSection
                enabled={!!user?.twoFactorEnabled}
                emailVerified={!!user?.isEmailVerified}
                onChanged={() => void refreshUser()}
              />

              <div>
                <h3 className="mb-1 flex items-center gap-2 font-semibold tracking-[-0.02em]">
                  <Monitor className="h-4 w-4" /> Active sessions
                </h3>
                <p className="mb-3 text-xs leading-relaxed text-[var(--color-ink-secondary)]">
                  Devices signed in to your account. Revoke any you don’t recognize.
                </p>
                <div className="space-y-2">
                  {sessions.length === 0 && (
                    <p className="rounded-2xl border border-dashed border-[var(--color-border)] px-3.5 py-4 text-center text-sm text-[var(--color-ink-secondary)]">
                      No active sessions found
                    </p>
                  )}
                  {sessions.map((s) => {
                    const device = s.device;
                    const DeviceIcon =
                      device?.type === 'mobile'
                        ? Smartphone
                        : device?.type === 'tablet'
                          ? Tablet
                          : Monitor;
                    const title =
                      device?.label ||
                      (s.userAgent ? s.userAgent.slice(0, 48) : 'Unknown device');
                    const activity =
                      s.current || s.isOnline
                        ? 'Active now'
                        : s.activityLabel ||
                          (s.lastActiveAt
                            ? `Last active ${new Date(s.lastActiveAt).toLocaleString()}`
                            : 'Unknown');
                    return (
                      <div
                        key={s.id}
                        className="device-card flex items-start justify-between gap-3 px-3.5 py-3 text-sm"
                      >
                        <div className="flex min-w-0 flex-1 gap-3">
                          <div
                            className={cn(
                              'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                              s.current
                                ? 'bg-pulse-500/12 text-pulse-600 dark:text-pulse-300'
                                : 'bg-black/[0.04] text-[var(--color-ink-secondary)] dark:bg-white/[0.06]'
                            )}
                          >
                            <DeviceIcon className="h-5 w-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="truncate font-semibold tracking-[-0.015em]">
                                {title}
                              </p>
                              {s.current && (
                                <span className="rounded-full bg-pulse-500/12 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-pulse-600 dark:text-pulse-300">
                                  This device
                                </span>
                              )}
                              {(s.current || s.isOnline) && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                  Online
                                </span>
                              )}
                            </div>
                            <div className="mt-1 space-y-0.5 text-xs tracking-[-0.01em] text-[var(--color-ink-secondary)]">
                              {(device?.browser || device?.os) && (
                                <p className="truncate">
                                  {[device?.browser, device?.os].filter(Boolean).join(' · ')}
                                </p>
                              )}
                              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span className="inline-flex items-center gap-1">
                                  <MapPin className="h-3 w-3 shrink-0 opacity-70" />
                                  {s.ip || 'Unknown IP'}
                                </span>
                                <span className="inline-flex items-center gap-1">
                                  <Clock className="h-3 w-3 shrink-0 opacity-70" />
                                  {activity}
                                </span>
                              </p>
                              {s.createdAt && (
                                <p className="text-[11px] opacity-80">
                                  Signed in{' '}
                                  {new Date(s.createdAt).toLocaleString(undefined, {
                                    dateStyle: 'medium',
                                    timeStyle: 'short',
                                  })}
                                  {s.expiresAt
                                    ? ` · Expires ${new Date(s.expiresAt).toLocaleDateString()}`
                                    : ''}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                        {!s.current && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 text-red-500 hover:text-red-600"
                            onClick={async () => {
                              try {
                                await authService.revokeSession(s.id);
                                setSessions((prev) => prev.filter((x) => x.id !== s.id));
                                toast.success('Session revoked');
                              } catch {
                                toast.error('Could not revoke session');
                              }
                            }}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <Button
                variant="danger"
                onClick={async () => {
                  await logoutEverywhere();
                  setOpen(false);
                  toast.success('Logged out everywhere');
                }}
              >
                <LogOut className="h-4 w-4" />
                Log out everywhere
              </Button>
            </div>
          )}
          </div>
        </div>
      </div>
    </Modal>

    <ImageCropModal
      open={!!crop}
      imageSrc={crop?.src ?? null}
      shape={crop?.shape ?? 'circle'}
      title={crop?.shape === 'rect' ? 'Crop cover photo' : 'Crop profile photo'}
      confirmLabel="Upload"
      onCancel={closeCrop}
      onConfirm={onCropConfirm}
    />
    </>
  );
}

const TFA_SETUP_KEY = 'pulse_2fa_setup_pending';

function persist2FASetup(data: { secret: string; otpauth: string } | null) {
  try {
    if (!data) sessionStorage.removeItem(TFA_SETUP_KEY);
    else sessionStorage.setItem(TFA_SETUP_KEY, JSON.stringify(data));
  } catch {
    /* private mode */
  }
}

function readPersisted2FASetup(): { secret: string; otpauth: string } | null {
  try {
    const raw = sessionStorage.getItem(TFA_SETUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { secret?: string; otpauth?: string };
    if (!parsed?.secret) return null;
    return { secret: parsed.secret, otpauth: parsed.otpauth || '' };
  } catch {
    return null;
  }
}

function TwoFactorSection({
  enabled,
  emailVerified,
  onChanged,
}: {
  enabled: boolean;
  emailVerified: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(() =>
    enabled ? null : readPersisted2FASetup()
  );
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [restoring, setRestoring] = useState(false);

  // After Safari reloads (e.g. switching to Google Authenticator), restore pending setup
  useEffect(() => {
    if (enabled) {
      persist2FASetup(null);
      setSetup(null);
      return;
    }
    let cancelled = false;
    const local = readPersisted2FASetup();
    if (local) {
      setSetup(local);
      return;
    }
    setRestoring(true);
    void (async () => {
      try {
        const { default: api } = await import('../../services/api');
        const status = await api.get('/auth/2fa/status');
        if (cancelled) return;
        if (status.data?.data?.pendingSetup) {
          const res = await api.get('/auth/2fa/setup/pending');
          if (cancelled) return;
          const data = res.data?.data as { secret: string; otpauth: string };
          if (data?.secret) {
            setSetup({ secret: data.secret, otpauth: data.otpauth || '' });
            persist2FASetup({ secret: data.secret, otpauth: data.otpauth || '' });
            toast('Continue 2FA setup — enter the code from your app', { icon: '🔐' });
          }
        }
      } catch {
        /* no pending setup */
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const startSetup = async () => {
    setBusy(true);
    try {
      const { default: api } = await import('../../services/api');
      const res = await api.post('/auth/2fa/setup');
      const data = res.data.data as { secret: string; otpauth: string };
      setSetup(data);
      persist2FASetup(data);
      // Keep Settings → Security open across app switches / reloads
      try {
        sessionStorage.setItem('pulse_settings_open', '1');
        sessionStorage.setItem('pulse_settings_tab', 'security');
      } catch {
        /* */
      }
      setBackupCodes(null);
      toast.success('Secret saved — open Authenticator, then come back to enter the code');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
          ?.error?.message || 'Could not start 2FA';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const confirmEnable = async () => {
    setBusy(true);
    try {
      const { default: api } = await import('../../services/api');
      const res = await api.post('/auth/2fa/enable', { code });
      setBackupCodes(res.data.data.backupCodes || []);
      setSetup(null);
      persist2FASetup(null);
      setCode('');
      try {
        sessionStorage.removeItem('pulse_settings_open');
      } catch {
        /* */
      }
      onChanged();
      toast.success('Two-factor authentication enabled');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
          ?.error?.message || 'Invalid code';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const cancelSetup = async () => {
    setBusy(true);
    try {
      const { default: api } = await import('../../services/api');
      await api.post('/auth/2fa/setup/cancel').catch(() => undefined);
    } finally {
      setSetup(null);
      persist2FASetup(null);
      setCode('');
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const { default: api } = await import('../../services/api');
      await api.post('/auth/2fa/disable', { password: disablePw, code: disableCode });
      setDisablePw('');
      setDisableCode('');
      onChanged();
      toast.success('2FA disabled');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
          ?.error?.message || 'Could not disable 2FA';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    if (!setup?.secret) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      toast.success('Secret copied — paste it in Google Authenticator');
    } catch {
      toast.error('Could not copy — long-press the secret to copy');
    }
  };

  return (
    <div className="space-y-3 rounded-2xl border border-[var(--color-border)] p-4">
      <h3 className="flex items-center gap-2 font-semibold">
        <KeyRound className="h-4 w-4" /> Two-factor authentication
      </h3>
      <p className="text-sm text-[var(--color-ink-secondary)]">
        Optional extra protection with Google Authenticator, Authy, or similar apps. You choose
        whether to turn this on.
      </p>
      {enabled ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-emerald-600">2FA is on for your account</p>
          <Input
            type="password"
            label="Password to disable"
            value={disablePw}
            onChange={(e) => setDisablePw(e.target.value)}
          />
          <Input
            label="Authenticator or backup code"
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
          />
          <Button type="button" variant="danger" loading={busy} onClick={() => void disable()}>
            Turn off 2FA
          </Button>
        </div>
      ) : setup ? (
        <div className="space-y-2">
          <div className="rounded-xl border border-pulse-500/25 bg-pulse-500/5 p-3 text-xs text-[var(--color-ink-secondary)]">
            <p className="font-semibold text-[var(--color-ink)]">On iPhone / Safari</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4">
              <li>Copy the secret below (or open the Authenticator link).</li>
              <li>Switch to Google Authenticator and add Pulse.</li>
              <li>
                Come back here — setup is saved, so a page reload is OK — then enter the 6-digit
                code.
              </li>
            </ol>
          </div>
          <p className="break-all select-all rounded-xl bg-black/5 p-2 font-mono text-xs dark:bg-white/5">
            {setup.secret}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => void copySecret()}>
              Copy secret
            </Button>
            {setup.otpauth ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  // Opens Authenticator when installed; user returns to verify
                  window.location.href = setup.otpauth;
                }}
              >
                Open Authenticator
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-[var(--color-ink-secondary)]">
            After adding the account in your app, type the current 6-digit code below and tap
            Confirm.
          </p>
          <Input
            label="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
            autoComplete="one-time-code"
            inputMode="numeric"
            placeholder="000000"
          />
          <div className="flex gap-2">
            <Button type="button" loading={busy} onClick={() => void confirmEnable()}>
              Confirm & enable
            </Button>
            <Button type="button" variant="ghost" loading={busy} onClick={() => void cancelSetup()}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {!emailVerified && (
            <p className="text-xs text-amber-600">
              Tip: verify your email first for account recovery.
            </p>
          )}
          {restoring ? (
            <p className="text-xs text-[var(--color-ink-secondary)]">Checking setup…</p>
          ) : (
            <Button type="button" loading={busy} onClick={() => void startSetup()}>
              Set up 2FA
            </Button>
          )}
        </div>
      )}
      {backupCodes && (
        <div className="animate-fade-up rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/12 to-orange-500/5 p-4 text-xs shadow-sm">
          <p className="mb-2 text-[13px] font-semibold tracking-[-0.015em] text-amber-800 dark:text-amber-200">
            Backup codes — save these now
          </p>
          <p className="mb-3 text-[11px] leading-relaxed text-[var(--color-ink-secondary)]">
            Each code works once if you lose your authenticator.
          </p>
          <ul className="grid grid-cols-2 gap-1.5 font-mono text-[12px] tracking-wide">
            {backupCodes.map((c) => (
              <li
                key={c}
                className="rounded-lg border border-amber-500/15 bg-[var(--color-surface-elevated)]/80 px-2.5 py-1.5 text-center tabular-nums"
              >
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl border border-[var(--color-border)] px-4 py-3 sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1 pr-1">
        <p className="font-medium leading-snug">{label}</p>
        <p className="mt-0.5 text-xs leading-snug text-[var(--color-ink-secondary)]">
          {description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          // Flex alignment avoids translate overflow/overlap when ON
          'inline-flex h-8 w-[3.25rem] shrink-0 items-center rounded-full p-0.5 transition-colors duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pulse-500/40',
          checked
            ? 'justify-end bg-pulse-500'
            : 'justify-start bg-black/15 dark:bg-white/20'
        )}
      >
        <span
          className={cn(
            'pointer-events-none block h-7 w-7 shrink-0 rounded-full bg-white shadow-md',
            'transition-transform duration-200'
          )}
        />
      </button>
    </div>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] px-4 py-3">
      <p className="mb-2 font-medium">{label}</p>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
