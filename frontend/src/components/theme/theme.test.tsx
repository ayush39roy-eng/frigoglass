import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@/components/ui/tooltip';
import { THEME_STORAGE_KEY, useTheme } from './theme-context';
import { ThemeProvider } from './theme-provider';
import { ThemeToggle } from './theme-toggle';

function Probe() {
  const { preference, resolvedTheme } = useTheme();
  return (
    <div>
      <span data-testid="pref">{preference}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
    </div>
  );
}

function setSystemDark(isDark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('dark') ? isDark : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('ThemeProvider', () => {
  it('defaults to system and resolves against prefers-color-scheme', () => {
    setSystemDark(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('pref')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('reads an explicit stored preference', () => {
    setSystemDark(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('pref')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('throws if useTheme is used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useTheme must be used within/);
    spy.mockRestore();
  });
});

describe('ThemeToggle', () => {
  it('switches preference, persists to localStorage, and re-points the html class', async () => {
    setSystemDark(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider defaultPreference="light">
        <TooltipProvider>
          <ThemeToggle />
          <Probe />
        </TooltipProvider>
      </ThemeProvider>,
    );

    expect(document.documentElement).not.toHaveClass('dark');

    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));
    expect(screen.getByTestId('pref')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await user.click(screen.getByRole('radio', { name: 'System theme' }));
    expect(screen.getByTestId('pref')).toHaveTextContent('system');
    // 'system' clears the stored override.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});
