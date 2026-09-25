import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import type { ClassBreakdown } from '../api/types';
import { ClassBreakdownPanel } from './class-breakdown-panel';

vi.mock('./class-breakdown-chart', () => ({
  ClassBreakdownChart: () => <div data-testid="class-breakdown-chart" />,
}));

const withRun: ClassBreakdown = {
  has_active_schedule_run: true,
  schedule_run_version: 3,
  rows: [
    { category: 'A+', deliverable_count: 7, left_out_count: 2 },
    { category: 'A', deliverable_count: 10, left_out_count: 0 },
    { category: 'B', deliverable_count: 4, left_out_count: 5 },
    { category: 'C', deliverable_count: 1, left_out_count: 9 },
  ],
};

describe('ClassBreakdownPanel', () => {
  it('renders the per-category deliverable and left-out counts verbatim', () => {
    renderWithProviders(<ClassBreakdownPanel data={withRun} />);
    const aPlus = screen.getByRole('cell', { name: 'A+' }).closest('tr');
    expect(aPlus).not.toBeNull();
    expect(within(aPlus as HTMLElement).getByText('7')).toBeInTheDocument();
    expect(within(aPlus as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/Source: active schedule run v3/i)).toBeInTheDocument();
  });

  it('shows a non-error empty state when no schedule run is active', () => {
    renderWithProviders(
      <ClassBreakdownPanel
        data={{ has_active_schedule_run: false, schedule_run_version: null, rows: [] }}
      />,
    );
    expect(screen.getByText('No schedule computed yet')).toBeInTheDocument();
    expect(screen.queryByTestId('class-breakdown-chart')).not.toBeInTheDocument();
  });
});
