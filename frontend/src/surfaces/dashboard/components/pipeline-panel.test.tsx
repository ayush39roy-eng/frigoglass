import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { CompletingWithinYear } from '../api/types';
import { PipelinePanel } from './pipeline-panel';

describe('PipelinePanel (schedule-run outcome only)', () => {
  it('shows the schedule outcome and carries no composition figures', () => {
    const withinYear: CompletingWithinYear = {
      has_active_schedule_run: true,
      schedule_run_version: 2,
      within_year_count: 9,
      spillover_count: 4,
      left_out_count: 2,
      blocked_count: 1,
      priority_delivery: [],
      rows: [],
    };
    render(<PipelinePanel withinYear={withinYear} />);

    expect(screen.getByText('Completion outcome')).toBeInTheDocument();
    expect(screen.getByText(/active schedule run v2/i)).toBeInTheDocument();
    expect(screen.getByText(/Invariant I9/i)).toBeInTheDocument();
    expect(screen.getByText('Completing within year')).toBeInTheDocument();
    // composition spillover lives in the pipeline row, not here
    expect(screen.queryByText('Carried over')).not.toBeInTheDocument();
    expect(screen.queryByText('Newly registered')).not.toBeInTheDocument();
  });

  it('degrades gracefully when no schedule run is active', () => {
    render(
      <PipelinePanel
        withinYear={{
          has_active_schedule_run: false,
          schedule_run_version: null,
          within_year_count: 0,
          spillover_count: 0,
          left_out_count: 0,
          blocked_count: 0,
          priority_delivery: [],
          rows: [],
        }}
      />,
    );
    expect(screen.getByText(/No active schedule run/i)).toBeInTheDocument();
  });

  it('shows a loading line while the schedule-run figures are pending', () => {
    render(<PipelinePanel withinYear={null} />);
    expect(screen.getByText(/Loading completion figures/i)).toBeInTheDocument();
  });
});
