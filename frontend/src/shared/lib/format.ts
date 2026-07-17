import {
  format,
  formatDistanceToNow,
  isToday,
  isYesterday,
  isThisWeek,
  parseISO,
} from 'date-fns';
import type { SenderIdentity } from '@/shared/types';

function toDate(date: string | Date): Date {
  return typeof date === 'string' ? parseISO(date) : date;
}

export function formatMessageTime(date: string | Date): string {
  return format(toDate(date), 'HH:mm');
}

export function formatChatListTime(date?: string | Date): string {
  if (!date) return '';
  const d = toDate(date);
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return 'Yesterday';
  if (isThisWeek(d)) return format(d, 'EEE');
  return format(d, 'dd/MM/yyyy');
}

/** Day label for in-chat date separators (Today / Yesterday / full date). */
export function formatDateSeparator(date?: string | Date): string {
  if (!date) return '';
  const d = toDate(date);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  if (isThisWeek(d)) return format(d, 'EEEE');
  return format(d, 'MMM d, yyyy');
}

/** True when two timestamps fall on different calendar days (local time). */
export function isDifferentDay(a?: string | Date, b?: string | Date): boolean {
  if (!a || !b) return true;
  const da = toDate(a);
  const db = toDate(b);
  return (
    da.getFullYear() !== db.getFullYear() ||
    da.getMonth() !== db.getMonth() ||
    da.getDate() !== db.getDate()
  );
}

export function formatLastSeen(date?: string | Date, isOnline?: boolean): string {
  if (isOnline) return 'Online';
  if (!date) return 'Offline';
  return `Last seen ${formatDistanceToNow(toDate(date), { addSuffix: true })}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getInitials(name?: string): string {
  if (!name) return '?';
  return name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Normalize message.sender (populated user or raw id) into a stable shape. */
export function getSender(msg: { sender: unknown }): SenderIdentity {
  if (typeof msg.sender === 'string') return { id: msg.sender };
  if (!msg.sender || typeof msg.sender !== 'object') return { id: '' };
  const s = msg.sender as {
    id?: string;
    _id?: string | { toString(): string };
    displayName?: string;
    username?: string;
    avatar?: string;
  };
  const rawId = s.id || (typeof s._id === 'string' ? s._id : s._id?.toString?.()) || '';
  return {
    id: rawId,
    displayName: s.displayName,
    username: s.username,
    avatar: s.avatar,
  };
}

export function formatCallDuration(seconds?: number): string {
  if (!seconds || seconds < 0) return '';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function conversationIdOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const o = value as { id?: string; _id?: string | { toString(): string } };
    if (o.id) return o.id;
    if (typeof o._id === 'string') return o._id;
    if (o._id && typeof o._id.toString === 'function') return o._id.toString();
  }
  return String(value ?? '');
}
