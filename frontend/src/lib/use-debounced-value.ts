import * as React from 'react';

/**
 * Debounces a free-text filter value before it feeds a TanStack Query key, so
 * typing does not fire one request per keystroke. Born in the Audit Log
 * (P7-T05); promoted to `lib/` in P9-T04 when the User / Role Admin search
 * became the second consumer.
 */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
