import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { useAuthStore } from './store/authStore';
import { prefetchChatShell } from './utils/sessionCache';
import { readRefreshToken } from './shared/api/tokenStorage';

// Start auth + shell download before React commits (shaves a full paint off cold start)
// Access tokens are memory-only; session = refresh token in sessionStorage
const hasSession = !!readRefreshToken();
if (hasSession) {
  prefetchChatShell();
  // Warm E2E crypto module so open-chat doesn't pay first dynamic-import cost
  void import('./services/e2e');
  void useAuthStore.getState().bootstrap();
}

// Apply stored theme ASAP to avoid flash
try {
  const theme = localStorage.getItem('pulse_theme') || 'system';
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
} catch {
  /* */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
