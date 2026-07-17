import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, User, AtSign } from 'lucide-react';
import toast from 'react-hot-toast';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { PasswordStrength, passwordErrors, scorePassword } from '../components/ui/PasswordStrength';
import { useAuthStore } from '../store/authStore';

export function RegisterPage() {
  const navigate = useNavigate();
  const register = useAuthStore((s) => s.register);
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    displayName: '',
  });
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = passwordErrors(form.password);
    if (errs.length || scorePassword(form.password) < 2) {
      toast.error(errs[0] || 'Please choose a stronger password');
      return;
    }
    setLoading(true);
    try {
      await register(form);
      toast.success('Account created! Check your email to verify.');
      navigate('/');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
          ?.error?.message || 'Registration failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Create your account" subtitle="Join Pulse and start messaging">
      <form onSubmit={onSubmit} className="space-y-4">
        <Input
          id="displayName"
          label="Display name"
          placeholder="Alex Rivera"
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          leftIcon={<User className="h-4 w-4" />}
          required
        />
        <Input
          id="username"
          label="Username"
          placeholder="alexrivera"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          leftIcon={<AtSign className="h-4 w-4" />}
          required
          pattern="[a-zA-Z0-9_]+"
        />
        <Input
          id="email"
          label="Email"
          type="email"
          placeholder="you@example.com"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          leftIcon={<Mail className="h-4 w-4" />}
          required
        />
        <Input
          id="password"
          label="Password"
          type="password"
          placeholder="Min. 8 characters, letter + number"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          leftIcon={<Lock className="h-4 w-4" />}
          required
          minLength={8}
          maxLength={72}
        />
        <PasswordStrength password={form.password} />
        <Button type="submit" className="w-full" size="lg" loading={loading}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-[var(--color-ink-secondary)]">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-pulse-500 hover:text-pulse-600">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
