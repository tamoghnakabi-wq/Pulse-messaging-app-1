import { useEffect } from 'react';
import { rafThrottle } from '../shared/lib/raf';

/**
 * Stable mobile viewport + keyboard inset.
 *
 * Critical: do NOT resize the whole app shell to visualViewport.height when the
 * Safari URL bar shows/hides — that causes constant layout thrash ("glitching").
 * Keep shell height tied to layout viewport; only lift the composer for the keyboard.
 */
export function useMobileViewport() {
  useEffect(() => {
    const root = document.documentElement;
    let lastAppH = 0;
    let lastKb = -1;
    let lastOffset = -1;

    const isTextField = (el: EventTarget | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(
          type
        );
      }
      return el.isContentEditable;
    };

    const setVars = () => {
      const vv = window.visualViewport;
      // Layout height is stable across URL-bar show/hide on modern iOS
      const layoutH = Math.round(window.innerHeight || document.documentElement.clientHeight || 0);
      const visualH = Math.round(vv?.height ?? layoutH);
      const offsetTop = Math.round(vv?.offsetTop ?? 0);

      // Keyboard: only count a large shrink while a text field is focused
      const focused = isTextField(document.activeElement);
      const rawGap = Math.max(0, layoutH - visualH - offsetTop);
      // URL bar changes are usually < 80–100px; keyboards are much larger
      const keyboardInset = focused && rawGap > 120 ? rawGap : 0;

      // Shell height: prefer stable layoutH (no jump when chrome toggles)
      // On orientation change layoutH updates once — that's fine.
      const appH = layoutH > 0 ? layoutH : visualH;

      if (appH !== lastAppH) {
        lastAppH = appH;
        root.style.setProperty('--app-height', `${appH}px`);
      }
      if (offsetTop !== lastOffset) {
        lastOffset = offsetTop;
        root.style.setProperty('--vv-offset-top', `${offsetTop}px`);
      }
      if (keyboardInset !== lastKb) {
        lastKb = keyboardInset;
        root.style.setProperty('--keyboard-inset', `${keyboardInset}px`);
        root.style.setProperty(
          '--composer-bottom',
          keyboardInset > 0
            ? `${keyboardInset}px`
            : `env(safe-area-inset-bottom, 0px)`
        );
      }
    };

    const onFrame = rafThrottle(setVars);

    setVars();
    const vv = window.visualViewport;
    // resize only — ignore vv.scroll (URL bar scrub) to prevent continuous reflow
    vv?.addEventListener('resize', onFrame, { passive: true });
    window.addEventListener('resize', onFrame, { passive: true });
    window.addEventListener('orientationchange', () => {
      // iOS reports wrong height mid-rotation — settle after
      onFrame();
      window.setTimeout(onFrame, 80);
      window.setTimeout(onFrame, 280);
    });

    const onFocusIn = () => {
      onFrame();
      window.setTimeout(onFrame, 50);
      window.setTimeout(onFrame, 180);
      window.setTimeout(onFrame, 350);
    };
    const onFocusOut = () => {
      // Reset keyboard inset after blur (keyboard animates closed)
      window.setTimeout(onFrame, 50);
      window.setTimeout(onFrame, 200);
      window.setTimeout(onFrame, 400);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      vv?.removeEventListener('resize', onFrame);
      window.removeEventListener('resize', onFrame);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);
}
