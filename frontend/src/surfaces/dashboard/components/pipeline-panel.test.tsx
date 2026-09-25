import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { CompletingWithinYear, PipelineTotals } from '../api/types';
import { PipelinePanel } from './pipeline-panel';

const totals: PipelineTotals = { spillover_count: 30, new_count: 206, total_count: 236 };

describe('PipelinePanel', () => {
  it('keeps pipeline "spillover" (carry-over) separate from the schedule SPILLOVER outcome', () => {
    const withinYear: CompletingWithinYear = {
      has_active_schedule_run: true,
      schedule_run_version: 2,
      within_year_count: 9,
      spillover_count: 4,
      left_out_count: 2,
      rows: [],
    };
    render(<PipelinePanel totals={totals} withinYear={withinYear} />);

    // composition section labels carry-over explicitly, not "spillover"
    expect(screen.getByText('Carried over')).toBeInTheDocument();
    expect(screen.getByText('Newly registered')).toBeInTheDocument();
    // schedule-outcome section cites the run + I9
    expect(screen.getByText(/active schedule run v2/i)).toBeInTheDocument();
    expect(screen.getByText(/Invariant I9/i)).toBeInTheDocument();
    expect(screen.getByText('Completing within year')).toBeInTheDocument();
  });

  it('degrades to composition-only when no schedule run is active', () => {
    render(
      <PipelinePanel
        totals={totals}
        withinYear={{
          has_active_schedule_run: false,
          schedule_run_version: null,
          within_year_count: 0,
          spillover_count: 0,
          left_out_count: 0,
          rows: [],
        }}
      />,
    );
    expect(screen.getByText(/No active schedule run/i)).toBeInTheDocument();
  });
});
