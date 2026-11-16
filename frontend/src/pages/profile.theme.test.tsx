import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { THEME_STORAGE_KEY } from '@/components/theme/theme-context';
import { renderWithProviders } from '@/test/render';

import ProfilePage from './profile';

describe('Profile — Appearance theme (owner request 2026-11-16)', () => {
  it('offers Light and Dark only, and saves the pick', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    const group = screen.getByRole('group', { name: 'Theme' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Light'),
      expect.stringContaining('Dark'),
    ]);
    expect(within(group).queryByText('System')).toBeNull();
    await user.click(within(group).getByRole('radio', { name: /Dark/ }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    vi.unstubAllGlobals();
  });
});
