import { useState, useEffect } from 'react';
import { Search, MessageSquarePlus } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { Input } from '../ui/Input';
import { useUIStore } from '../../store/uiStore';
import { useChatStore } from '../../store/chatStore';
import { chatService } from '../../services/chat.service';
import type { User } from '../../types';
import toast from 'react-hot-toast';

export function NewChatModal() {
  const open = useUIStore((s) => s.showNewChat);
  const setOpen = useUIStore((s) => s.setShowNewChat);
  const setShowMobileSidebar = useUIStore((s) => s.setShowMobileSidebar);
  const { upsertConversation, setActiveConversation } = useChatStore();
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (q.length < 1) {
      setUsers([]);
      return;
    }
    const t = setTimeout(() => {
      setLoading(true);
      chatService
        .searchUsers(q)
        .then(setUsers)
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  const start = async (userId: string) => {
    try {
      const conv = await chatService.createDirect(userId);
      upsertConversation(conv);
      setActiveConversation(conv.id);
      setShowMobileSidebar(false);
      setOpen(false);
      setQ('');
    } catch {
      toast.error('Could not start chat');
    }
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="New chat">
      <Input
        placeholder="Search users by name or username…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        leftIcon={<Search className="h-4 w-4" />}
        autoFocus
      />
      <div className="mt-4 max-h-80 space-y-0.5 overflow-y-auto scrollbar-thin">
        {loading && (
          <div className="space-y-1 p-1 animate-fade-in">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
                <div className="skeleton h-9 w-9 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="skeleton h-3 w-[40%]" />
                  <div className="skeleton h-2.5 w-[28%]" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && !q && (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <div className="empty-icon mb-3">
              <MessageSquarePlus className="h-7 w-7 text-pulse-500" />
            </div>
            <p className="text-sm font-semibold tracking-[-0.02em]">Find someone to message</p>
            <p className="mt-1 max-w-[16rem] text-xs leading-relaxed text-[var(--color-ink-secondary)]">
              Search by display name or username to start a conversation.
            </p>
          </div>
        )}
        {!loading && q && users.length === 0 && (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium tracking-[-0.01em]">No users found</p>
            <p className="mt-1 text-xs text-[var(--color-ink-secondary)]">
              Try a different name or username
            </p>
          </div>
        )}
        {users.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => void start(u.id)}
            className="menu-item pressable flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left"
          >
            <Avatar src={u.avatar} name={u.displayName} size="sm" online={u.isOnline} />
            <div className="min-w-0">
              <p className="truncate font-semibold tracking-[-0.01em]">{u.displayName}</p>
              <p className="truncate text-xs text-[var(--color-ink-secondary)]">@{u.username}</p>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}
