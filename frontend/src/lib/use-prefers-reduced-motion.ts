import * as React from 'react';

import { usePreferencesStore } from '@/stores/preferences';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Dependency-free `prefers-reduced-motion` hook. Framer Motion ships its own
 * `useReducedMotion()`, but Framer Motion is a per-surface lazy dependency — the app
 * shell and the Lottie boundary must not pull it into the initial bundle just to read
 * one media query.
 */
export function usePrefersReducedMotion(): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    const mql = window.matchMedia(QUERY);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const system = React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
  // Profile & settings "Reduce motion" (stores/preferences.ts) forces it on.
  const preferred = usePreferencesStore((s) => s.reduceMotion);
  return system || preferred;
}
