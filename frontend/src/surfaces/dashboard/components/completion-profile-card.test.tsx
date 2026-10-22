import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
    status: 'In Development',
    not_started: false,
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
  priority_delivery: [],
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
  it('counts within-year finishes per calendar month, each month on its own, excluding blocked rows', () => {
    renderWithProviders(<CompletionProfileCard data={payload} />);

    const months = screen.getByRole('list', { name: 'Within-year projects completed per month' });
    expect(within(months).getAllByRole('listitem')).toHaveLength(12);
    // W10 (Thursday 5 Mar 2026) and W30 (Thursday 23 Jul 2026).
    expect(within(months).getByRole('button', { name: 'March: 1' })).toBeEnabled();
    expect(within(months).getByRole('button', { name: 'July: 1' })).toBeEnabled();
    // The blocked row at W20 (May) is not a within-year finish.
    expect(within(months).getByRole('button', { name: 'May: 0' })).toBeDisabled();
    // Not cumulative: August repeats nothing from July.
    expect(within(months).getByRole('button', { name: 'August: 0' })).toBeDisabled();
  });

  it('opens a month into its weeks and the projects finishing in it, and narrows to a week', async () => {
    const user = userEvent.setup();
    const data: CompletingWithinYear = {
      ...payload,
      rows: [
        ...payload.rows,
        row('w3', { within_year: true, last_step_end_week: 11, hub: 'PD-India', priority: 'P2' }),
      ],
    };
    renderWithProviders(<CompletionProfileCard data={data} />);

    await user.click(screen.getByRole('button', { name: 'March: 2' }));
    expect(screen.getByRole('heading', { name: /March 2026/ })).toBeInTheDocument();
    // March 2026 holds the ISO weeks whose Thursday is in March: W10–W13
    // (W14's Thursday is 2 April).
    const weeks = screen.getByRole('list', { name: 'Within-year projects completed per week in March' });
    expect(within(weeks).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'W10: 1',
      'W11: 1',
      'W12: 0',
      'W13: 0',
    ]);
    const projects = screen.getByRole('list', { name: 'Projects completing in March' });
    expect(within(projects).getByRole('link', { name: 'Project w1' })).toHaveAttribute('href', '/projects/w1');
    expect(within(projects).getByRole('link', { name: 'Project w3' })).toBeInTheDocument();

    await user.click(within(weeks).getByRole('button', { name: 'W11: 1' }));
    const narrowed = screen.getByRole('list', { name: 'Projects completing in W11' });
    expect(within(narrowed).getAllByRole('listitem')).toHaveLength(1);
    expect(within(narrowed).getByRole('link', { name: 'Project w3' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All months' }));
    expect(screen.getByRole('list', { name: 'Within-year projects completed per month' })).toBeInTheDocument();
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
    expect(screen.queryByTestId('completion-profile-monthly')).not.toBeInTheDocument();
  });
});
