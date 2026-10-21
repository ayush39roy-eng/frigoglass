import * as React from 'react';

/** Subscribes to a CSS media query (false where `matchMedia` is unavailable). */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Below Tailwind `md` (768 px): the Matrix view panel collapses into a sheet. */
export const NARROW_QUERY = '(max-width: 767px)';
