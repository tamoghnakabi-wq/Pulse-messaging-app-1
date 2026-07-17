import api, { setAccessToken } from '@/shared/api/client';
import { extractData } from '@/shared/api/extract';
import type { AuthTokensResponse } from '@/shared/api/types';
import type { SessionInfo, User } from '@/shared/types';
import { clearAllAuthTokens, writeRefreshToken } from '@/shared/api/tokenStorage';

export type AuthResponse = AuthTokensResponse;

function persistTokens(data: AuthTokensResponse) {
  setAccessToken(data.accessToken);
  writeRefreshToken(data.refreshToken);
}

export const authService = {
  async register(payload: {
    username: string;
    email: string;
    password: string;
    displayName?: string;
  }): Promise<AuthResponse> {
    const res = await api.post('/auth/register', payload);
    const data = extractData<AuthResponse>(res);
    persistTokens(data);
    return data;
  },

  async login(emailOrUsername: string, password: string): Promise<AuthResponse> {
    const res = await api.post('/auth/login', { emailOrUsername, password });
    const data = extractData<AuthResponse>(res);
    persistTokens(data);
    return data;
  },

  async logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      setAccessToken(null);
      clearAllAuthTokens();
    }
  },

  async logoutEverywhere() {
    try {
      await api.post('/auth/logout-everywhere');
    } finally {
      setAccessToken(null);
      clearAllAuthTokens();
    }
  },

  async me(): Promise<User> {
    const res = await api.get('/auth/me');
    return extractData<{ user: User }>(res).user;
  },

  async forgotPassword(email: string) {
    const res = await api.post('/auth/forgot-password', { email });
    return extractData(res);
  },

  async resetPassword(token: string, password: string) {
    const res = await api.post('/auth/reset-password', { token, password });
    return extractData(res);
  },

  /** Reset password with Authenticator code — only works if 2FA is already enabled */
  async resetPasswordWith2FA(emailOrUsername: string, code: string, password: string) {
    const res = await api.post('/auth/reset-password-2fa', {
      emailOrUsername,
      code,
      password,
    });
    return extractData(res);
  },

  async verifyEmail(token: string) {
    const res = await api.post('/auth/verify-email', { token });
    return extractData(res);
  },

  async resendVerification() {
    const res = await api.post('/auth/resend-verification');
    return extractData(res);
  },

  async getSessions(): Promise<SessionInfo[]> {
    const res = await api.get('/auth/sessions');
    return extractData<{ sessions: SessionInfo[] }>(res).sessions;
  },

  async revokeSession(sessionId: string) {
    const res = await api.delete(`/auth/sessions/${sessionId}`);
    return extractData(res);
  },
};
