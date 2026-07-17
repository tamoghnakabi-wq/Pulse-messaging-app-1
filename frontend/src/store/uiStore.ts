import { create } from 'zustand';
import {
  getChatBackground,
  isChatBackgroundId,
  type ChatBackgroundId,
} from '../shared/lib/chatBackgrounds';

type Theme = 'light' | 'dark' | 'system';

interface UIState {
  theme: Theme;
  chatBackground: ChatBackgroundId;
  showSettings: boolean;
  showNewChat: boolean;
  showNewGroup: boolean;
  showMobileSidebar: boolean;
  settingsTab: 'profile' | 'theme' | 'privacy' | 'notifications' | 'security';
  setTheme: (theme: Theme) => void;
  setChatBackground: (id: ChatBackgroundId) => void;
  /** Hydrate wallpaper from server settings without clobbering local-only picks */
  hydrateChatBackground: (id?: string | null) => void;
  applyTheme: () => void;
  setShowSettings: (v: boolean) => void;
  setShowNewChat: (v: boolean) => void;
  setShowNewGroup: (v: boolean) => void;
  setShowMobileSidebar: (v: boolean) => void;
  setSettingsTab: (tab: UIState['settingsTab']) => void;
}

function resolveDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function readStoredChatBackground(): ChatBackgroundId {
  const raw = localStorage.getItem('pulse_chat_background');
  return isChatBackgroundId(raw) ? raw : 'default';
}

export const useUIStore = create<UIState>((set, get) => ({
  theme: (localStorage.getItem('pulse_theme') as Theme) || 'system',
  chatBackground: readStoredChatBackground(),
  showSettings: false,
  showNewChat: false,
  showNewGroup: false,
  showMobileSidebar: true,
  settingsTab: 'profile',

  setTheme: (theme) => {
    localStorage.setItem('pulse_theme', theme);
    set({ theme });
    get().applyTheme();
  },

  setChatBackground: (id) => {
    const theme = getChatBackground(id);
    localStorage.setItem('pulse_chat_background', theme.id);
    set({ chatBackground: theme.id });
  },

  hydrateChatBackground: (id) => {
    if (!isChatBackgroundId(id)) return;
    localStorage.setItem('pulse_chat_background', id);
    set({ chatBackground: id });
  },

  applyTheme: () => {
    const dark = resolveDark(get().theme);
    document.documentElement.classList.toggle('dark', dark);
  },

  setShowSettings: (v) => {
    set({ showSettings: v });
    try {
      if (v) {
        sessionStorage.setItem('pulse_settings_open', '1');
        sessionStorage.setItem('pulse_settings_tab', get().settingsTab);
      } else if (!sessionStorage.getItem('pulse_2fa_setup_pending')) {
        // Keep settings flag during 2FA setup so Safari reload can re-open it
        sessionStorage.removeItem('pulse_settings_open');
      }
    } catch {
      /* */
    }
  },
  setShowNewChat: (v) => set({ showNewChat: v }),
  setShowNewGroup: (v) => set({ showNewGroup: v }),
  setShowMobileSidebar: (v) => set({ showMobileSidebar: v }),
  setSettingsTab: (tab) => {
    set({ settingsTab: tab });
    try {
      if (get().showSettings) sessionStorage.setItem('pulse_settings_tab', tab);
    } catch {
      /* */
    }
  },
}));
