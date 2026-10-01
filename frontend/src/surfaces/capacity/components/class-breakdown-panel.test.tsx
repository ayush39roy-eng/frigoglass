import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
    // The run version stays visible on the card as a chip, not as a sentence.
    expect(screen.getByText('Run v3')).toBeInTheDocument();
  });

  it('keeps the deliverable / left-out definitions and the run source reachable in the card header', async () => {
    // Text cleanup 2026-10-01: this prose moved out of a loose paragraph under
    // the card title and into a keyboard-reachable popover. Same words.
    const user = userEvent.setup();
    renderWithProviders(<ClassBreakdownPanel data={withRun} />);

    await user.click(
      screen.getByRole('button', { name: 'How deliverable and left out are defined' }),
    );

    expect(screen.getByText(/no feasible window before the/i)).toBeInTheDocument();
    expect(screen.getByText(/Source: active schedule run/i)).toHaveTextContent(/v3/);
    expect(screen.getByText(/Not recomputed in the browser/i)).toBeInTheDocument();
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
