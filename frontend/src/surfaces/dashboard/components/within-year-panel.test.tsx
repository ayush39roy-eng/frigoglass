import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { CompletingWithinYear } from '../api/types';
import { withinYearSharePct } from '../lib/outcome';
import { DeliveryGaugeCard } from './delivery-gauge-card';
import { WithinYearKpis } from './within-year-panel';

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

describe('WithinYearKpis', () => {
  it('shows the 52-week outcome KPIs from the endpoint payload, left out inside spillover (ADR 0024)', () => {
    renderWithProviders(<WithinYearKpis data={withRun} activeRun={undefined} />);

    expect(within(screen.getByRole('group', { name: 'Within year' })).getByText('9')).toBeInTheDocument();
    // Spillover past W52 = served spillover_count 4 + served left_out_count 2.
    const spill = screen.getByRole('group', { name: 'Spillover (past W52)' });
    expect(within(spill).getByText('6')).toBeInTheDocument();
    expect(spill).toHaveTextContent('Not done by W52 → 2027 · 2 not yet placed');
    // No separate "left out / beyond the 78-week horizon" tile any more.
    expect(screen.queryByRole('group', { name: 'Left out' })).not.toBeInTheDocument();
    expect(screen.queryByText(/78-week/)).not.toBeInTheDocument();
    // ADR 0017 + P17-R07: the `blocked_count` tile reads "On Hold at a stage",
    // never a bare "On Hold" (that word is also a project status).
    expect(within(screen.getByRole('group', { name: 'On Hold at a stage' })).getByText('1')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'On Hold' })).not.toBeInTheDocument();
    expect(screen.getByText('In the plan, waiting at a stage')).toBeInTheDocument();

    // Three mutually exclusive figures that still sum to the run (9 + 6 + 1 = 16).
    const values = ['Within year', 'Spillover (past W52)', 'On Hold at a stage'].map(
      (label) => within(screen.getByRole('group', { name: label })).getByText(/^\d+$/).textContent,
    );
    expect(values).toEqual(['9', '6', '1']);
  });

  it('prints the same within-year share as the delivery gauge (one formula, one source)', () => {
    renderWithProviders(
      <>
        <WithinYearKpis data={withRun} activeRun={undefined} />
        <DeliveryGaugeCard data={withRun} />
      </>,
    );
    // 9 / (9 + 4 + 2 + 1) = 56.25% → 56% on both.
    expect(withinYearSharePct(withRun)).toBe(56);
    expect(within(screen.getByRole('group', { name: 'Within year' })).getByText('56% of run')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '56% delivered within the year' })).toBeInTheDocument();
  });

  it('states the source run and I9 in visible copy', () => {
    renderWithProviders(<WithinYearKpis data={withRun} activeRun={undefined} />);
    expect(screen.getByTestId('schedule-run-provenance')).toHaveTextContent(/v3/);
    expect(screen.getAllByText(/Run v3/i).length).toBeGreaterThan(0);
  });

  it('renders a non-error empty state when no schedule run is active', () => {
    renderWithProviders(
      <WithinYearKpis
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

  it('adds a muted line quoting the served project-status On Hold count (P17-R07)', () => {
    renderWithProviders(<WithinYearKpis data={withRun} activeRun={undefined} onHold={15} />);
    const tile = screen.getByRole('group', { name: 'On Hold at a stage' });
    // The tile's own figure is still the served blocked_count; 15 is only quoted.
    expect(within(tile).getByText(/^\d+$/).textContent).toBe('1');
    expect(within(tile).getByTestId('paused-projects-note')).toHaveTextContent(
      'Separately, 15 projects are paused (status On Hold) and are not in the plan.',
    );
  });

  it('uses the singular for one paused project', () => {
    renderWithProviders(<WithinYearKpis data={withRun} activeRun={undefined} onHold={1} />);
    expect(screen.getByTestId('paused-projects-note')).toHaveTextContent(
      'Separately, 1 project is paused (status On Hold) and is not in the plan.',
    );
  });

  it('omits the paused line when the status overview is not loaded or the count is 0', () => {
    const { unmount } = renderWithProviders(<WithinYearKpis data={withRun} activeRun={undefined} />);
    expect(screen.queryByTestId('paused-projects-note')).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<WithinYearKpis data={withRun} activeRun={undefined} onHold={0} />);
    expect(screen.queryByTestId('paused-projects-note')).not.toBeInTheDocument();
  });

  it('the outcome info popover names the "On Hold (project)" status card', async () => {
    renderWithProviders(<WithinYearKpis data={withRun} activeRun={undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'How the count is defined' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('On Hold at a stage');
    expect(dialog).toHaveTextContent('On Hold (project)');
    expect(dialog).toHaveTextContent(/paused \(status On Hold\)/);
  });

  it('does not render a per-project outcome table (P17-R06)', () => {
    renderWithProviders(<WithinYearKpis data={withRun} activeRun={undefined} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Project outcomes')).not.toBeInTheDocument();
  });
});
