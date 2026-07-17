import { useState, useEffect } from 'react';
import { Search, Check } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useUIStore } from '../../store/uiStore';
import { useChatStore } from '../../store/chatStore';
import { chatService } from '../../services/chat.service';
import type { User } from '../../types';
import toast from 'react-hot-toast';
import { cn } from '../../utils/cn';

export function NewGroupModal() {
  const open = useUIStore((s) => s.showNewGroup);
  const setOpen = useUIStore((s) => s.setShowNewGroup);
  const { upsertConversation, setActiveConversation } = useChatStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || q.length < 1) return;
    const t = setTimeout(() => {
      chatService.searchUsers(q).then(setUsers);
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  const toggle = (u: User) => {
    setSelected((prev) =>
      prev.some((x) => x.id === u.id) ? prev.filter((x) => x.id !== u.id) : [...prev, u]
    );
  };

  const create = async () => {
    if (!name.trim() || selected.length === 0) {
      toast.error('Name and at least one member required');
      return;
    }
    setLoading(true);
    try {
      const conv = await chatService.createGroup(
        name.trim(),
        selected.map((u) => u.id),
        description
      );
      upsertConversation(conv);
      setActiveConversation(conv.id);
      setOpen(false);
      setName('');
      setDescription('');
      setSelected([]);
      setQ('');
      toast.success('Group created');
    } catch {
      toast.error('Failed to create group');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="New group" size="md">
      <div className="space-y-4">
        <Input
          label="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Design Team"
          required
        />
        <Input
          label="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What's this group about?"
        />
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {selected.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => toggle(u)}
                className="pressable flex items-center gap-1.5 rounded-full bg-pulse-500/15 px-2.5 py-1.5 text-xs font-semibold tracking-[-0.01em] text-pulse-600 transition-colors hover:bg-pulse-500/20"
              >
                <Avatar src={u.avatar} name={u.displayName} size="xs" />
                {u.displayName}
              </button>
            ))}
          </div>
        )}
        <Input
          placeholder="Add members…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          leftIcon={<Search className="h-4 w-4" />}
        />
        <div className="max-h-48 space-y-0.5 overflow-y-auto scrollbar-thin">
          {users.map((u) => {
            const isSel = selected.some((x) => x.id === u.id);
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => toggle(u)}
                className={cn(
                  'menu-item pressable flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left',
                  isSel && 'bg-pulse-500/10 ring-1 ring-pulse-500/20'
                )}
              >
                <Avatar src={u.avatar} name={u.displayName} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold tracking-[-0.01em]">{u.displayName}</p>
                  <p className="truncate text-xs text-[var(--color-ink-secondary)]">@{u.username}</p>
                </div>
                {isSel && <Check className="h-4 w-4 shrink-0 text-pulse-500" />}
              </button>
            );
          })}
        </div>
        <Button className="w-full" loading={loading} onClick={() => void create()}>
          Create group
        </Button>
      </div>
    </Modal>
  );
}
