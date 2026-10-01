import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';

import { AppSidebar } from './app-sidebar';

describe('AppSidebar a11y (P9-R03, qa Q-F1)', () => {
  it('has no serious/critical axe violations', async () => {
    renderWithProviders(<AppSidebar />);
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    expect(await seriousAxeViolations(nav)).toEqual([]);
  });

  // 2026-10-01 (Boltshift): the rail is now the floating WHITE rail (reusing
  // `--color-surface`/`--color-primary`/`--color-text-muted`, the same tokens
  // every other card in the app already uses), not the petrol "dark island"
  // this regression guard was originally written against — there is no more
  // visible "Hub scope" text in the sidebar at all (it moved to the AppHeader's
  // control pills; see app-header.tsx). `--color-sidebar-text-muted` and the
  // `petrol` ramp are consequently unused by this component now (left defined,
  // not deleted — see this file's own doc comment), so the only thing left to
  // guard here is that IF any element still opts into that class, it is never
  // alpha-modified — `styles/sidebar-contrast.test.ts` keeps asserting the
  // token's own contrast ratio in isolation, independent of consumption.
  it('never applies a `/NN` alpha modifier to text-sidebar-text-muted, if used', () => {
    const { container } = renderWithProviders(<AppSidebar />);
    const muted = [...container.querySelectorAll('[class*="text-sidebar-text-muted"]')];
    for (const el of muted) {
      expect(el.getAttribute('class')).not.toMatch(/text-sidebar-text-muted\/\d+/);
    }
  });

  it('every nav item keeps an accessible name even though the rail is icon-only', () => {
    renderWithProviders(<AppSidebar />);
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    expect(within(nav).getAllByRole('link').length).toBeGreaterThan(0);
  });
});
