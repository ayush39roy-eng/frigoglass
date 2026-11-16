import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@/components/ui/tooltip';
import { seriousAxeViolations } from '@/test/axe';
import { isThemePreference, THEME_STORAGE_KEY, useTheme } from './theme-context';
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

const listeners: { add: ReturnType<typeof vi.fn> }[] = [];

function setSystemDark(isDark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const add = vi.fn();
    listeners.push({ add });
    return {
      matches: query.includes('dark') ? isDark : false,
      media: query,
      onchange: null,
      addListener: add,
      removeListener: vi.fn(),
      addEventListener: add,
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.localStorage.clear();
  listeners.length = 0;
});

describe('ThemeProvider', () => {
  it('first visit: resolves the OS preference once and saves it as a concrete theme', () => {
    setSystemDark(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('pref')).toHaveTextContent('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('migrates a legacy stored "system" to the OS theme and saves it', () => {
    setSystemDark(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('pref')).toHaveTextContent('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('migrates a legacy "system" to dark when the OS prefers dark', () => {
    setSystemDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('pref')).toHaveTextContent('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('keeps an explicit stored preference even when the OS disagrees, and does not follow the OS live', () => {
    setSystemDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('pref')).toHaveTextContent('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    // No OS change listener is registered.
    expect(listeners.every((l) => l.add.mock.calls.length === 0)).toBe(true);
  });

  it('"system" is no longer a valid preference', () => {
    expect(isThemePreference('system')).toBe(false);
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
  });

  it('throws if useTheme is used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useTheme must be used within/);
    spy.mockRestore();
  });
});

describe('ThemeToggle', () => {
  function renderToggle() {
    return render(
      <ThemeProvider defaultPreference="light">
        <TooltipProvider>
          <ThemeToggle />
          <Probe />
        </TooltipProvider>
      </ThemeProvider>,
    );
  }

  it('offers exactly two options, Light and Dark (no System)', () => {
    setSystemDark(false);
    renderToggle();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Light theme' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark theme' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'System theme' })).toBeNull();
  });

  it('switches preference, persists to localStorage, and re-points the html class', async () => {
    setSystemDark(false);
    const user = userEvent.setup();
    renderToggle();

    expect(document.documentElement).not.toHaveClass('dark');

    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));
    expect(screen.getByTestId('pref')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await user.click(screen.getByRole('radio', { name: 'Light theme' }));
    expect(screen.getByTestId('pref')).toHaveTextContent('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    // Re-clicking the active item does not clear the choice.
    await user.click(screen.getByRole('radio', { name: 'Light theme' }));
    expect(screen.getByTestId('pref')).toHaveTextContent('light');
  });

  it('has no serious or critical axe violations', async () => {
    setSystemDark(false);
    const { container } = renderToggle();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
