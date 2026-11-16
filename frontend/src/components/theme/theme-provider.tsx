import * as React from 'react';

import { isThemePreference, THEME_STORAGE_KEY, ThemeContext } from './theme-context';
import type { ThemePreference } from './theme-context';

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

function osTheme(): ThemePreference {
  try {
    return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * The stored Light/Dark choice. A first visit (nothing stored) or a legacy 'system' value
 * (the option was removed 2026-11-16) resolves the OS preference ONCE and saves that concrete
 * value, so later visits keep it and the OS is not followed live. Mirrors index.html.
 */
function readInitialPreference(): ThemePreference {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return osTheme();
  }
  if (isThemePreference(stored)) return stored;
  const resolved = osTheme();
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, resolved);
  } catch {
    /* localStorage unavailable — the resolved theme still applies for this session */
  }
  return resolved;
}

function applyTheme(theme: ThemePreference): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Test seam only — overrides the value read from localStorage. */
  defaultPreference?: ThemePreference;
}

export function ThemeProvider({ children, defaultPreference }: ThemeProviderProps): React.JSX.Element {
  const [preference, setPreferenceState] = React.useState<ThemePreference>(
    () => defaultPreference ?? readInitialPreference(),
  );

  React.useEffect(() => {
    applyTheme(preference);
  }, [preference]);

  const setPreference = React.useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable — in-memory preference still applies for this session */
    }
  }, []);

  const value = React.useMemo(
    () => ({ preference, resolvedTheme: preference, setPreference }),
    [preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
