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
    type: null,
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
  it('renders the three 52-week outcome totals from the endpoint fields (left out inside spillover)', () => {
    renderWithProviders(<CompletionProfileCard data={payload} />);

    const totals = screen.getByText('Outcome totals').closest('div');
    expect(totals).not.toBeNull();
    const list = within(totals as HTMLElement).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('9')).toBeInTheDocument();
    // ADR 0024: spillover past W52 = served spillover_count 4 + left_out_count 2.
    expect(within(list).getByText('Spillover (past W52)')).toBeInTheDocument();
    expect(within(list).getByText('6')).toBeInTheDocument();
    expect(within(list).getByText('1')).toBeInTheDocument();
    expect(within(list).queryByText(/left out/i)).not.toBeInTheDocument();
  });

  it('builds the within-year series over W1–W52 only, cumulatively, excluding blocked rows', () => {
    renderWithProviders(<CompletionProfileCard data={payload} />);

    const summary = screen.getByText(
      /Cumulative within-year projects completing by week, from the active schedule run/i,
    ).parentElement;
    expect(summary).not.toBeNull();

    // By W13 only the W10 within-year project has landed.
    expect(within(summary as HTMLElement).getByText(/By W13: within year 1$/)).toBeInTheDocument();
    // By W39 both within-year projects have landed — the BLOCKED row at W20 is
    // excluded, exactly as `within_year_count` excludes it.
    expect(within(summary as HTMLElement).getByText(/By W39: within year 2$/)).toBeInTheDocument();
    // The axis ends at W52 (ADR 0024) — the W60 spillover finish is not plotted;
    // it is summarised as spillover past W52 (4 spillover + 2 left out).
    expect(
      within(summary as HTMLElement).getByText(/End of year W52: within year 2; spillover past W52: 6/),
    ).toBeInTheDocument();
    expect((summary as HTMLElement).textContent).not.toMatch(/W6[0-9]|W78/);
  });

  it('names the 52-week plan year, never the 78-week search horizon', () => {
    renderWithProviders(<CompletionProfileCard data={payload} />);
    expect(screen.getByText('Active run · 52-week year')).toBeInTheDocument();
    expect(screen.queryByText(/78/)).not.toBeInTheDocument();
  });

  it('carries no sample, illustrative or fabricated-trend marker — because it uses no sample data', () => {
    renderWithProviders(<CompletionProfileCard data={payload} />);
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
       
      />,
    );
    expect(screen.getByText('No finishes by W52')).toBeInTheDocument();
    // The totals panel still renders — those counts exist independently of the chart.
    expect(screen.getByText('Outcome totals')).toBeInTheDocument();
  });
});
