/**
 * Chat wallpaper catalog — pure CSS backgrounds (no image assets).
 * Applied to the message list area in ChatWindow.
 */

export type ChatBackgroundId =
  | 'default'
  | 'pulse'
  | 'midnight'
  | 'aurora'
  | 'sunset'
  | 'ocean'
  | 'forest'
  | 'graphite'
  | 'dusk'
  | 'sand'
  | 'ember'
  | 'frost';

export interface ChatBackgroundTheme {
  id: ChatBackgroundId;
  label: string;
  description: string;
  /** Inline styles for the live chat surface */
  style: {
    backgroundColor?: string;
    backgroundImage: string;
    backgroundSize?: string;
    backgroundAttachment?: string;
    backgroundRepeat?: string;
    backgroundPosition?: string;
  };
  /** Compact swatch for the settings picker */
  preview: string;
}

export const CHAT_BACKGROUNDS: ChatBackgroundTheme[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Soft Pulse orbs',
    preview:
      'radial-gradient(circle at 20% 20%, rgba(10,132,255,0.35) 0%, transparent 45%), radial-gradient(circle at 80% 80%, rgba(139,92,246,0.3) 0%, transparent 45%), #f5f5f7',
    style: {
      backgroundImage:
        'radial-gradient(circle at 20% 20%, rgba(10,132,255,0.06) 0%, transparent 42%), radial-gradient(circle at 80% 80%, rgba(139,92,246,0.05) 0%, transparent 42%)',
    },
  },
  {
    id: 'pulse',
    label: 'Pulse Blue',
    description: 'Brand gradient wash',
    preview: 'linear-gradient(145deg, #0a84ff 0%, #5ac8fa 45%, #bf5af2 100%)',
    style: {
      backgroundImage:
        'linear-gradient(160deg, rgba(10,132,255,0.12) 0%, transparent 45%), linear-gradient(340deg, rgba(90,200,250,0.1) 0%, transparent 50%), radial-gradient(circle at 70% 20%, rgba(191,90,242,0.08) 0%, transparent 40%)',
    },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Deep night sky',
    preview: 'linear-gradient(160deg, #0b1026 0%, #1a1a2e 50%, #16213e 100%)',
    style: {
      backgroundColor: 'transparent',
      backgroundImage:
        'radial-gradient(ellipse at 30% 0%, rgba(59,130,246,0.14) 0%, transparent 50%), radial-gradient(ellipse at 80% 100%, rgba(99,102,241,0.12) 0%, transparent 45%), linear-gradient(180deg, rgba(15,23,42,0.04) 0%, transparent 100%)',
    },
  },
  {
    id: 'aurora',
    label: 'Aurora',
    description: 'Northern lights',
    preview:
      'linear-gradient(135deg, #10b981 0%, #06b6d4 40%, #8b5cf6 75%, #ec4899 100%)',
    style: {
      backgroundImage:
        'radial-gradient(ellipse at 10% 30%, rgba(16,185,129,0.14) 0%, transparent 45%), radial-gradient(ellipse at 90% 20%, rgba(139,92,246,0.12) 0%, transparent 40%), radial-gradient(ellipse at 50% 90%, rgba(6,182,212,0.1) 0%, transparent 45%)',
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    description: 'Warm evening glow',
    preview: 'linear-gradient(145deg, #fb923c 0%, #f472b6 50%, #c084fc 100%)',
    style: {
      backgroundImage:
        'radial-gradient(circle at 15% 80%, rgba(251,146,60,0.14) 0%, transparent 45%), radial-gradient(circle at 85% 20%, rgba(244,114,182,0.12) 0%, transparent 40%), radial-gradient(circle at 50% 50%, rgba(192,132,252,0.06) 0%, transparent 50%)',
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    description: 'Deep sea blues',
    preview: 'linear-gradient(160deg, #0369a1 0%, #0ea5e9 50%, #67e8f9 100%)',
    style: {
      backgroundImage:
        'radial-gradient(ellipse at 20% 100%, rgba(14,165,233,0.14) 0%, transparent 50%), radial-gradient(ellipse at 90% 10%, rgba(6,182,212,0.1) 0%, transparent 40%), linear-gradient(180deg, rgba(3,105,161,0.04) 0%, transparent 60%)',
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    description: 'Calm greens',
    preview: 'linear-gradient(145deg, #14532d 0%, #22c55e 55%, #86efac 100%)',
    style: {
      backgroundImage:
        'radial-gradient(circle at 25% 25%, rgba(34,197,94,0.12) 0%, transparent 45%), radial-gradient(circle at 80% 70%, rgba(20,83,45,0.08) 0%, transparent 40%), radial-gradient(circle at 50% 90%, rgba(134,239,172,0.08) 0%, transparent 40%)',
    },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Minimal monochrome',
    preview: 'linear-gradient(180deg, #e5e5ea 0%, #d1d1d6 50%, #aeaeb2 100%)',
    style: {
      backgroundImage:
        'linear-gradient(180deg, rgba(0,0,0,0.02) 0%, transparent 40%), radial-gradient(circle at 50% 0%, rgba(0,0,0,0.03) 0%, transparent 50%)',
    },
  },
  {
    id: 'dusk',
    label: 'Dusk',
    description: 'Purple twilight',
    preview: 'linear-gradient(150deg, #4c1d95 0%, #7c3aed 45%, #a78bfa 100%)',
    style: {
      backgroundImage:
        'radial-gradient(ellipse at 20% 20%, rgba(124,58,237,0.14) 0%, transparent 45%), radial-gradient(ellipse at 90% 80%, rgba(167,139,250,0.1) 0%, transparent 40%), radial-gradient(circle at 50% 50%, rgba(76,29,149,0.05) 0%, transparent 55%)',
    },
  },
  {
    id: 'sand',
    label: 'Sand',
    description: 'Warm paper',
    preview: 'linear-gradient(160deg, #fef3c7 0%, #fde68a 40%, #fbbf24 100%)',
    style: {
      backgroundImage:
        'radial-gradient(circle at 30% 20%, rgba(251,191,36,0.12) 0%, transparent 45%), radial-gradient(circle at 70% 90%, rgba(253,230,138,0.14) 0%, transparent 40%), linear-gradient(180deg, rgba(254,243,199,0.25) 0%, transparent 50%)',
    },
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Soft firelight',
    preview: 'linear-gradient(145deg, #7f1d1d 0%, #ea580c 50%, #fbbf24 100%)',
    style: {
      backgroundImage:
        'radial-gradient(circle at 80% 90%, rgba(234,88,12,0.12) 0%, transparent 45%), radial-gradient(circle at 15% 15%, rgba(251,191,36,0.1) 0%, transparent 40%), radial-gradient(circle at 50% 40%, rgba(127,29,29,0.05) 0%, transparent 50%)',
    },
  },
  {
    id: 'frost',
    label: 'Frost',
    description: 'Cool crystal',
    preview: 'linear-gradient(160deg, #e0f2fe 0%, #bae6fd 40%, #7dd3fc 100%)',
    style: {
      backgroundImage:
        'radial-gradient(ellipse at 50% 0%, rgba(125,211,252,0.18) 0%, transparent 50%), radial-gradient(circle at 10% 80%, rgba(186,230,253,0.16) 0%, transparent 40%), linear-gradient(180deg, rgba(224,242,254,0.2) 0%, transparent 55%)',
    },
  },
];

const byId = new Map(CHAT_BACKGROUNDS.map((t) => [t.id, t]));

export function isChatBackgroundId(value: unknown): value is ChatBackgroundId {
  return typeof value === 'string' && byId.has(value as ChatBackgroundId);
}

export function getChatBackground(id?: string | null): ChatBackgroundTheme {
  if (id && isChatBackgroundId(id)) return byId.get(id)!;
  return byId.get('default')!;
}
