import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore } from './store/authStore';
import { useTheme } from './hooks/useTheme';
import { useMobileViewport } from './hooks/useMobileViewport';
import { LoadingScreen } from './components/ui/LoadingScreen';
import { ErrorBoundary } from './components/ui/ErrorBoundary';

// Auth pages stay lazy (rarely needed when already signed in)
const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((m) => ({ default: m.LoginPage }))
);
const RegisterPage = lazy(() =>
  import('./pages/RegisterPage').then((m) => ({ default: m.RegisterPage }))
);
const ForgotPasswordPage = lazy(() =>
  import('./pages/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage }))
);
const ResetPasswordPage = lazy(() =>
  import('./pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage }))
);
const VerifyEmailPage = lazy(() =>
  import('./pages/VerifyEmailPage').then((m) => ({ default: m.VerifyEmailPage }))
);
// Chat is the primary surface — prefetch starts in bootstrap / main.tsx
const ChatPage = lazy(() =>
  import('./pages/ChatPage').then((m) => ({ default: m.ChatPage }))
);

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  if (isLoading) return <LoadingScreen />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  if (isLoading) return <LoadingScreen />;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const bootstrap = useAuthStore((s) => s.bootstrap);
  useTheme();
  useMobileViewport();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route
          path="/"
          element={
            <PrivateRoute>
              <ErrorBoundary label="Chat">
                <ChatPage />
              </ErrorBoundary>
            </PrivateRoute>
          }
        />
        <Route
          path="/login"
          element={
            <PublicOnly>
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route
          path="/register"
          element={
            <PublicOnly>
              <RegisterPage />
            </PublicOnly>
          }
        />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
        <AppRoutes />
      </div>
      <Toaster
        position="top-center"
        gutter={10}
        toastOptions={{
          className:
            '!rounded-2xl !border !border-[var(--color-border)] !bg-[var(--color-surface-elevated)] !px-4 !py-3 !text-sm !font-medium !tracking-[-0.01em] !text-[var(--color-ink)] !shadow-[0_12px_40px_rgba(0,0,0,0.14)] !max-w-[min(92vw,24rem)]',
          duration: 2800,
          success: {
            iconTheme: { primary: '#0a84ff', secondary: '#fff' },
            className:
              '!rounded-2xl !border !border-pulse-500/20 !bg-[var(--color-surface-elevated)] !px-4 !py-3 !text-sm !font-medium !tracking-[-0.01em] !text-[var(--color-ink)] !shadow-[0_12px_40px_rgba(10,132,255,0.12)] !max-w-[min(92vw,24rem)]',
          },
          error: {
            iconTheme: { primary: '#ef4444', secondary: '#fff' },
            className:
              '!rounded-2xl !border !border-red-500/20 !bg-[var(--color-surface-elevated)] !px-4 !py-3 !text-sm !font-medium !tracking-[-0.01em] !text-[var(--color-ink)] !shadow-[0_12px_40px_rgba(239,68,68,0.12)] !max-w-[min(92vw,24rem)]',
          },
        }}
        containerStyle={{
          top: 'max(0.85rem, env(safe-area-inset-top))',
        }}
      />
    </BrowserRouter>
  );
}
