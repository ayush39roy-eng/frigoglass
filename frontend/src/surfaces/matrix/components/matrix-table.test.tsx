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
});
