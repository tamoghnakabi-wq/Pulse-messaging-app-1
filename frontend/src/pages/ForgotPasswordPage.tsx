import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Shield, Lock, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { PasswordStrength, passwordErrors, scorePassword } from '../components/ui/PasswordStrength';
import api from '../services/api';

/** Dev builds only expose authenticator reset (no email SMTP on tunnels). */
const isDev = import.meta.env.DEV;

export function ForgotPasswordPage() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [emailOrUsername, setEmailOrUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const onEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading || isDev) return;
    setLoading(true);
    try {
      await api.post(
        '/auth/forgot-password',
        { email: email.trim().toLowerCase() },
        { timeout: 15000 }
      );
      setSent(true);
      toast.success('If that email exists, a reset link was sent');
    } catch (err: unknown) {
      const msg =
        (err as { code?: string; response?: { data?: { error?: { message?: string } } } })
          ?.response?.data?.error?.message ||
        ((err as { code?: string }).code === 'ECONNABORTED'
          ? 'Request timed out — try again'
          : 'Something went wrong');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const on2FASubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    const errs = passwordErrors(password);
    if (errs.length || scorePassword(password) < 2) {
      toast.error(errs[0] || 'Please choose a stronger password');
      return;
    }
    if (!code.trim()) {
      toast.error('Enter your authenticator code');
      return;
    }
    if (!emailOrUsername.trim()) {
      toast.error('Enter your email or username');
      return;
    }
    setLoading(true);
    try {
      await api.post(
        '/auth/reset-password-2fa',
        {
          emailOrUsername: emailOrUsername.trim(),
          code: code.trim(),
          password,
        },
        { timeout: 20000 }
      );
      toast.success('Password updated — sign in with your new password');
      navigate('/login', { replace: true });
    } catch (err: unknown) {
      const msg =
        (err as { code?: string; response?: { data?: { error?: { message?: string } } } })
          ?.response?.data?.error?.message ||
        ((err as { code?: string }).code === 'ECONNABORTED'
          ? 'Request timed out — try again'
          : 'Could not reset password');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  // ── Development: authenticator-only ───────────────────────────────────────
  if (isDev) {
    return (
      <AuthLayout
        title="Forgot password"
        subtitle="Reset with Google Authenticator (email reset is off in dev)"
      >
        <form onSubmit={on2FASubmit} className="space-y-4">
          <div className="rounded-2xl border border-pulse-500/20 bg-pulse-500/5 px-3.5 py-3 text-xs leading-relaxed text-[var(--color-ink-secondary)]">
            <p className="font-semibold text-[var(--color-ink)]">Authenticator reset only</p>
            <p className="mt-1">
              Email reset is disabled in development. Enter your account, a code from Google
              Authenticator (or a backup code), and a new password. Enable 2FA under Settings →
              Security first if needed.
            </p>
          </div>
          <Input
            id="emailOrUsername"
            label="Email or username"
            value={emailOrUsername}
            onChange={(e) => setEmailOrUsername(e.target.value)}
            leftIcon={<Mail className="h-4 w-4" />}
            required
            autoComplete="username"
          />
          <Input
            id="totp"
            label="Authenticator code"
            placeholder="6-digit code or backup code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            leftIcon={<Shield className="h-4 w-4" />}
            required
            autoComplete="one-time-code"
            inputMode="numeric"
          />
          <Input
            id="newPassword"
            label="New password"
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            leftIcon={<Lock className="h-4 w-4" />}
            rightIcon={
              <button type="button" onClick={() => setShow(!show)} className="p-0.5">
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            }
            required
            minLength={8}
            maxLength={72}
            autoComplete="new-password"
          />
          <PasswordStrength password={password} />
          <Button type="submit" className="w-full" size="lg" loading={loading} disabled={loading}>
            Reset password
          </Button>
          <p className="text-center text-sm">
            <Link to="/login" className="text-pulse-500 hover:text-pulse-600">
              Back to sign in
            </Link>
          </p>
        </form>
      </AuthLayout>
    );
  }

  // ── Production: email link (and users can still deep-link to 2FA via query if needed)
  return (
    <AuthLayout title="Forgot password" subtitle="We'll email you a reset link">
      {sent ? (
        <div className="space-y-4 text-center">
          <p className="text-sm text-[var(--color-ink-secondary)]">
            If an account exists for <strong>{email}</strong>, a reset link was sent. Check spam
            if you do not see it. The link expires in 1 hour.
          </p>
          <p className="text-xs text-[var(--color-ink-secondary)]">
            Have 2FA on?{' '}
            <Link to="/forgot-password?method=2fa" className="font-semibold text-pulse-500">
              Reset with authenticator
            </Link>
          </p>
          <Link
            to="/login"
            className="inline-block font-semibold text-pulse-500 hover:text-pulse-600"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onEmailSubmit} className="space-y-4">
          <Input
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            leftIcon={<Mail className="h-4 w-4" />}
            required
            autoComplete="email"
          />
          <Button type="submit" className="w-full" size="lg" loading={loading} disabled={loading}>
            Send reset link
          </Button>
          <p className="text-center text-sm text-[var(--color-ink-secondary)]">
            Have 2FA?{' '}
            <Link to="/forgot-password?method=2fa" className="font-semibold text-pulse-500">
              Use authenticator instead
            </Link>
          </p>
          <p className="text-center text-sm">
            <Link to="/login" className="text-pulse-500 hover:text-pulse-600">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}

