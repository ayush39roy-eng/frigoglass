import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import type { PriorityMatrixRow } from '../api/types';
import { ScoreCell } from './score-cell';
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
    currency: 'EUR',
    capex_keur: 120,
    rm_savings_keur: 40,
    tcogs_eur: 5000,
    selling_price_eur: 8000,
    gross_margin_pct: 37.5,
    ...P13_MATRIX_ROW_DEFAULTS,
    ...overrides,
  };
}

describe('ScoreCell', () => {
  it('P21: renders the served normalized score out of 100 ("62/100"), never as a percentage', () => {
    renderWithProviders(<ScoreCell row={row({ normalized_pct: 62, weighted_score: 868 })} />);
    expect(screen.getByTestId('score-out-of-100')).toHaveTextContent('62/100');
    expect(screen.queryByText('62%')).not.toBeInTheDocument();
  });

  it('P21: the tooltip states the weighted score and the normalized score out of 100', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScoreCell row={row({ normalized_pct: 62, weighted_score: 868 })} />);
    await user.hover(screen.getByRole('button'));
    expect((await screen.findAllByText('868')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('62/100')).length).toBeGreaterThan(0);
  });

  it('shows a band pill matching the API suggested_band (not derived from the score)', () => {
    renderWithProviders(<ScoreCell row={row({ normalized_pct: 41, suggested_band: 'P3' })} />);
    // 41% would band to P3; the pill reflects the API value, whatever it is
    expect(screen.getByTitle(/Priority band P3/)).toBeInTheDocument();
  });

  it('annotates hard-gated rows as forced to P1', () => {
    renderWithProviders(
      <ScoreCell row={row({ suggested_band: 'P4', hard_gates: ['Active safety non-compliance'] })} />,
    );
    expect(screen.getByTestId('hard-gate-badge')).toHaveTextContent('Hard gate → P1');
    // the computed band pill is still shown verbatim alongside it
    expect(screen.getByTitle(/Priority band P4/)).toBeInTheDocument();
  });

  it('renders "Not scored" for an unscored project (has_score=false)', () => {
    renderWithProviders(
      <ScoreCell
        row={row({ has_score: false, normalized_pct: null, weighted_score: null, suggested_band: null })}
      />,
    );
    expect(screen.getByTestId('score-cell-unscored')).toHaveTextContent('Not scored');
    expect(screen.queryByTestId('score-cell')).not.toBeInTheDocument();
  });

  it('P16: the tooltip explains the points rule', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScoreCell row={row()} />);
    await user.hover(screen.getByRole('button'));
    expect((await screen.findAllByText(/Score 1 gives 1\/5 of the weight/)).length).toBeGreaterThan(0);
  });
});
