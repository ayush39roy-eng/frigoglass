import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { BEquivalentRow } from '../api/types';
import { formatRatio, referenceCategory } from '../lib/b-equivalent';
import { BEquivalentPanel } from './b-equivalent-panel';

const ROWS: BEquivalentRow[] = [
  { category: 'A+', design_weeks: 20, lab_weeks: 12, design_ratio: 2.86, lab_ratio: 2 },
  { category: 'B', design_weeks: 7, lab_weeks: 6, design_ratio: 1, lab_ratio: 1 },
  { category: 'C', design_weeks: 4, lab_weeks: 0, design_ratio: 0.57, lab_ratio: null },
];

describe('BEquivalentPanel (P13-T16)', () => {
  it('formats served ratios verbatim and names the reference per workflow', () => {
    expect(formatRatio(2.86)).toBe('2.86×');
    expect(formatRatio(1)).toBe('1.00×');
    expect(formatRatio(null)).toBe('—');
    expect(referenceCategory('PDD')).toBe('B');
    expect(referenceCategory('OEM')).toBe('B-OEM');
  });

  it('shows each served ratio and weeks, and the reference weeks footer', () => {
    renderWithProviders(<BEquivalentPanel workflow="PDD" rows={ROWS} />);
    expect(screen.getByTestId('beq-A+')).toHaveTextContent('2.86×');
    expect(screen.getByTestId('beq-A+')).toHaveTextContent('20w');
    expect(screen.getByTestId('beq-C')).toHaveTextContent('—');
    expect(screen.getByText(/B = 7w/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /PDD B-equivalent workload, relative to B/ })).toBeInTheDocument();
  });

  it('has no serious axe violations', async () => {
    const { container } = renderWithProviders(<BEquivalentPanel workflow="PDD" rows={ROWS} />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
