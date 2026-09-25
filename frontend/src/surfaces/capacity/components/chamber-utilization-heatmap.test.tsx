import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ChamberWeekLoad, ScheduleRunSummary } from '../api/types';
import { ChamberUtilizationHeatmap } from './chamber-utilization-heatmap';

const activeRun: ScheduleRunSummary = {
  id: 'r1',
  version: 4,
  solver_type: 'greedy',
  status: 'completed',
  is_active: true,
  horizon_weeks: 34,
  current_week: 31,
  trigger_reason: null,
  created_at: '2026-08-31T09:00:00Z',
};

const chambers: ChamberWeekLoad[] = [
  {
    chamber_id: 'c1',
    code: 'GR-1',
    lab_region: 'Greece',
    max_concurrent: 2,
    week_counts: { '31': 1, '32': 2, '33': 3 },
  },
  {
    chamber_id: 'c2',
    code: 'IN-1',
    lab_region: 'India',
    max_concurrent: 3,
    week_counts: {},
  },
];

describe('ChamberUtilizationHeatmap', () => {
  it('renders one column per horizon week from the active run and the verbatim per-week count', () => {
    render(<ChamberUtilizationHeatmap chambers={chambers} activeRun={activeRun} />);
    // weeks 31..34 → 4 columnheaders + the "Chamber" corner header
    expect(screen.getAllByRole('columnheader')).toHaveLength(5);
    expect(
      screen.getByRole('cell', { name: 'GR-1, W32: 2 of 2 concurrent projects' }),
    ).toBeInTheDocument();
  });

  it('marks an over-max cell (booking gate breached) with an accessible label, not colour alone', () => {
    render(<ChamberUtilizationHeatmap chambers={chambers} activeRun={activeRun} />);
    const over = screen.getByRole('cell', { name: 'GR-1, W33: 3 of 2 concurrent projects' });
    expect(over).toHaveTextContent('3');
  });

  it('falls back to the min/max week span present in the data when no active run is known', () => {
    render(<ChamberUtilizationHeatmap chambers={chambers} activeRun={null} />);
    // data spans weeks 31..33 → 3 week columnheaders + corner
    expect(screen.getAllByRole('columnheader')).toHaveLength(4);
  });
});
