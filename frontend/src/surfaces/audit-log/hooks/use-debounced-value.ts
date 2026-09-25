import * as React from 'react';

/**
 * Debounces a free-text filter value before it feeds a TanStack Query key,
 * so typing into the Audit Log's entity-id / actor / action text filters
 * doesn't fire one request per keystroke. Scoped to this surface only — no
 * other surface in this codebase has a free-text filter input yet (every
 * existing filter is a `<Select>` that only changes on a discrete pick), so
 * this is not promoted to a shared hook until a second surface needs it.
 */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
