import * as React from 'react';

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

  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
