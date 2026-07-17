import { useEffect } from 'react';
import { useUIStore } from '../store/uiStore';

export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const applyTheme = useUIStore((s) => s.applyTheme);
  const setTheme = useUIStore((s) => s.setTheme);

  useEffect(() => {
    applyTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (useUIStore.getState().theme === 'system') applyTheme();
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme, applyTheme]);

  return { theme, setTheme };
}
