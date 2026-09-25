import { createContext, useContext } from 'react';

/** User-selectable preference. `system` follows the OS `prefers-color-scheme`. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** The actually-applied theme after resolving `system`. */
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key — must match the pre-paint script in index.html. */
export const THEME_STORAGE_KEY = 'rpd-theme';

export interface ThemeContextValue {
  /** What the user picked. */
  preference: ThemePreference;
  /** What is on the `<html>` element right now. */
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within <ThemeProvider>');
  }
  return ctx;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}
