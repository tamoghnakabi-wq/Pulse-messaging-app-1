import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { PasswordStrength, passwordErrors, scorePassword } from '../components/ui/PasswordStrength';
import api from '../services/api';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    if (!token) {
      toast.error('Invalid or missing reset link. Request a new one.');
      return;
    }
    const errs = passwordErrors(password);
    if (errs.length || scorePassword(password) < 2) {
      toast.error(errs[0] || 'Please choose a stronger password');
      return;
    }
    if (password !== confirm) {
      toast.error('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await api.post(
        '/auth/reset-password',
        { token, password },
        { timeout: 20000 }
      );
      toast.success('Password reset! Please sign in.');
      navigate('/login', { replace: true });
    } catch (err: unknown) {
      const msg =
        (err as { code?: string; response?: { data?: { error?: { message?: string } } } })
          ?.response?.data?.error?.message ||
        ((err as { code?: string }).code === 'ECONNABORTED'
          ? 'Request timed out — try again'
          : 'Invalid or expired reset link');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  // Email token reset is disabled in development
  if (import.meta.env.DEV) {
    return (
      <AuthLayout
        title="Email reset disabled"
        subtitle="Use authenticator reset in development"
      >
        <p className="text-center text-sm text-[var(--color-ink-secondary)]">
          Email password reset is turned off in dev mode. Reset your password with Google
          Authenticator instead (requires 2FA enabled on the account).
        </p>
        <div className="mt-6 text-center">
          <Link to="/forgot-password" className="font-semibold text-pulse-500">
            Reset with authenticator
          </Link>
        </div>
      </AuthLayout>
    );
  }

  if (!token) {
    return (
      <AuthLayout title="Reset password" subtitle="This link is invalid or incomplete">
        <p className="text-center text-sm text-[var(--color-ink-secondary)]">
          Request a new reset link from the forgot password page.
        </p>
        <div className="mt-6 text-center">
          <Link to="/forgot-password" className="font-semibold text-pulse-500">
            Forgot password
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset password" subtitle="Choose a new secure password">
      <form onSubmit={onSubmit} className="space-y-4">
        <Input
          id="password"
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
        <Input
          id="confirm"
          label="Confirm password"
          type={show ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          leftIcon={<Lock className="h-4 w-4" />}
          required
          minLength={8}
          maxLength={72}
          autoComplete="new-password"
        />
        <Button type="submit" className="w-full" size="lg" loading={loading} disabled={loading}>
          Reset password
        </Button>
        <p className="text-center text-sm">
          <Link to="/login" className="text-pulse-500">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
