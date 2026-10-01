import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import type { CompletingWithinYear, CompletingWithinYearRow } from '../api/types';
import { CompletionProfileCard } from './completion-profile-card';

function row(
  id: string,
  overrides: Partial<CompletingWithinYearRow> = {},
): CompletingWithinYearRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'A+',
    priority: 'P1',
    within_year: false,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: null,
    ...overrides,
  };
}

const payload: CompletingWithinYear = {
  has_active_schedule_run: true,
  schedule_run_version: 3,
  within_year_count: 9,
  spillover_count: 4,
  left_out_count: 2,
  blocked_count: 1,
  rows: [
    row('w1', { within_year: true, last_step_end_week: 10 }),
    row('w2', { within_year: true, last_step_end_week: 30 }),
    row('s1', { spillover: true, last_step_end_week: 60 }),
    // Blocked wins outright over within_year (P9-F02), so this row must NOT be
    // added to the within-year series even though its within_year flag is set.
    row('b1', { blocked: true, within_year: true, last_step_end_week: 20 }),
    row('l1', { left_out: true, last_step_end_week: null }),
  ],
};

describe('CompletionProfileCard', () => {
  it('renders the four outcome totals straight from the endpoint fields', () => {
    renderWithProviders(<CompletionProfileCard data={payload} horizonWeeks={78} />);

    const totals = screen.getByText('Outcome totals').closest('div');
    expect(totals).not.toBeNull();
    const list = within(totals as HTMLElement).getByRole('list');
    expect(within(list).getByText('9')).toBeInTheDocument();
    expect(within(list).getByText('4')).toBeInTheDocument();
    expect(within(list).getByText('2')).toBeInTheDocument();
    expect(within(list).getByText('1')).toBeInTheDocument();
  });

  it('builds the week series from last_step_end_week, cumulatively, excluding blocked rows', () => {
    renderWithProviders(<CompletionProfileCard data={payload} horizonWeeks={78} />);

    const summary = screen.getByText(
      /Cumulative projects completing by week, from the active schedule run/i,
    ).parentElement;
    expect(summary).not.toBeNull();

    // By W13 only the W10 within-year project has landed.
    expect(
      within(summary as HTMLElement).getByText(/By W13: within year 1, spillover 0/),
    ).toBeInTheDocument();
    // By W39 both within-year projects have landed — the BLOCKED row at W20 is
    // excluded, exactly as `within_year_count` excludes it.
    expect(
      within(summary as HTMLElement).getByText(/By W39: within year 2, spillover 0/),
    ).toBeInTheDocument();
    // The spillover project lands at W60.
    expect(
      within(summary as HTMLElement).getByText(/By W65: within year 2, spillover 1/),
    ).toBeInTheDocument();
  });

  it('names the active run horizon rather than hard-coding one', () => {
    renderWithProviders(<CompletionProfileCard data={payload} horizonWeeks={52} />);
    expect(screen.getByText('Active run · 52-week horizon')).toBeInTheDocument();
  });

  it('carries no sample, illustrative or fabricated-trend marker — because it uses no sample data', () => {
    renderWithProviders(<CompletionProfileCard data={payload} horizonWeeks={78} />);
    expect(screen.queryByText(/sample data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/illustrative/i)).not.toBeInTheDocument();
  });

  it('degrades to an empty state when no row has a scheduled finish week', () => {
    renderWithProviders(
      <CompletionProfileCard
        data={{
          ...payload,
          rows: [row('l1', { left_out: true }), row('b1', { blocked: true })],
        }}
        horizonWeeks={78}
      />,
    );
    expect(screen.getByText('No scheduled finish weeks')).toBeInTheDocument();
    // The totals panel still renders — those counts exist independently of the chart.
    expect(screen.getByText('Outcome totals')).toBeInTheDocument();
  });
});
