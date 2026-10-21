import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { change, estimateFixture, INDIA_SCOPE, simulateFixture, solveFixture } from '../test-fixtures';
import { EstimateView } from './estimate-view';
import { SimulateView } from './simulate-view';
import { SolveView } from './solve-view';

describe('EstimateView', () => {
  it('shows the served totals, per-hub booked % with statuses and the needs line', async () => {
    const { container } = renderWithProviders(<EstimateView data={estimateFixture()} />);
    expect(screen.getByTestId('est-design-weeks')).toHaveTextContent('180');
    expect(screen.getByTestId('est-lab-weeks')).toHaveTextContent('100');
    expect(screen.getByTestId('est-designers')).toHaveTextContent('3 more');
    expect(screen.getByTestId('est-chambers')).toHaveTextContent('1 more');

    const row = screen.getByTestId('est-design-row');
    expect(row).toHaveTextContent('PD-India');
    expect(row).toHaveTextContent('68.18 %');
    expect(row).toHaveTextContent('170.45 %');
    expect(within(row).getByText('Available')).toBeInTheDocument();
    expect(within(row).getByText('Full')).toBeInTheDocument();
    expect(row).toHaveTextContent('need 3 more designers');
    expect(screen.getByTestId('est-lab-row')).toHaveTextContent('need 1 more chamber');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('keeps the arithmetic behind an expandable "How this was calculated"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateView data={estimateFixture()} />);
    const details = screen.getByTestId('whatif-workings') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await user.click(screen.getByText('How this was calculated'));
    expect(details.open).toBe(true);
    expect(within(details).getByText('Design PD-India: 10 x 18 = 180 extra weeks')).toBeInTheDocument();
  });

  it('says so when a unit adds no capacity, and renders a null booked % as a dash', () => {
    const e = estimateFixture();
    const d0 = e.design[0];
    if (!d0) throw new Error('fixture');
    renderWithProviders(
      <EstimateView
        data={{ ...e, design: [{ ...d0, reachable: false, booked_pct_before: null, status_before: 'full' }], lab: [] }}
      />,
    );
    expect(screen.getByText('A designer adds no capacity here')).toBeInTheDocument();
    expect(screen.getByTestId('est-design-row')).toHaveTextContent('—');
    expect(screen.getByText('No lab region is affected by this scenario.')).toBeInTheDocument();
  });

  it('labels the totals as needed for the touched hubs and regions and lists them', () => {
    renderWithProviders(<EstimateView data={estimateFixture()} />);
    const t = screen.getByTestId('est-touched');
    expect(t).toHaveTextContent('Needed for the hubs and regions this scenario touches:');
    expect(screen.getByTestId('est-touched-list')).toHaveTextContent('Hubs: PD-India. Lab regions: India.');
  });

  it('lists touched rows first and marks them; untouched rows keep their own deficit', () => {
    const e = estimateFixture({ touched_hubs: ['R&D-India'], touched_lab_regions: ['Romania'] });
    const base = e.design[0];
    const lab0 = e.lab[0];
    if (!base || !lab0) throw new Error('fixture');
    const mk = (hub: string, more: number) => ({ ...base, hub, min_extra_designers: more });
    const mkLab = (lab_region: string, more: number) => ({ ...lab0, lab_region, min_extra_chambers: more });
    renderWithProviders(
      <EstimateView
        data={{
          ...e,
          design: [mk('OEM-HCK', 2), mk('PD-India', 1), mk('R&D-India', 0)],
          lab: [mkLab('Greece', 0), mkLab('India', 4), mkLab('Romania', 1)],
        }}
      />,
    );
    const design = screen.getAllByTestId('est-design-row');
    expect(design.map((r) => r.getAttribute('data-touched'))).toEqual(['true', 'false', 'false']);
    expect(design[0]).toHaveTextContent('R&D-India');
    expect(within(design[0] as HTMLElement).getByTestId('est-touched-mark')).toHaveTextContent('Changed by scenario');
    // untouched rows keep their per-row deficit
    expect(design[1]).toHaveTextContent('OEM-HCK');
    expect(design[1]).toHaveTextContent('need 2 more designers');
    const lab = screen.getAllByTestId('est-lab-row');
    expect(lab[0]).toHaveTextContent('Romania');
    expect(lab[0]).toHaveAttribute('data-touched', 'true');
    expect(lab[2]).toHaveTextContent('need 4 more chambers');
    expect(screen.getAllByTestId('est-touched-mark')).toHaveLength(2);
  });

  it('shows 0 and a neutral line for the zero scenario, rows with deficits stay visible', () => {
    const e = estimateFixture({
      touched_hubs: [],
      touched_lab_regions: [],
      extra_design_weeks_total: 0,
      extra_lab_weeks_total: 0,
      min_extra_designers_total: 0,
      min_extra_chambers_total: 0,
    });
    renderWithProviders(<EstimateView data={e} />);
    expect(screen.getByTestId('est-designers')).toHaveTextContent('0 more');
    expect(screen.getByTestId('est-chambers')).toHaveTextContent('0 more');
    expect(screen.getByTestId('est-touched-none')).toHaveTextContent('This scenario changes nothing');
    expect(screen.queryByTestId('est-touched-mark')).not.toBeInTheDocument();
    expect(screen.getByTestId('est-design-row')).toHaveTextContent('need 3 more designers');
  });

  it('renders a hub-planner scoped response without re-scoping and says what it covers', () => {
    renderWithProviders(<EstimateView data={estimateFixture({ scope: INDIA_SCOPE })} />);
    expect(screen.getByTestId('whatif-scope')).toHaveTextContent('Showing your hubs only (PD-India)');
    expect(screen.getByTestId('whatif-scope')).toHaveTextContent('include load from every hub');
    expect(screen.getAllByTestId('est-design-row')).toHaveLength(1);
  });
});

describe('SimulateView', () => {
  it('shows the within-year delta, diff lists, new projects and utilization as served', async () => {
    const { container } = renderWithProviders(<SimulateView data={simulateFixture()} />);
    expect(screen.getByTestId('sim-within-year')).toHaveTextContent('120 → 117');
    expect(screen.getByTestId('sim-within-year')).toHaveTextContent('Change -3');
    expect(screen.getByTestId('sim-new')).toHaveTextContent('0 of 1');
    expect(within(screen.getByTestId('sim-slipping')).getAllByTestId('whatif-row')).toHaveLength(3);
    expect(within(screen.getByTestId('sim-recovered')).getAllByTestId('whatif-row')).toHaveLength(1);
    expect(within(screen.getByTestId('sim-moved')).getByText('No other existing project changes its finish week.')).toBeInTheDocument();
    expect(within(screen.getByTestId('sim-new-projects')).getByText('What-if project 1')).toBeInTheDocument();
    const hub = within(screen.getByTestId('sim-util-hubs')).getByTestId('whatif-util-row');
    expect(hub).toHaveTextContent('60 %');
    expect(hub).toHaveTextContent('92 %');
    expect(within(screen.getByTestId('sim-util-regions')).getByTestId('whatif-util-row')).toHaveTextContent('105 %');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('uses diff.within_year_* as the headline (not outcome_counts), 107 -> 107 style', () => {
    const d = simulateFixture();
    renderWithProviders(
      <SimulateView
        data={{
          ...d,
          outcome_counts_before: { ...d.outcome_counts_before, within_year: 90 },
          outcome_counts_after: { ...d.outcome_counts_after, within_year: 90 },
          diff: { ...d.diff, within_year_before: 107, within_year_after: 107, within_year_delta: 0 },
        }}
      />,
    );
    expect(screen.getByTestId('sim-within-year')).toHaveTextContent('107 → 107');
    expect(screen.getByTestId('sim-within-year')).toHaveTextContent('Change 0');
    expect(screen.getByTestId('sim-within-year')).not.toHaveTextContent('90');
    expect(screen.getByTestId('sim-outcomes-note')).toHaveTextContent('outcome class');
  });

  it('virtualizes a change list over 100 rows', () => {
    const many = Array.from({ length: 250 }, (_, i) => change(`p${String(i)}`, 'newly_slipping'));
    const data = simulateFixture();
    renderWithProviders(<SimulateView data={{ ...data, diff: { ...data.diff, newly_slipping: many } }} />);
    const rows = within(screen.getByTestId('sim-slipping')).getAllByTestId('whatif-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(screen.getByText('(250)')).toBeInTheDocument();
  });
});

describe('SolveView', () => {
  it('shows the additions and an exact, uncapped, met result', () => {
    renderWithProviders(<SolveView data={solveFixture()} />);
    expect(screen.getByTestId('solve-designers')).toHaveTextContent('2');
    expect(screen.getByTestId('solve-designers')).toHaveTextContent('2 in PD-India');
    expect(screen.getByTestId('solve-chambers')).toHaveTextContent('1 in India');
    expect(screen.getByTestId('solve-total')).toHaveTextContent('3');
    expect(screen.getByTestId('solve-outcome')).toHaveTextContent('Target met');
    expect(screen.getByTestId('solve-exact')).toHaveTextContent('Proven minimum');
    expect(screen.getByTestId('solve-capped')).toHaveTextContent('finished within its run limit');
    expect(screen.getByTestId('solve-runs')).toHaveTextContent('Used 14 of 60 scheduler runs');
    expect(screen.queryByTestId('solve-unattainable')).not.toBeInTheDocument();
  });

  it('reports a capped, not-proven search honestly', () => {
    renderWithProviders(<SolveView data={solveFixture({ capped: true, exact: false, runs_used: 60 })} />);
    expect(screen.getByTestId('solve-exact')).toHaveTextContent('Smallest found (assumes more capacity never hurts)');
    expect(screen.getByTestId('solve-capped')).toHaveTextContent('Search stopped at its run limit');
    expect(screen.getByTestId('solve-runs')).toHaveTextContent('Used 60 of 60');
    expect(screen.getByText(/might exist/)).toBeInTheDocument();
  });

  it('words exact only as Proven minimum; otherwise Smallest found with the server sentence', () => {
    const { unmount } = renderWithProviders(<SolveView data={solveFixture({ exact: true })} />);
    expect(screen.getByTestId('solve-exact')).toHaveTextContent('Proven minimum');
    expect(screen.queryByTestId('solve-not-proven')).not.toBeInTheDocument();
    unmount();
    renderWithProviders(
      <SolveView data={solveFixture({ exact: false, capped: false, semantics: 'SERVER: smallest found, assuming more capacity never hurts.' })} />,
    );
    expect(screen.getByTestId('solve-exact')).toHaveTextContent('Smallest found (assumes more capacity never hurts)');
    expect(screen.getByTestId('solve-exact')).not.toHaveTextContent('Proven');
    expect(screen.getByTestId('solve-not-proven')).toHaveTextContent('a smaller one may exist');
    expect(screen.getByTestId('solve-semantics')).toHaveTextContent('SERVER: smallest found');
  });

  it('shows unattainable projects prominently, with the server sentence, and met_attainable as a calm outcome', async () => {
    const data = solveFixture({
      met: false,
      met_attainable: true,
      unattainable_project_ids: ['whatif-p001-001'],
      unattainable_projects: [
        { project_id: 'whatif-p001-001', name: 'What-if project 1', hub: 'PD-India', category: 'A', unconstrained_end_week: 60 },
      ],
      semantics: 'SERVER SENTENCE about unattainable projects.',
    });
    const { container } = renderWithProviders(<SolveView data={data} />);
    const box = screen.getByTestId('solve-unattainable');
    expect(box).toHaveTextContent('Cannot finish within the year whatever you add (critical path too long)');
    expect(within(box).getByTestId('solve-semantics')).toHaveTextContent('SERVER SENTENCE about unattainable projects.');
    expect(within(box).getByText('What-if project 1')).toBeInTheDocument();
    expect(within(box).getByText('After W52')).toBeInTheDocument();

    const outcome = screen.getByTestId('solve-outcome');
    expect(outcome).toHaveTextContent('Everything that capacity can help finishes inside the year');
    expect(outcome).not.toHaveTextContent(/fail|error|not met/i);
    expect(outcome).toHaveAttribute('role', 'status');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('says plainly when the search could not reach the target', () => {
    renderWithProviders(
      <SolveView data={solveFixture({ met: false, met_attainable: false, unmet_project_ids: ['a', 'b'], capped: true, exact: false })} />,
    );
    expect(screen.getByTestId('solve-outcome')).toHaveTextContent('did not reach the target within its limits');
    expect(screen.getByTestId('solve-outcome')).toHaveTextContent('2 projects still miss the year');
  });

  it('says nothing needs adding when the total is zero', () => {
    renderWithProviders(
      <SolveView
        data={solveFixture({ additions: { designers: [], chambers: [], total: 0 }, achieved: null })}
      />,
    );
    expect(screen.getByTestId('solve-outcome')).toHaveTextContent('Nothing needs adding');
    expect(screen.getByTestId('solve-designers')).toHaveTextContent('None');
  });
});
