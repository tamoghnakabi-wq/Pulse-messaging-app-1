import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Button } from '../components/ui/Button';
import { authService } from '../services/auth.service';

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      return;
    }
    authService
      .verifyEmail(token)
      .then(() => setStatus('ok'))
      .catch(() => setStatus('error'));
  }, [token]);

  return (
    <AuthLayout
      title={
        status === 'loading'
          ? 'Verifying…'
          : status === 'ok'
            ? 'Email verified'
            : 'Verification failed'
      }
      subtitle={
        status === 'ok'
          ? 'Your email has been confirmed.'
          : status === 'error'
            ? 'This link is invalid or expired.'
            : 'Please wait'
      }
    >
      <div className="text-center">
        {status !== 'loading' && (
          <Link to="/">
            <Button className="w-full">Continue to Pulse</Button>
          </Link>
        )}
      </div>
    </AuthLayout>
  );
}
