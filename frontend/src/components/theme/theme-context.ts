import { createContext, useContext } from 'react';

/**
 * User-selectable theme: Light or Dark only (owner request 2026-11-16 removed "System").
 * A first visit, or a legacy stored 'system', resolves the OS `prefers-color-scheme` ONCE and
 * saves that concrete value; the OS is not followed live afterwards.
 */
export type ThemePreference = 'light' | 'dark';

/** The applied theme. Identical to the preference now that 'system' is gone; kept as an alias. */
export type ResolvedTheme = ThemePreference;

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
  return value === 'light' || value === 'dark';
}
