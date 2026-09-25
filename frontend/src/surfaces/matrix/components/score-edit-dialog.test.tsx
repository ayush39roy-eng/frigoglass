import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

import type { PriorityMatrixRow } from '../api/types';
import { ScoreEditDialog } from './score-edit-dialog';

function row(overrides: Partial<PriorityMatrixRow> = {}): PriorityMatrixRow {
  return {
    project_id: 'p1',
    project_name: 'Cooler A',
    hub: 'R&D-Greece',
    category: 'A+',
    type: 'NM',
    set_priority: null,
    has_score: false,
    strategic_project: null, new_customer: null, new_options: null, regulatory_compliance: null,
    quality_improvements: null, rm_savings: null, total_rm_savings: null, gross_margins: null,
    profitability: null, annual_volume: null, three_year_volume: null, new_models: null,
    capex_investment: null,
    hard_gates: [],
    weighted_score: null,
    normalized_pct: null,
    suggested_band: null,
    is_new_model: true,
    is_rm_saving_project: false,
    currency: 'EUR',
    capex_keur: null,
    rm_savings_keur: null,
    tcogs_eur: null,
    selling_price_eur: null,
    gross_margin_pct: null,
    ...overrides,
  };
}

describe('ScoreEditDialog', () => {
  it('rejects an out-of-range dimension value client-side and does not call onSubmit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ScoreEditDialog row={row()} open onOpenChange={vi.fn()} onSubmit={onSubmit} />,
    );

    const strategic = screen.getByLabelText('Strategic Project');
    await user.clear(strategic);
    await user.type(strategic, '9');
    await user.click(screen.getByRole('button', { name: 'Save score' }));

    expect(await screen.findByText('Maximum score is 5')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the 13 coerced dims + chosen hard gates on a valid save', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    renderWithProviders(
      <ScoreEditDialog row={row()} open onOpenChange={onOpenChange} onSubmit={onSubmit} />,
    );

    const gates = screen.getByRole('group', { name: /Hard gates/ });
    await user.click(within(gates).getByLabelText('Active safety non-compliance'));
    await user.click(screen.getByRole('button', { name: 'Save score' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [projectId, body] = onSubmit.mock.calls[0] as [string, Record<string, unknown>];
    expect(projectId).toBe('p1');
    expect(body).toMatchObject({
      strategic_project: 3,
      capex_investment: 3,
      hard_gates: ['Active safety non-compliance'],
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        'annual_volume', 'capex_investment', 'gross_margins', 'hard_gates', 'new_customer',
        'new_models', 'new_options', 'profitability', 'quality_improvements', 'regulatory_compliance',
        'rm_savings', 'strategic_project', 'three_year_volume', 'total_rm_savings',
      ].sort(),
    );
  });
});
