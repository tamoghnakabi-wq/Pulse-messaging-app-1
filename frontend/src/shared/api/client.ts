import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import {
  clearAllAuthTokens,
  readRefreshToken,
  writeRefreshToken,
} from './tokenStorage';

const API_URL = import.meta.env.VITE_API_URL || '';

export const api = axios.create({
  baseURL: `${API_URL}/api`,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
    // Avoid stale 304 empty conversation filters after pin/star
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  },
});

/** Access JWT — memory only (not persisted). Recovered via refresh on cold start. */
let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
  // Intentionally do NOT write access token to localStorage/sessionStorage
  try {
    localStorage.removeItem('pulse_access_token');
  } catch {
    /* */
  }
}

export function getAccessToken() {
  return accessToken;
}

export function getApiBaseUrl() {
  return API_URL || window.location.origin;
}

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  // FormData needs browser-set multipart boundary
  if (config.data instanceof FormData) {
    delete config.headers['Content-Type'];
  }
  return config;
});

/** Auth routes that must never trigger silent token refresh (would hang / loop). */
function isPublicAuthUrl(url?: string): boolean {
  if (!url) return false;
  const path = url.split('?')[0] || '';
  return (
    path.includes('/auth/login') ||
    path.includes('/auth/register') ||
    path.includes('/auth/refresh') ||
    path.includes('/auth/forgot-password') ||
    path.includes('/auth/reset-password') ||
    path.includes('/auth/reset-password-2fa') ||
    path.includes('/auth/verify-email') ||
    path.includes('/auth/login/2fa')
  );
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (error.response?.status === 401 && original && !original._retry) {
      if (isPublicAuthUrl(original.url)) {
        return Promise.reject(error);
      }
      if (!readRefreshToken()) {
        return Promise.reject(error);
      }
      original._retry = true;

      if (!refreshPromise) {
        const tryRefresh = async (attempt: number): Promise<string | null> => {
          try {
            const res = await api.post('/auth/refresh', {
              refreshToken: readRefreshToken(),
            });
            const token = res.data.data.accessToken as string;
            setAccessToken(token);
            if (res.data.data.refreshToken) {
              writeRefreshToken(res.data.data.refreshToken);
            }
            return token;
          } catch {
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
              return tryRefresh(attempt + 1);
            }
            clearAllAuthTokens();
            void import('@/store/authStore').then(({ useAuthStore }) => {
              useAuthStore.getState().forceLogout();
            });
            return null;
          }
        };
        refreshPromise = tryRefresh(0).finally(() => {
          refreshPromise = null;
        });
      }

      const token = await refreshPromise;
      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      }
    }
    return Promise.reject(error);
  }
);

export default api;
