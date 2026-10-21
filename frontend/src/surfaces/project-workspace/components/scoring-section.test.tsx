/** P25-T04: the Workspace score section shows the served suggested band with the same chip as the
 *  Matrix ("P1 · capacity fill" + score band), and the served reason. */
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn(() => Promise.reject(new Error('no network in this test'))), apiSend: vi.fn() };
});

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { WorkspacePriorityScore } from '../api/types';
import { ScoringSection } from './scoring-section';

const REASON = 'P1 (capacity fill): hub P1 design load 9.00 of 10.00 weeks with this project';

function score(overrides: Partial<WorkspacePriorityScore> = {}): WorkspacePriorityScore {
  return {
    strategic_project: 3, new_customer: 3, new_options: 3, regulatory_compliance: 3, quality_improvements: 3,
    rm_savings: 3, total_rm_savings: 3, gross_margins: 3, profitability: 3, annual_volume: 3,
    three_year_volume: 3, new_models: 3, capex_investment: 3, hard_gates: [],
    weighted_score: 177, normalized_pct: 60, suggested_band: 'P2', score_band: 'P2',
    capacity_fill: false, capacity_fill_reason: null,
    ...overrides,
  };
}

describe('Workspace scoring section — P25 capacity fill', () => {
  it('a promoted project shows "P1 · capacity fill", its score band and the served reason', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <ScoringSection projectId="p1" canWrite={false} score={score({ suggested_band: 'P1', capacity_fill: true, capacity_fill_reason: REASON })} />,
    );
    const band = screen.getByTestId('score-suggested-band');
    expect(within(band).getByTestId('band-chip-capacity-fill')).toHaveTextContent('P1 · capacity fill');
    expect(within(band).getByTestId('band-chip-score-band')).toHaveTextContent('score band P2');
    expect(screen.getByTestId('score-fill-reason')).toHaveTextContent(REASON);
    await user.hover(within(band).getByRole('button', { name: 'Suggested band P1 by capacity fill, score band P2' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(REASON);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('a project with no fill shows its plain band and no reason line', () => {
    renderWithProviders(<ScoringSection projectId="p1" canWrite={false} score={score()} />);
    const band = screen.getByTestId('score-suggested-band');
    expect(within(band).queryByTestId('band-chip-capacity-fill')).not.toBeInTheDocument();
    expect(within(band).getByTitle(/Priority band P2/)).toBeInTheDocument();
    expect(screen.queryByTestId('score-fill-reason')).not.toBeInTheDocument();
  });

  it('a candidate that was not promoted shows its served reason', () => {
    const stopped = 'Not promoted: hub P1 design load would be 11.00 of 10.00 weeks';
    renderWithProviders(<ScoringSection projectId="p1" canWrite={false} score={score({ capacity_fill_reason: stopped })} />);
    expect(screen.getByTestId('score-fill-reason')).toHaveTextContent(stopped);
    expect(screen.queryByTestId('band-chip-capacity-fill')).not.toBeInTheDocument();
  });
});
