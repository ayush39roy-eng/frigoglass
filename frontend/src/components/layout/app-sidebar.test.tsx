import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';

import { AppSidebar } from './app-sidebar';

describe('AppSidebar a11y (P9-R03, qa Q-F1)', () => {
  it('has no serious/critical axe violations', async () => {
    renderWithProviders(<AppSidebar />);
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    expect(await seriousAxeViolations(nav)).toEqual([]);
  });

  // The muted-label contrast (≥ 4.5:1) is asserted from the tokens in
  // `styles/sidebar-contrast.test.ts`, which assumes FULL alpha. The failing
  // 3.68:1 / 3.06:1 came from a `/70` alpha modifier on these labels, so guard it here.
  it('renders muted sidebar text at full alpha (no /NN opacity modifier)', () => {
    const { container } = renderWithProviders(<AppSidebar />);
    const muted = [...container.querySelectorAll('[class*="text-sidebar-text-muted"]')];
    expect(muted.length).toBeGreaterThan(0);
    for (const el of muted) {
      expect(el.getAttribute('class')).not.toMatch(/text-sidebar-text-muted\/\d+/);
    }
    expect(screen.getByText('Hub scope')).toHaveClass('text-sidebar-text-muted');
  });
});
