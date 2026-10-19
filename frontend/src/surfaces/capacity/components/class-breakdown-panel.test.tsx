import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { ClassBreakdown } from '../api/types';
import { classRow } from '../test-fixtures';
import { ClassBreakdownPanel } from './class-breakdown-panel';

vi.mock('./class-breakdown-chart', () => ({
  ClassBreakdownChart: () => <div data-testid="class-breakdown-chart" />,
}));

const withRun: ClassBreakdown = {
  has_active_schedule_run: true,
  schedule_run_version: 3,
  rows: [
    classRow({ category: 'A+', deliverable_count: 7, left_out_count: 2, total_count: 9 }),
    classRow({ category: 'A', deliverable_count: 10, left_out_count: 0, total_count: 10 }),
    classRow({ category: 'B', deliverable_count: 4, left_out_count: 5, total_count: 9 }),
    classRow({ category: 'C', deliverable_count: 1, left_out_count: 9, total_count: 10 }),
  ],
};

describe('ClassBreakdownPanel', () => {
  it('renders the per-category deliverable and left-out counts verbatim', () => {
    renderWithProviders(<ClassBreakdownPanel data={withRun} />);
    const aPlus = screen.getByRole('region', { name: /Class A\+/ });
    expect(within(aPlus).getByTestId('class-A+-deliverable')).toHaveTextContent('7');
    expect(within(aPlus).getByTestId('class-A+-left-out')).toHaveTextContent('2');
    // The run version stays visible on the card as a chip, not as a sentence.
    expect(screen.getByText('Run v3')).toBeInTheDocument();
  });

  it('P13-T11: each class card shows the served total, priority split and per-hub ✓/✗ counts', () => {
    renderWithProviders(
      <ClassBreakdownPanel data={{ has_active_schedule_run: true, schedule_run_version: 3, rows: [classRow()] }} />,
    );
    const card = screen.getByTestId('class-card-B');
    // Only the non-zero buckets, as served.
    expect(within(card).getByLabelText('Deliverable by priority')).toHaveTextContent('(P1: 32, Q: 5)');
    expect(within(card).getByLabelText('Left out by priority')).toHaveTextContent('(P1: 87, P2: 1, Q: 37)');
    const india = within(card).getByTestId('class-B-hub-PD-India');
    expect(india).toHaveTextContent('Deliverable 21');
    expect(india).toHaveTextContent('Left out 120');
    // The served total_count, verbatim.
    expect(within(card).getByTestId('class-B-total')).toHaveTextContent('Total: 162');
  });

  it('keeps the deliverable / left-out definitions and the run source reachable in the card header', async () => {
    // Text cleanup 2026-10-01: this prose moved out of a loose paragraph under
    // the card title and into a keyboard-reachable popover. Same words.
    const user = userEvent.setup();
    renderWithProviders(<ClassBreakdownPanel data={withRun} />);

    await user.click(
      screen.getByRole('button', { name: 'How deliverable and left out are defined' }),
    );

    // ADR 0024: framed on the 52-week year, never "the 78-week horizon".
    expect(screen.getByText(/not placed yet, so not done by W52/i)).toBeInTheDocument();
    expect(screen.queryByText(/78-week/i)).not.toBeInTheDocument();
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
