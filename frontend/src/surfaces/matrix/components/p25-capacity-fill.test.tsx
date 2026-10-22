/** P25-T02 (ADR 0036): the "P1 · capacity fill" chip, the per-hub panel, the distribution and
 *  summary notes. Every figure is a served field. */
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { PriorityDistribution, PriorityMatrixRow, PriorityPortfolioSummary } from '../api/types';
import { P13_MATRIX_ROW_DEFAULTS } from '../test-fixtures';
import { CAPACITY_FILL_EXPLAINER, CapacityFillPanel } from './capacity-fill-panel';
import { PortfolioSummaryPanel } from './portfolio-summary-panel';
import { BandDistributionPanel } from './score-charts';
import { ScoreCell } from './score-cell';

const PROMOTED = 'P1 (capacity fill): hub P1 design load 9.00 of 10.00 weeks with this project';
const STOPPED = 'Not promoted: hub P1 design load would be 11.00 of 10.00 weeks';

function row(overrides: Partial<PriorityMatrixRow> = {}): PriorityMatrixRow {
  return {
    project_id: 'p1', project_name: 'Cooler A', hub: 'R&D-Greece', category: 'A', type: 'NM', set_priority: 'P2',
    has_score: true, hard_gates: [],
    weighted_score: 177, normalized_pct: 60, suggested_band: 'P2', is_new_model: false, is_rm_saving_project: false,
    currency: 'EUR', capex_keur: null, rm_savings_keur: null, tcogs_eur: null, selling_price_eur: null,
    gross_margin_pct: null,
    ...P13_MATRIX_ROW_DEFAULTS,
    ...overrides,
  };
}

describe('Suggested band chip (P25)', () => {
  it('a promoted row reads "P1 · capacity fill" with the score band, and the tooltip is the served reason', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ScoreCell row={row({ suggested_band: 'P1', score_band: 'P2', capacity_fill: true, capacity_fill_reason: PROMOTED })} />,
    );
    const chip = screen.getByTestId('band-chip-capacity-fill');
    expect(chip).toHaveTextContent('P1 · capacity fill');
    expect(within(chip).getByTestId('band-chip-score-band')).toHaveTextContent('score band P2');
    const trigger = screen.getByRole('button', { name: 'Suggested band P1 by capacity fill, score band P2' });
    await user.hover(trigger);
    expect((await screen.findAllByText(PROMOTED)).length).toBeGreaterThan(0);
  });

  it('a non-promoted candidate keeps its normal chip; the served reason is in the tooltip only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScoreCell row={row({ score_band: 'P2', capacity_fill_reason: STOPPED })} />);
    expect(screen.queryByTestId('band-chip-capacity-fill')).not.toBeInTheDocument();
    expect(screen.queryByText(STOPPED)).not.toBeInTheDocument();
    expect(screen.getByTitle(/Priority band P2/)).toBeInTheDocument();
    await user.hover(screen.getByTestId('band-chip-with-reason'));
    expect((await screen.findAllByText(STOPPED)).length).toBeGreaterThan(0);
  });

  it('a row with no fill and no reason is the plain band pill (pre-P25 API too)', () => {
    renderWithProviders(<ScoreCell row={row()} />);
    expect(screen.queryByTestId('band-chip-capacity-fill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('band-chip-with-reason')).not.toBeInTheDocument();
  });
});

describe('Capacity fill panel (P25)', () => {
  it('shows each served hub: capacity, base and filled P1 load, and promoted count, with the explainer', async () => {
    const { container } = renderWithProviders(
      <CapacityFillPanel
        isPending={false}
        isError={false}
        data={{
          has_active_schedule_run: true,
          schedule_run_version: 12,
          hubs: [
            { hub: 'R&D-Greece', capacity_weeks: 10, base_load_weeks: 6, filled_load_weeks: 9, promoted_count: 1 },
            { hub: 'PD-India', capacity_weeks: 20, base_load_weeks: 25.5, filled_load_weeks: 25.5, promoted_count: 0 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('capacity-fill-explainer')).toHaveTextContent(CAPACITY_FILL_EXPLAINER);
    const gr = screen.getByTestId('capacity-fill-R&D-Greece');
    expect(within(gr).getByTestId('capacity-fill-figures')).toHaveTextContent('P1 load 6 → 9 of 10 wks');
    expect(within(gr).getByTestId('capacity-fill-promoted')).toHaveTextContent('1 promoted');
    const ind = screen.getByTestId('capacity-fill-PD-India');
    expect(within(ind).getByTestId('capacity-fill-figures')).toHaveTextContent('P1 load 25.5 → 25.5 of 20 wks· over capacity');
    expect(within(ind).getByTestId('capacity-fill-promoted')).toHaveTextContent('0 promoted');
    expect(screen.getByText(/run v12/)).toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('with no active run it says capacity fill is off', () => {
    renderWithProviders(
      <CapacityFillPanel
        isPending={false}
        isError={false}
        data={{
          has_active_schedule_run: false,
          schedule_run_version: null,
          hubs: [{ hub: 'R&D-Greece', capacity_weeks: 10, base_load_weeks: 0, filled_load_weeks: 0, promoted_count: 0 }],
        }}
      />,
    );
    expect(screen.getByTestId('capacity-fill-off')).toHaveTextContent('No active schedule run — capacity fill is off');
    expect(screen.queryByTestId('capacity-fill-R&D-Greece')).not.toBeInTheDocument();
  });
});

describe('Distribution and summary agree on the promoted band (P25)', () => {
  const distribution: PriorityDistribution = {
    total_projects: 10,
    scored_projects: 10,
    band_distribution: [
      { band: 'P1', count: 4, share_pct: 40 },
      { band: 'P2', count: 3, share_pct: 30 },
      { band: 'P3', count: 2, share_pct: 20 },
      { band: 'P4', count: 1, share_pct: 10 },
      { band: 'Q', count: 0, share_pct: 0 },
      { band: 'Unscored', count: 0, share_pct: 0 },
    ],
    score_histogram: [],
    capacity_fill_count: 2,
  };

  it('the band distribution states the served capacity_fill_count inside P1', () => {
    renderWithProviders(
      <BandDistributionPanel entries={distribution.band_distribution} activeBand={null} onBandClick={() => undefined} capacityFillCount={2} />,
    );
    expect(screen.getByTestId('band-distribution-fill-note')).toHaveTextContent('P1 4, of which 2 by capacity fill.');
  });

  it('the summary shows the suggested (promoted) counts, the score-band counts and the same note', () => {
    const summary: PriorityPortfolioSummary = {
      total_projects: 10, scored_projects: 10, unscored_projects: 0, hard_gate_forced_count: 0,
      suggested_band_counts: { P1: 4, P2: 3, P3: 2, P4: 1 },
      set_priority_counts: {},
      score_band_counts: { P1: 2, P2: 5, P3: 2, P4: 1 },
      capacity_fill_count: 2,
    };
    renderWithProviders(<PortfolioSummaryPanel summary={summary} />);
    expect(screen.getByTestId('summary-suggested-P1')).toHaveTextContent('4');
    expect(screen.getByTestId('summary-score-band-P1')).toHaveTextContent('2');
    expect(screen.getByTestId('summary-fill-note')).toHaveTextContent('P1 4, of which 2 by capacity fill.');
  });
});
