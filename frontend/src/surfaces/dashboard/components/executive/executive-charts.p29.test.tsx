import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import { TypeDonut } from './executive-charts';

/** P29-T04 frontend (ADR 0038 amendment): the Executive "Projects by type"
 *  chart names RC "Regulatory / Business Compliance", in full (no ellipsis).
 *  P31: the chart is now a donut; its legend toggles carry the label. */
describe('TypeDonut — RC label (P29-T04, P31)', () => {
  it('shows the full RC label from the shared label source', () => {
    renderWithProviders(
      <TypeDonut buckets={[{ key: 'RC', count: 63, share_pct: 24.9 }]} total={63} selected={[]} onChange={() => undefined} />,
    );
    const donut = screen.getByTestId('exec-type-donut');
    expect(within(donut).getByTestId('exec-type-donut-slice-RC')).toHaveTextContent('Regulatory / Business Compliance');
    expect(within(donut).getByTestId('exec-type-donut-slice-RC')).toHaveTextContent('63 · 24.9%');
    const chip = within(donut).getByRole('button', { name: 'Regulatory / Business Compliance' });
    expect(chip).toHaveClass('whitespace-nowrap');
    expect(chip.className).not.toContain('truncate');
  });
});
