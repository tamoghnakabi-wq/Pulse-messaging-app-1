/**
 * Create a poll in the active conversation.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, X } from 'lucide-react';
import { pollService } from '@/features/chat/services/pollService';
import { useChatStore } from '@/store/chatStore';
import { cn } from '@/utils/cn';
import toast from 'react-hot-toast';

interface Props {
  conversationId: string;
  open: boolean;
  onClose: () => void;
}

export function PollComposer({ conversationId, open, onClose }: Props) {
  const addMessage = useChatStore((s) => s.addMessage);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuestion('');
    setOptions(['', '']);
    setAllowMultiple(false);
    setIsAnonymous(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const canSend = question.trim().length > 0 && filled.length >= 2 && !sending;

  const create = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const { poll, message } = await pollService.create({
        conversationId,
        question: question.trim(),
        options: filled,
        allowMultiple,
        isAnonymous,
      });
      addMessage(conversationId, message);
      window.dispatchEvent(new CustomEvent('pulse:poll-updated', { detail: poll }));
      toast.success('Poll created');
      onClose();
    } catch {
      toast.error('Could not create poll');
    } finally {
      setSending(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create a poll"
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
          'max-h-[min(92dvh,36rem)] rounded-t-3xl border border-[var(--color-border)]',
          'bg-[var(--color-surface)] shadow-2xl sm:rounded-3xl'
        )}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h2 className="text-base font-semibold tracking-[-0.02em]">Create poll</h2>
            <p className="text-xs text-[var(--color-ink-secondary)]">
              Votes are public in the chat (not end-to-end encrypted)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[var(--color-ink-secondary)]">
              Question
            </span>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={500}
              placeholder="Ask something…"
              className="w-full rounded-xl border border-[var(--color-border)] bg-transparent px-3 py-2.5 text-sm outline-none focus:border-pulse-500"
              autoFocus
            />
          </label>

          <div>
            <span className="mb-1 block text-xs font-semibold text-[var(--color-ink-secondary)]">
              Options
            </span>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={opt}
                    onChange={(e) => {
                      const next = [...options];
                      next[i] = e.target.value;
                      setOptions(next);
                    }}
                    maxLength={200}
                    placeholder={`Option ${i + 1}`}
                    className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-pulse-500"
                  />
                  {options.length > 2 && (
                    <button
                      type="button"
                      aria-label="Remove option"
                      onClick={() => setOptions(options.filter((_, j) => j !== i))}
                      className="rounded-full p-2 text-[var(--color-ink-secondary)] hover:bg-black/[0.05]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {options.length < 12 && (
              <button
                type="button"
                onClick={() => setOptions([...options, ''])}
                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-pulse-600"
              >
                <Plus className="h-3.5 w-3.5" /> Add option
              </button>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowMultiple}
              onChange={(e) => setAllowMultiple(e.target.checked)}
              className="rounded border-[var(--color-border)]"
            />
            Allow multiple choices
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isAnonymous}
              onChange={(e) => setIsAnonymous(e.target.checked)}
              className="rounded border-[var(--color-border)]"
            />
            Anonymous votes (hide who voted)
          </label>
        </div>

        <div className="border-t border-[var(--color-border)] p-4">
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void create()}
            className={cn(
              'w-full rounded-2xl py-3 text-sm font-semibold text-white transition',
              'bg-gradient-to-b from-pulse-400 to-pulse-600 shadow-lg shadow-pulse-500/25',
              'disabled:opacity-40'
            )}
          >
            {sending ? 'Creating…' : 'Send poll'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
