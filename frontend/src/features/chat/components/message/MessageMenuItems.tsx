import {
  Copy,
  Pencil,
  Pin,
  Reply,
  Smile,
  Star,
  Trash2,
} from 'lucide-react';
import { MenuItem } from '@/shared/ui/MenuItem';

export interface MessageMenuActions {
  isMine: boolean;
  isPinned: boolean;
  dense?: boolean;
  onEdit: () => void;
  onCopy: () => void;
  onReply: () => void;
  onReact: () => void;
  onPin: () => void;
  onStar: () => void;
  onDeleteMe: () => void;
  onDeleteEveryone: () => void;
}

/** Shared action list for desktop popover + mobile bottom sheet. */
export function MessageMenuItems({
  isMine,
  isPinned,
  onEdit,
  onCopy,
  onReply,
  onReact,
  onPin,
  onStar,
  onDeleteMe,
  onDeleteEveryone,
  dense = true,
}: MessageMenuActions) {
  return (
    <>
      <MenuItem icon={<Smile className="h-4 w-4" />} label="React" onClick={onReact} dense={dense} />
      <MenuItem icon={<Reply className="h-4 w-4" />} label="Reply" onClick={onReply} dense={dense} />
      {isMine && (
        <MenuItem icon={<Pencil className="h-4 w-4" />} label="Edit" onClick={onEdit} dense={dense} />
      )}
      <MenuItem icon={<Copy className="h-4 w-4" />} label="Copy" onClick={onCopy} dense={dense} />
      <MenuItem
        icon={<Pin className="h-4 w-4" />}
        label={isPinned ? 'Unpin' : 'Pin'}
        onClick={onPin}
        dense={dense}
      />
      <MenuItem icon={<Star className="h-4 w-4" />} label="Star" onClick={onStar} dense={dense} />
      <MenuItem
        icon={<Trash2 className="h-4 w-4" />}
        label="Delete for me"
        onClick={onDeleteMe}
        dense={dense}
      />
      {isMine && (
        <MenuItem
          icon={<Trash2 className="h-4 w-4" />}
          label="Delete for everyone"
          onClick={onDeleteEveryone}
          danger
          dense={dense}
        />
      )}
    </>
  );
}
