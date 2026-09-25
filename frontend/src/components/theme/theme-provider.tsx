import * as React from 'react';

import { isThemePreference, THEME_STORAGE_KEY, ThemeContext } from './theme-context';
import type { ResolvedTheme, ThemePreference } from './theme-context';

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
}

function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Test seam only — overrides the value read from localStorage. */
  defaultPreference?: ThemePreference;
}

export function ThemeProvider({ children, defaultPreference }: ThemeProviderProps): React.JSX.Element {
  const [preference, setPreferenceState] = React.useState<ThemePreference>(
    () => defaultPreference ?? readStoredPreference(),
  );
  const [systemResolved, setSystemResolved] = React.useState<ResolvedTheme>(() => systemTheme());

  // Track OS changes so `system` stays live without a reload.
  React.useEffect(() => {
    const mql = window.matchMedia(MEDIA_QUERY);
    const onChange = () => setSystemResolved(mql.matches ? 'dark' : 'light');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = preference === 'system' ? systemResolved : preference;

  React.useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setPreference = React.useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === 'system') {
        window.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch {
      /* localStorage unavailable — in-memory preference still applies for this session */
    }
  }, []);

  const value = React.useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
