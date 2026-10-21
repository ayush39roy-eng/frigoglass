import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

// P4-T09 (qa-inspector): the per-project outcome table (`VirtualDataTable`) never
// renders any row in jsdom without a real scroll container size, so every column's
// `cell` render function — including every `OutcomeCell` outcome-flag branch — was
// previously untested (27% stmts / 11% functions on this file). Same mock pattern as
// `virtual-data-table.test.tsx`: make the virtualizer report every row as "visible".
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 40, size: 40 })),
    measureElement: () => undefined,
  }),
}));

import { renderWithProviders } from '@/test/render';
import type { CompletingWithinYear, CompletingWithinYearRow } from '../api/types';
import { withinYearSharePct } from '../lib/outcome';
import { DeliveryGaugeCard } from './delivery-gauge-card';
import { WithinYearPanel } from './within-year-panel';

const withRun: CompletingWithinYear = {
  has_active_schedule_run: true,
  schedule_run_version: 3,
  within_year_count: 9,
  spillover_count: 4,
  left_out_count: 2,
  blocked_count: 1,
  priority_delivery: [],
  rows: [
    {
      project_id: 'p1',
      project_name: 'Alpha cooler refresh',
      hub: 'R&D-Greece',
      category: 'A+',
      priority: 'P1',
      within_year: true,
      spillover: false,
      left_out: false,
      blocked: false,
      cat_not_allowed: false,
      last_step_end_week: 40,
      type: null,
      status: 'In Development',
      not_started: false,
    },
  ],
};

describe('WithinYearPanel', () => {
  it('shows the 52-week outcome KPIs from the endpoint payload, left out inside spillover (ADR 0024)', () => {
    renderWithProviders(<WithinYearPanel data={withRun} activeRun={undefined} />);

    expect(within(screen.getByRole('group', { name: 'Within year' })).getByText('9')).toBeInTheDocument();
    // Spillover past W52 = served spillover_count 4 + served left_out_count 2.
    const spill = screen.getByRole('group', { name: 'Spillover (past W52)' });
    expect(within(spill).getByText('6')).toBeInTheDocument();
    expect(spill).toHaveTextContent('Not done by W52 → 2027 · 2 not yet placed');
    // No separate "left out / beyond the 78-week horizon" tile any more.
    expect(screen.queryByRole('group', { name: 'Left out' })).not.toBeInTheDocument();
    expect(screen.queryByText(/78-week/)).not.toBeInTheDocument();
    // ADR 0017: the `blocked_count` tile reads "On Hold".
    expect(within(screen.getByRole('group', { name: 'On Hold' })).getByText('1')).toBeInTheDocument();
    expect(screen.getByText('In the plan, waiting at a stage')).toBeInTheDocument();

    // Three mutually exclusive figures that still sum to the run (9 + 6 + 1 = 16).
    const values = ['Within year', 'Spillover (past W52)', 'On Hold'].map(
      (label) => within(screen.getByRole('group', { name: label })).getByText(/^\d+$/).textContent,
    );
    expect(values).toEqual(['9', '6', '1']);
  });

  it('prints the same within-year share as the delivery gauge (one formula, one source)', () => {
    renderWithProviders(
      <>
        <WithinYearPanel data={withRun} activeRun={undefined} />
        <DeliveryGaugeCard data={withRun} />
      </>,
    );
    // 9 / (9 + 4 + 2 + 1) = 56.25% → 56% on both.
    expect(withinYearSharePct(withRun)).toBe(56);
    expect(within(screen.getByRole('group', { name: 'Within year' })).getByText('56% of run')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '56% delivered within the year' })).toBeInTheDocument();
  });

  it('states the source run and I9 in visible copy', () => {
    renderWithProviders(<WithinYearPanel data={withRun} activeRun={undefined} />);
    expect(screen.getByTestId('schedule-run-provenance')).toHaveTextContent(/v3/);
    expect(screen.getAllByText(/Run v3/i).length).toBeGreaterThan(0);
  });

  it('renders a non-error empty state when no schedule run is active', () => {
    renderWithProviders(
      <WithinYearPanel
        data={{
          has_active_schedule_run: false,
          schedule_run_version: null,
          within_year_count: 0,
          spillover_count: 0,
          left_out_count: 0,
          blocked_count: 0,
          priority_delivery: [],
          rows: [],
        }}
        activeRun={null}
      />,
    );
    expect(screen.getByText('No schedule computed yet')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-run-provenance')).not.toBeInTheDocument();
  });

  it('renders the run-scoped empty state when the active run has zero project outcomes', () => {
    renderWithProviders(
      <WithinYearPanel
        data={{
          has_active_schedule_run: true,
          schedule_run_version: 7,
          within_year_count: 0,
          spillover_count: 0,
          left_out_count: 0,
          blocked_count: 0,
          priority_delivery: [],
          rows: [],
        }}
        activeRun={undefined}
      />,
    );
    expect(screen.getByText('No projects in this run')).toBeInTheDocument();
  });

  it('renders every per-project outcome flag verbatim from the row (I9 — no client recompute)', () => {
    const rows: CompletingWithinYearRow[] = [
      {
        project_id: 'p-within',
        project_name: 'Within-year project',
        hub: 'R&D-Greece',
        category: 'A+',
        priority: 'P1',
        within_year: true,
        spillover: false,
        left_out: false,
        blocked: false,
        cat_not_allowed: false,
        last_step_end_week: 40,
        type: null,
        status: 'In Development',
        not_started: false,
      },
      {
        project_id: 'p-spillover',
        project_name: 'Spillover project',
        hub: 'PD-Romania',
        category: null,
        priority: null,
        within_year: false,
        spillover: true,
        left_out: false,
        blocked: false,
        cat_not_allowed: true,
        last_step_end_week: 60,
        type: null,
        status: 'In Development',
        not_started: false,
      },
      {
        project_id: 'p-leftout',
        project_name: 'Left-out project',
        hub: 'OEM-HCK',
        category: 'B',
        priority: 'Q',
        within_year: false,
        spillover: false,
        left_out: true,
        blocked: false,
        cat_not_allowed: false,
        last_step_end_week: null,
        type: null,
        status: 'In Development',
        not_started: false,
      },
      {
        project_id: 'p-blocked',
        project_name: 'Blocked project',
        hub: 'PD-India',
        category: 'A',
        priority: 'P2',
        within_year: false,
        spillover: false,
        left_out: false,
        blocked: true,
        cat_not_allowed: false,
        last_step_end_week: null,
        type: null,
        status: 'In Development',
        not_started: false,
      },
    ];
    renderWithProviders(
      <WithinYearPanel
        data={{
          has_active_schedule_run: true,
          schedule_run_version: 3,
          within_year_count: 1,
          spillover_count: 1,
          left_out_count: 1,
          blocked_count: 1,
          priority_delivery: [],
          rows,
        }}
        activeRun={undefined}
      />,
    );

    const table = screen.getByRole('table', { name: 'Per-project outcome from the active schedule run' });
    expect(within(table).getByText('Within-year project')).toBeInTheDocument();
    expect(within(table).getByText('Within year')).toBeInTheDocument();
    expect(within(table).getByText('Blocked project')).toBeInTheDocument();
    expect(within(table).getByText('On Hold')).toBeInTheDocument();

    expect(within(table).getByText('Spillover project')).toBeInTheDocument();
    // null category/priority render the "—" placeholder, not a blank cell.
    expect(within(table).getAllByText('—').length).toBeGreaterThanOrEqual(2);

    expect(within(table).getByText('Left-out project')).toBeInTheDocument();
    expect(within(table).getByText('A+')).toBeInTheDocument();
    expect(within(table).getByText('B')).toBeInTheDocument();
  });
});
