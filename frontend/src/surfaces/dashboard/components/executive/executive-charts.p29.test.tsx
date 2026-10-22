import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import { TypeBars } from './executive-charts';

/** P29-T04 frontend (ADR 0038 amendment): the Executive "Projects by type"
 *  chart names RC "Regulatory / Business Compliance", in full (no ellipsis). */
describe('TypeBars — RC label (P29-T04)', () => {
  it('shows the full RC label from the shared label source', () => {
    renderWithProviders(<TypeBars buckets={[{ key: 'RC', count: 63, share_pct: 24.9 }]} />);
    const row = within(screen.getByTestId('exec-type-chart')).getByTestId('exec-type-row-RC');
    const label = within(row).getByTestId('exec-type-label');
    expect(label).toHaveTextContent('Regulatory / Business Compliance');
    expect(label).not.toHaveClass('truncate');
    // Breaks only at " / ": two unbreakable parts, the first keeping the slash.
    expect([...label.querySelectorAll('.whitespace-nowrap')].map((n) => n.textContent)).toEqual([
      'Regulatory /',
      'Business Compliance',
    ]);
    expect(row).toHaveAccessibleName('Regulatory / Business Compliance: 63 projects (24.9%)');
  });

  it('each row is label + figures on one line over a full-width bar; single-part labels stay on one line', () => {
    renderWithProviders(
      <TypeBars
        buckets={[
          { key: 'NM', count: 40, share_pct: 15.81 },
          { key: 'CO', count: 89, share_pct: 35.18 },
          { key: 'RC', count: 63, share_pct: 24.9 },
          { key: 'NO', count: 30, share_pct: 11.86 },
          { key: 'IMP', count: 28, share_pct: 11.07 },
          { key: 'Unmapped', count: 3, share_pct: 1.19 },
        ]}
      />,
    );
    for (const key of ['NM', 'CO', 'RC', 'NO', 'IMP', 'Unmapped']) {
      const row = screen.getByTestId(`exec-type-row-${key}`);
      const head = within(row).getByTestId('exec-type-head');
      // Line 1: label left, served "count · %" right (never wraps).
      expect(head).toHaveClass('flex', 'justify-between');
      expect(head.children[0]).toBe(within(row).getByTestId('exec-type-label'));
      expect(head.children[1]).toBe(within(row).getByTestId('exec-type-figures'));
      expect(within(row).getByTestId('exec-type-figures')).toHaveClass('whitespace-nowrap', 'shrink-0');
      // Line 2: a full-width thin track whose fill is the served share.
      const track = within(row).getByTestId('exec-type-track');
      expect(head.nextElementSibling).toBe(track);
      expect(track).toHaveClass('w-full', 'h-1.5', 'rounded-full');
    }
    expect(within(screen.getByTestId('exec-type-row-CO')).getByTestId('exec-type-figures')).toHaveTextContent('89 · 35.18%');
    expect(screen.getByTestId('exec-type-row-CO').querySelector('[data-served-share]')).toHaveAttribute('data-served-share', '35.18');
    const co = within(screen.getByTestId('exec-type-row-CO')).getByTestId('exec-type-label');
    expect(co.querySelectorAll('.whitespace-nowrap')).toHaveLength(1);
  });
});
