import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
  }),
}));

import { renderWithProviders } from '@/test/render';

import type { PriorityMatrixRow } from '../api/types';
import { MatrixTable } from './matrix-table';
import { P13_MATRIX_ROW_DEFAULTS } from '../test-fixtures';

function row(overrides: Partial<PriorityMatrixRow> = {}): PriorityMatrixRow {
  return {
    project_id: 'p1',
    project_name: 'Cooler A',
    hub: 'R&D-Greece',
    category: 'A+',
    type: 'NM',
    set_priority: 'P2',
    has_score: true,
    strategic_project: 5, new_customer: 4, new_options: 3, regulatory_compliance: 2,
    quality_improvements: 3, rm_savings: 4, total_rm_savings: 3, gross_margins: 3,
    profitability: 4, annual_volume: 3, three_year_volume: 3, new_models: 2, capex_investment: 4,
    hard_gates: [],
    weighted_score: 980,
    normalized_pct: 70,
    suggested_band: 'P1',
    is_new_model: true,
    is_rm_saving_project: true,
    currency: 'USD',
    capex_keur: 129.6,
    rm_savings_keur: 43.2,
    tcogs_eur: 5400,
    selling_price_eur: 8640,
    gross_margin_pct: 37.5,
    ...P13_MATRIX_ROW_DEFAULTS,
    ...overrides,
  };
}

describe('MatrixTable', () => {
  it('renders financial figures verbatim from the row (already converted server-side)', () => {
    renderWithProviders(
      <MatrixTable rows={[row()]} currency="USD" canEdit={false} onEdit={vi.fn()} />,
    );
    // 129.6 is `row.capex_keur` as-is; nothing is multiplied by a rate here
    expect(screen.getByText('129.6')).toBeInTheDocument();
    expect(screen.getByText('37.5%')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /CAPEX \(k USD\)/ })).toBeInTheDocument();
  });

  it('shows no edit affordance for a read-only role (canEdit=false)', () => {
    renderWithProviders(
      <MatrixTable rows={[row()]} currency="EUR" canEdit={false} onEdit={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /Edit prioritization score/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('exposes a per-row edit button when canEdit=true', async () => {
    const onEdit = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderWithProviders(
      <MatrixTable rows={[row()]} currency="EUR" canEdit onEdit={onEdit} />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit prioritization score for Cooler A' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1' }));
  });

  it('renders an unscored row without inventing a score', () => {
    renderWithProviders(
      <MatrixTable
        rows={[
          row({
            project_id: 'p2',
            project_name: 'Cooler B',
            has_score: false,
            strategic_project: null,
            normalized_pct: null,
            weighted_score: null,
            suggested_band: null,
            hard_gates: [],
          }),
        ]}
        currency="EUR"
        canEdit={false}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText('Cooler B')).toBeInTheDocument();
    expect(screen.getByTestId('score-cell-unscored')).toBeInTheDocument();
  });

  it('P9: links each project to its workspace and exposes the scoring anchors on the dimension headers', () => {
    renderWithProviders(<MatrixTable rows={[row()]} currency="USD" canEdit={false} onEdit={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Cooler A' })).toHaveAttribute('href', '/projects/p1');
    expect(
      screen.getByRole('button', {
        name: 'CAPEX Investment (inverted): 1 = > €500K, 5 = < €10K (Investment & Feasibility, weight 15)',
      }),
    ).toBeInTheDocument();
  }, 20_000); // synchronous, but the first full-table render is slow when CPU is saturated (QA-P15-3)

  it('P16: shows served points/weight in the dimension cells (no client maths)', () => {
    renderWithProviders(
      <MatrixTable
        rows={[row({ dimension_points: { gross_margins: { points: 15, scaled_points: 5.08 } } })]}
        currency="USD"
        canEdit={false}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText('15/25')).toBeInTheDocument();
    expect(screen.getByTitle('15 / 25 points (5.1 of 100 scale)')).toBeInTheDocument();
  });

  it('sorts projects in order of the score: rank 1 first, descending score, unscored at bottom', () => {
    const rowHigh = row({
      project_id: 'p-high',
      project_name: 'Project Alpha',
      weighted_score: 950,
      rank: 2,
      has_score: true,
    });
    const rowTop = row({
      project_id: 'p-top',
      project_name: 'Project Zebra',
      weighted_score: 1100,
      rank: 1,
      has_score: true,
    });
    const rowLow = row({
      project_id: 'p-low',
      project_name: 'Project Beta',
      weighted_score: 400,
      rank: 3,
      has_score: true,
    });
    const rowUnscored = row({
      project_id: 'p-none',
      project_name: 'Project Gamma',
      weighted_score: null,
      rank: null,
      has_score: false,
    });

    // Pass in arbitrary/shuffled order: low, unscored, high, top
    renderWithProviders(
      <MatrixTable
        rows={[rowLow, rowUnscored, rowHigh, rowTop]}
        currency="EUR"
        canEdit={false}
        onEdit={vi.fn()}
      />,
    );

    const projectLinks = screen.getAllByRole('link', { name: /Project / });
    expect(projectLinks.map((l) => l.textContent)).toEqual([
      'Project Zebra', // Rank 1, score 1100
      'Project Alpha', // Rank 2, score 950
      'Project Beta',  // Rank 3, score 400
      'Project Gamma', // Unscored (rank null)
    ]);
  });
});
