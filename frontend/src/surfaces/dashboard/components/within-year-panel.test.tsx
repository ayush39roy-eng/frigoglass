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
import { WithinYearPanel } from './within-year-panel';

const withRun: CompletingWithinYear = {
  has_active_schedule_run: true,
  schedule_run_version: 3,
  within_year_count: 9,
  spillover_count: 4,
  left_out_count: 2,
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
      cat_not_allowed: false,
      last_step_end_week: 40,
    },
  ],
};

describe('WithinYearPanel', () => {
  it('shows the three schedule-outcome KPIs straight from the endpoint payload', () => {
    renderWithProviders(<WithinYearPanel data={withRun} activeRun={undefined} />);

    expect(within(screen.getByRole('group', { name: 'Within year' })).getByText('9')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Spillover' })).getByText('4')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Left out' })).getByText('2')).toBeInTheDocument();
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
        cat_not_allowed: false,
        last_step_end_week: 40,
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
        cat_not_allowed: true,
        last_step_end_week: 60,
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
        cat_not_allowed: false,
        last_step_end_week: null,
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
          rows,
        }}
        activeRun={undefined}
      />,
    );

    const table = screen.getByRole('table', { name: 'Per-project outcome from the active schedule run' });
    expect(within(table).getByText('Within-year project')).toBeInTheDocument();
    expect(within(table).getByText('Within year')).toBeInTheDocument();

    expect(within(table).getByText('Spillover project')).toBeInTheDocument();
    // null category/priority render the "—" placeholder, not a blank cell.
    expect(within(table).getAllByText('—').length).toBeGreaterThanOrEqual(2);

    expect(within(table).getByText('Left-out project')).toBeInTheDocument();
    expect(within(table).getByText('A+')).toBeInTheDocument();
    expect(within(table).getByText('B')).toBeInTheDocument();
  });
});
