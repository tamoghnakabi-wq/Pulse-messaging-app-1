import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, Shield } from 'lucide-react';
import toast from 'react-hot-toast';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { useAuthStore } from '../store/authStore';
import api, { setAccessToken } from '../services/api';
import { extractData } from '@/shared/api/extract';
import type { User } from '@/shared/types';

export function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const setUser = useAuthStore((s) => s.setUser);
  const [emailOrUsername, setEmailOrUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [twoFA, setTwoFA] = useState<{ challengeId: string } | null>(null);
  const [code, setCode] = useState('');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (twoFA) {
        const res = await api.post('/auth/login/2fa', {
          challengeId: twoFA.challengeId,
          code,
        });
        const data = extractData<{
          user: User;
          accessToken: string;
          refreshToken: string;
        }>(res);
        setAccessToken(data.accessToken);
        const { writeRefreshToken } = await import('../shared/api/tokenStorage');
        writeRefreshToken(data.refreshToken);
        setUser(data.user);
        // Restore E2E keys from password-wrapped backup after origin change
        await import('../services/e2e')
          .then(({ ensureIdentityKeys, setE2EUserContext }) => {
            setE2EUserContext(data.user.id);
            return ensureIdentityKeys(data.user.id, { password });
          })
          .catch(() => undefined);
        toast.success('Welcome back!');
        navigate('/');
        return;
      }

      // Custom login to intercept requires2FA without breaking store.login
      const res = await api.post('/auth/login', { emailOrUsername, password });
      const data = res.data?.data as {
        requires2FA?: boolean;
        challengeId?: string;
        user?: User;
        accessToken?: string;
        refreshToken?: string;
      };
      if (data?.requires2FA && data.challengeId) {
        setTwoFA({ challengeId: data.challengeId });
        toast('Enter your authenticator code', { icon: '🔐' });
        return;
      }
      if (data?.accessToken && data.refreshToken && data.user) {
        setAccessToken(data.accessToken);
        const { writeRefreshToken } = await import('../shared/api/tokenStorage');
        writeRefreshToken(data.refreshToken);
        setUser(data.user);
        await import('../services/e2e')
          .then(({ ensureIdentityKeys, setE2EUserContext }) => {
            setE2EUserContext(data.user!.id);
            return ensureIdentityKeys(data.user!.id, { password });
          })
          .catch(() => undefined);
        toast.success('Welcome back!');
        navigate('/');
        return;
      }
      // Fallback to store login (also restores E2E backup with password)
      await login(emailOrUsername, password);
      toast.success('Welcome back!');
      navigate('/');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
          ?.error?.message || 'Login failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to continue to Pulse">
      <form onSubmit={onSubmit} className="space-y-4">
        {!twoFA ? (
          <>
            <Input
              id="email"
              label="Email or username"
              placeholder="you@example.com"
              value={emailOrUsername}
              onChange={(e) => setEmailOrUsername(e.target.value)}
              leftIcon={<Mail className="h-4 w-4" />}
              required
              autoComplete="username"
            />
            <Input
              id="password"
              label="Password"
              type={show ? 'text' : 'password'}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              leftIcon={<Lock className="h-4 w-4" />}
              rightIcon={
                <button type="button" onClick={() => setShow(!show)} className="p-0.5">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              }
              required
              autoComplete="current-password"
            />
            <div className="flex flex-col items-end gap-1 pt-0.5">
              {/* Dev: email reset disabled — link goes straight to authenticator (2FA) reset */}
              <Link
                to="/forgot-password"
                className="text-sm font-semibold text-pulse-500 transition-colors hover:text-pulse-600"
              >
                Forgot password?
              </Link>
              {!import.meta.env.DEV && (
                <Link
                  to="/forgot-password?method=2fa"
                  className="text-xs font-medium text-[var(--color-ink-secondary)] transition-colors hover:text-pulse-500"
                >
                  Reset with authenticator (2FA)
                </Link>
              )}
            </div>
          </>
        ) : (
          <Input
            id="totp"
            label="Authenticator code"
            placeholder="6-digit code or backup code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            leftIcon={<Shield className="h-4 w-4" />}
            required
            autoComplete="one-time-code"
            autoFocus
          />
        )}
        <Button type="submit" className="mt-1 w-full" size="lg" loading={loading}>
          {twoFA ? 'Verify' : 'Sign in'}
        </Button>
        {twoFA && (
          <button
            type="button"
            className="w-full text-center text-sm font-medium text-[var(--color-ink-secondary)] transition-colors hover:text-[var(--color-ink)]"
            onClick={() => {
              setTwoFA(null);
              setCode('');
            }}
          >
            Back to password
          </button>
        )}
      </form>
      <p className="mt-6 text-center text-sm text-[var(--color-ink-secondary)]">
        Don&apos;t have an account?{' '}
        <Link to="/register" className="font-semibold text-pulse-500 hover:text-pulse-600">
          Create one
        </Link>
      </p>
    </AuthLayout>
  );
}
