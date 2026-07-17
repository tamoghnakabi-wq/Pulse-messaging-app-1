import { create } from 'zustand';
import type { User } from '../types';
import { authService } from '../services/auth.service';
import { setAccessToken, getAccessToken } from '../services/api';
import { connectSocket, updateSocketAuth } from '../services/socket';
import { clearClientSessionState } from '../utils/sessionCleanup';
import {
  cacheUser,
  prefetchChatShell,
  prefetchConversations,
  readCachedUser,
} from '../utils/sessionCache';
import { readRefreshToken, writeRefreshToken } from '../shared/api/tokenStorage';

async function hydrateAppearanceFromUser(user: User | null | undefined) {
  if (!user?.settings) return;
  try {
    const { useUIStore } = await import('./uiStore');
    if (user.settings.theme) {
      useUIStore.getState().setTheme(user.settings.theme);
    }
    if (user.settings.chatBackground) {
      useUIStore.getState().hydrateChatBackground(user.settings.chatBackground);
    }
  } catch {
    /* non-fatal */
  }
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** True while revalidating a cached session in the background */
  isRevalidating: boolean;
  setUser: (user: User | null) => void;
  login: (emailOrUsername: string, password: string) => Promise<void>;
  register: (payload: {
    username: string;
    email: string;
    password: string;
    displayName?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  logoutEverywhere: () => Promise<void>;
  /** Hard client logout used when refresh fails (no server call required) */
  forceLogout: () => void;
  bootstrap: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

let bootstrapPromise: Promise<void> | null = null;

function applyUser(user: User) {
  cacheUser(user);
  void hydrateAppearanceFromUser(user);
  void import('../services/e2e')
    .then(({ setE2EUserContext }) => setE2EUserContext(user?.id))
    .catch(() => undefined);
}

/** Sync hydrate so iOS Safari cold-start after app-switch paints chat, not LoadingScreen. */
function initialSessionFromCache(): {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
} {
  try {
    // Access token is memory-only; session = refresh token (sessionStorage)
    const hasSession = !!readRefreshToken();
    if (!hasSession) {
      return { user: null, isAuthenticated: false, isLoading: false };
    }
    const cached = readCachedUser();
    if (cached) {
      void hydrateAppearanceFromUser(cached);
      void import('../services/e2e')
        .then(({ setE2EUserContext }) => setE2EUserContext(cached.id))
        .catch(() => undefined);
      return { user: cached, isAuthenticated: true, isLoading: false };
    }
    return { user: null, isAuthenticated: false, isLoading: true };
  } catch {
    return { user: null, isAuthenticated: false, isLoading: true };
  }
}

const initialSession = initialSessionFromCache();

export const useAuthStore = create<AuthState>((set, get) => ({
  user: initialSession.user,
  isAuthenticated: initialSession.isAuthenticated,
  isLoading: initialSession.isLoading,
  isRevalidating: false,

  setUser: (user) => {
    cacheUser(user);
    set({ user, isAuthenticated: !!user });
  },

  login: async (emailOrUsername, password) => {
    const data = await authService.login(emailOrUsername, password);
    set({ user: data.user, isAuthenticated: true, isLoading: false });
    applyUser(data.user);
    updateSocketAuth(data.accessToken);
    connectSocket();
    prefetchChatShell();
    // Password unlocks E2E key backup (survives tunnel URL / origin changes)
    await import('../services/e2e')
      .then(({ ensureIdentityKeys }) =>
        ensureIdentityKeys(data.user?.id, { password })
      )
      .catch(() => undefined);
    void prefetchConversations();
  },

  register: async (payload) => {
    const data = await authService.register(payload);
    set({ user: data.user, isAuthenticated: true, isLoading: false });
    applyUser(data.user);
    updateSocketAuth(data.accessToken);
    connectSocket();
    prefetchChatShell();
    await import('../services/e2e')
      .then(({ ensureIdentityKeys }) =>
        ensureIdentityKeys(data.user?.id, { password: payload.password })
      )
      .catch(() => undefined);
    void prefetchConversations();
  },

  forceLogout: () => {
    bootstrapPromise = null;
    clearClientSessionState();
    set({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      isRevalidating: false,
    });
  },

  logout: async () => {
    try {
      await authService.logout();
    } catch {
      /* still clear local state */
    }
    bootstrapPromise = null;
    clearClientSessionState();
    set({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      isRevalidating: false,
    });
  },

  logoutEverywhere: async () => {
    try {
      await authService.logoutEverywhere();
    } catch {
      /* still clear local state */
    }
    bootstrapPromise = null;
    clearClientSessionState();
    set({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      isRevalidating: false,
    });
  },

  bootstrap: async () => {
    // Single-flight — main.tsx + App both call this
    if (bootstrapPromise) return bootstrapPromise;

    bootstrapPromise = (async () => {
      const token = getAccessToken();
      const hasRefresh = !!readRefreshToken();
      if (!token && !hasRefresh) {
        set({
          user: null,
          isAuthenticated: false,
          isLoading: false,
          isRevalidating: false,
        });
        return;
      }

      // Instant shell: paint from disk cache while network revalidates
      // Critical on iOS Safari after background kill — avoid full LoadingScreen flash
      const cached = readCachedUser();
      if (cached && (token || hasRefresh)) {
        set({
          user: cached,
          isAuthenticated: true,
          isLoading: false,
          isRevalidating: true,
        });
        void hydrateAppearanceFromUser(cached);
        void import('../services/e2e')
          .then(({ setE2EUserContext }) => setE2EUserContext(cached.id))
          .catch(() => undefined);
        prefetchChatShell();
        try {
          const { readCachedConversations } = await import('../utils/sessionCache');
          const { useChatStore } = await import('./chatStore');
          if (!useChatStore.getState().conversations.length) {
            const convs = readCachedConversations();
            if (convs?.length) useChatStore.getState().setConversations(convs);
          }
        } catch {
          /* */
        }
      } else {
        set({ isLoading: true, isRevalidating: false });
      }

      try {
        if (!getAccessToken() && hasRefresh) {
          // Retry refresh — mobile networks often fail the first request after resume
          let refreshed = false;
          for (let attempt = 0; attempt < 3 && !refreshed; attempt++) {
            try {
              if (attempt > 0) {
                await new Promise((r) => setTimeout(r, 400 * attempt));
              }
              const { default: api } = await import('../services/api');
              const res = await api.post('/auth/refresh', {
                refreshToken: readRefreshToken(),
              });
              setAccessToken(res.data.data.accessToken);
              if (res.data.data.refreshToken) {
                writeRefreshToken(res.data.data.refreshToken);
              }
              refreshed = true;
            } catch {
              /* retry */
            }
          }
          if (!refreshed) {
            // Keep cached shell if we have one; only hard-logout when no cache
            if (!cached) {
              clearClientSessionState();
              set({
                user: null,
                isAuthenticated: false,
                isLoading: false,
                isRevalidating: false,
              });
              return;
            }
            set({ isRevalidating: false });
            return;
          }
        }

        prefetchChatShell();

        // me() + conversation list in parallel
        const mePromise = authService.me();
        void prefetchConversations();

        const user = await mePromise;
        set({
          user,
          isAuthenticated: true,
          isLoading: false,
          isRevalidating: false,
        });
        applyUser(user);
        connectSocket();
        // Publish / load device E2E identity keys for this user (non-blocking)
        void import('../services/e2e')
          .then(({ ensureIdentityKeys }) => ensureIdentityKeys(user?.id))
          .catch(() => undefined);
      } catch {
        // Network blip after resume: keep cached session rather than kicking to login
        if (cached && (token || hasRefresh)) {
          set({
            user: cached,
            isAuthenticated: true,
            isLoading: false,
            isRevalidating: false,
          });
          connectSocket();
          return;
        }
        clearClientSessionState();
        set({
          user: null,
          isAuthenticated: false,
          isLoading: false,
          isRevalidating: false,
        });
      }
    })();

    return bootstrapPromise;
  },

  refreshUser: async () => {
    try {
      const user = await authService.me();
      set({ user });
      applyUser(user);
    } catch {
      /* */
    }
  },
}));
