import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { useImportPlan } from '../import-store';
import type { ImportRow, ImportSimulateRequest, ImportSimulateResponse } from '../import-types';
import { useImportScenarios } from '../scenarios-store';
import { PARSE_RESPONSE, SIMULATE_RESPONSE } from '../test-fixtures';
import ImportPlanView from './import-plan-view';

/** P32-R05: Executive tab, Year filter, scenarios and Compare. */

const calls: { url: string; init: RequestInit }[] = [];
let simulateReply: ImportSimulateResponse = SIMULATE_RESPONSE;

function simulateBodies(): ImportSimulateRequest[] {
  return calls
    .filter((c) => c.url.endsWith('/whatif/import/simulate'))
    .map((c) => JSON.parse(String(c.init.body)) as ImportSimulateRequest);
}

function startAtResults(rows: ImportRow[] = PARSE_RESPONSE.rows, result: ImportSimulateResponse = SIMULATE_RESPONSE) {
  useImportPlan.setState({
    parsed: PARSE_RESPONSE,
    rows: rows.map((r) => ({ ...r })),
    result,
    step: 'results',
  });
}

beforeEach(() => {
  useImportPlan.getState().reset();
  useImportScenarios.getState().clear();
  calls.length = 0;
  simulateReply = SIMULATE_RESPONSE;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(simulateReply), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** A donut's served slice: [count, served detail] from its readable data list. */
const slice = (testId: string, key: string) =>
  [...screen.getByTestId(`${testId}-slice-${key}`).querySelectorAll('dd')].map((d) => d.textContent);
/** The served total in a donut's centre. */
const centre = (testId: string) => screen.getByTestId(testId).querySelector('figure [data-numeric]')?.textContent;

const projectNames = () =>
  within(screen.getByTestId('import-projects'))
    .getAllByTestId('import-project-row')
    .map((r) => r.querySelector('td')?.textContent);

describe('P32-R05 results', () => {
  it('the Year filter switches the served block and filters the Gantt and Projects rows (axe on each tab)', async () => {
    const user = userEvent.setup();
    startAtResults();
    const { container } = renderWithProviders(<ImportPlanView />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Executive', 'Gantt', 'Capacity', 'Projects', 'Compare']);
    await screen.findByTestId('import-executive');
    await waitFor(() => expect(screen.getByTestId('import-kpi-total')).toHaveTextContent('Projects scheduled3'));
    expect(await seriousAxeViolations(container)).toEqual([]);

    await user.click(screen.getByRole('radio', { name: '2027' }));
    expect(useImportPlan.getState().yearFilter).toBe('2027');
    expect(screen.getByTestId('import-executive')).toHaveAttribute('data-year', '2027');
    await waitFor(() => expect(screen.getByTestId('import-kpi-total')).toHaveTextContent('Finish in 20271'));
    expect(screen.getByTestId('import-exec-outcome-slice-within_year')).toHaveTextContent('1');
    expect(screen.getByTestId('import-exec-outcome-slice-left_out')).toHaveTextContent('0');
    expect(screen.getByTestId('import-exec-quarters')).toHaveTextContent("Q2 '27");
    expect(screen.getByTestId('import-exec-quarters')).not.toHaveTextContent("Q1 '28");

    await user.click(screen.getByRole('tab', { name: 'Gantt' }));
    expect(screen.getByRole('radio', { name: '2027' })).toHaveAttribute('aria-checked', 'true');
    const ganttRows = await screen.findAllByTestId('import-gantt-project');
    expect(ganttRows).toHaveLength(1);
    expect(await seriousAxeViolations(container)).toEqual([]);

    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    await screen.findByTestId('import-projects');
    expect(projectNames()).toEqual(['Synthetic Cooler 750']);
    await user.click(screen.getByRole('radio', { name: 'Not placed' }));
    expect(projectNames()).toEqual(['Synthetic Freezer 300']);
    await user.click(screen.getByRole('radio', { name: 'After 2027' }));
    expect(projectNames()).toEqual(['Existing Plan Project']);
    expect(await seriousAxeViolations(container)).toEqual([]);

    await user.click(screen.getByRole('tab', { name: 'Capacity' }));
    await screen.findByTestId('import-capacity');
    expect(screen.queryByTestId('import-year-filter')).toBeNull();
    expect(await seriousAxeViolations(container)).toEqual([]);

    await user.click(screen.getByRole('tab', { name: 'Executive' }));
    await waitFor(() => expect(screen.getByTestId('import-kpi-total')).toHaveTextContent('Finish after 20271'));
  });

  it('Executive renders the served breakdowns as four Dashboard donuts, quarters, "Unknown" bucket (axe)', async () => {
    const all = SIMULATE_RESPONSE.breakdowns?.by_year.all;
    if (!all || !SIMULATE_RESPONSE.breakdowns) throw new Error('fixture');
    // A data-error row with no category: the served "unknown" bucket comes last (Σ buckets = total).
    const withUnknown: ImportSimulateResponse = {
      ...SIMULATE_RESPONSE,
      breakdowns: {
        ...SIMULATE_RESPONSE.breakdowns,
        by_year: {
          ...SIMULATE_RESPONSE.breakdowns.by_year,
          all: {
            ...all,
            by_category: [
              { key: 'A', total: 2, within_year: 1, spillover: 1, not_placed: 0 },
              { key: 'unknown', total: 1, within_year: 0, spillover: 0, not_placed: 1 },
            ],
          },
        },
      },
    };
    simulateReply = withUnknown;
    startAtResults(PARSE_RESPONSE.rows, withUnknown);
    const { container } = renderWithProviders(<ImportPlanView />);
    await screen.findByTestId('import-executive');
    const grid = screen.getByTestId('import-exec-donuts');
    expect(grid).toHaveClass('md:grid-cols-2');
    for (const [id, title] of [
      ['category', 'Projects by category'],
      ['hub', 'Projects by hub'],
      ['priority', 'Projects by priority'],
      ['status', 'Projects by status'],
    ]) {
      const donut = within(grid).getByTestId(`import-exec-${id}`);
      expect(within(donut).getByRole('heading', { name: title })).toBeInTheDocument();
      expect(centre(`import-exec-${id}`)).toBe('3');
    }
    expect(slice('import-exec-category', 'A')).toEqual(['2', '1 within the plan year · 1 spill over · 0 not placed']);
    expect(slice('import-exec-category', 'unknown')[0]).toBe('1');
    expect(screen.getByTestId('import-exec-category-slice-unknown')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('import-exec-category-legend')).toHaveTextContent('Unknown1');
    expect(slice('import-exec-hub', 'R&D-Greece')).toEqual(['1', '1 within the plan year · 0 spill over · 0 not placed']);
    expect(slice('import-exec-hub', 'PD-India')).toEqual(['2', '0 within the plan year · 1 spill over · 1 not placed']);
    expect(['P1', 'P2', 'P3'].map((k) => slice('import-exec-priority', k)[0])).toEqual(['1', '1', '1']);
    expect(slice('import-exec-status', 'In Queue')[0]).toBe('2');
    expect(slice('import-exec-status', 'In Development')[0]).toBe('1');
    expect(screen.queryByTestId('import-exec-hub-row')).toBeNull(); // the stacked bars are gone
    expect(screen.getByTestId('import-exec-quarters')).toHaveTextContent("Q1 '28");
    expect(screen.getByTestId('import-exec-outcome-slice-spillover')).toHaveTextContent('1');
    await waitFor(() => expect(screen.getByTestId('import-kpi-leftout')).toHaveTextContent('Not placed1'));
    expect(screen.getByTestId('import-kpi-file')).toHaveTextContent('1 plan');
    expect(await seriousAxeViolations(container)).toEqual([]);

    // The Year filter drives the donuts: 2027 holds only row-5.
    await userEvent.setup().click(screen.getByRole('radio', { name: '2027' }));
    expect(centre('import-exec-hub')).toBe('1');
    expect(slice('import-exec-hub', 'R&D-Greece')[0]).toBe('1');
    expect(screen.queryByTestId('import-exec-hub-slice-PD-India')).toBeNull();
    expect(slice('import-exec-priority', 'P1')[0]).toBe('1');
    expect(screen.queryByTestId('import-exec-priority-slice-P2')).toBeNull();
  });

  it('without served breakdowns the Executive falls back to the KPI figures', async () => {
    const legacy: ImportSimulateResponse = { ...SIMULATE_RESPONSE, breakdowns: undefined };
    simulateReply = legacy;
    startAtResults(PARSE_RESPONSE.rows, legacy);
    renderWithProviders(<ImportPlanView />);
    expect(await screen.findByTestId('import-exec-fallback')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('import-kpi-total')).toHaveTextContent('Projects scheduled240'));
    expect(screen.getByTestId('import-kpi-leftout')).toHaveTextContent('Not placed9');
    expect(screen.getByRole('radio', { name: '2027' })).toBeInTheDocument();
  });

  it('save, rename and delete a scenario (session only)', async () => {
    const user = userEvent.setup();
    startAtResults();
    const { container } = renderWithProviders(<ImportPlanView />);
    await screen.findByTestId('import-executive');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as scenario' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save as scenario' }));
    const dialog = await screen.findByTestId('import-save-scenario');
    const name = within(dialog).getByLabelText('Scenario name');
    expect(name).toHaveValue('Scenario 1');
    await user.clear(name);
    await user.type(name, 'Base case');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    const saved = useImportScenarios.getState().scenarios;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Base case', origin: 'saved', fileName: 'synthetic-plan.xlsx' });
    expect(saved[0]?.response).toBe(useImportPlan.getState().result);
    expect(saved[0]?.rows).toEqual(useImportPlan.getState().rows);

    await user.click(screen.getByRole('tab', { name: 'Compare (1)' }));
    await screen.findByTestId('import-compare');
    expect(screen.getByTestId('import-session-banner')).toHaveTextContent('kept for this session only');
    expect(screen.getByTestId('compare-need-two')).toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Rename Base case' }));
    const input = screen.getByRole('textbox', { name: 'New name for Base case' });
    await user.clear(input);
    await user.type(input, 'Plan A');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(screen.getByTestId('import-scenario')).toHaveAttribute('data-scenario', 'Plan A');
    await user.click(screen.getByRole('button', { name: 'Delete Plan A' }));
    expect(screen.queryByTestId('import-scenario')).toBeNull();
    expect(useImportScenarios.getState().scenarios).toEqual([]);
  });

  it('builder "only 5 A+" sends the right include set to /simulate and saves the variant', async () => {
    const base = PARSE_RESPONSE.rows[0];
    if (!base) throw new Error('fixture');
    const rows: ImportRow[] = [
      ...[
        ['P2', null],
        ['P1', 4],
        ['P1', 2],
        ['P3', null],
        ['P1', null],
        ['P2', null],
        ['P1', 1],
      ].map(
        ([priority, rank], i): ImportRow => ({
          ...base,
          key: `row-${String(10 + i)}`,
          file_row: 10 + i,
          name: `Plus ${String(i)}`,
          category: 'A+',
          lead_time_label: 'A+',
          priority: priority as ImportRow['priority'],
          rank: rank as number | null,
          matched_project_id: null,
          matched_project_name: null,
          include: true,
        }),
      ),
      { ...base, key: 'row-30', file_row: 30, name: 'Bee', category: 'B', lead_time_label: 'B', include: true },
    ];
    const user = userEvent.setup();
    startAtResults(rows);
    const { container } = renderWithProviders(<ImportPlanView />);
    await screen.findByTestId('import-executive');
    await waitFor(() => expect(simulateBodies()).toHaveLength(1)); // the results view's own run
    await user.click(screen.getByRole('button', { name: 'Build a variant' }));
    const dialog = await screen.findByTestId('import-scenario-builder');
    expect(within(dialog).getByTestId('builder-preview')).toHaveTextContent('8 of 8 rows kept');
    await user.click(within(dialog).getByRole('button', { name: 'Only 5 A+' }));
    expect(within(dialog).getByTestId('builder-preview')).toHaveTextContent(
      '6 of 8 rows kept · at most 5 A+ · merged with the plan',
    );
    await user.click(within(dialog).getByRole('radio', { name: 'File only' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Compute and save' }));

    await waitFor(() => expect(useImportScenarios.getState().scenarios).toHaveLength(1));
    const body = simulateBodies()[1];
    expect(body?.mode).toBe('file_only');
    expect(body?.rows.filter((r) => r.include).map((r) => r.key)).toEqual([
      'row-10',
      'row-11',
      'row-12',
      'row-14',
      'row-16',
      'row-30',
    ]);
    const scn = useImportScenarios.getState().scenarios[0];
    expect(scn).toMatchObject({ name: 'Variant 1', origin: 'variant', rules: 'at most 5 A+ · this file only' });
    expect(scn?.options.mode).toBe('file_only');
    // The planner's own rows are untouched.
    expect(useImportPlan.getState().rows.every((r) => r.include)).toBe(true);
    expect(useImportPlan.getState().options.mode).toBe('merge');
    expect(await screen.findByTestId('import-compare')).toBeInTheDocument();
  });

  it('Compare: KPI deltas vs the baseline, grouped bars, capacity side by side, outcome changes', async () => {
    const [file, auto, plan] = SIMULATE_RESPONSE.projects;
    if (!file || !auto || !plan) throw new Error('fixture');
    const served = SIMULATE_RESPONSE.breakdowns;
    const all = served?.by_year.all;
    const notPlaced = served?.by_year.not_placed;
    if (!served || !all || !notPlaced) throw new Error('fixture');
    // row-6 is placed in the variant: the served "all" block moves 1 → 2 within the year.
    const variantResponse: ImportSimulateResponse = {
      ...SIMULATE_RESPONSE,
      mode: 'file_only',
      kpis: { ...SIMULATE_RESPONSE.kpis, within_plan_year: 175, spillover: 50 },
      projects: [file, { ...auto, outcome: 'within_year', finish_week: 90 }, plan],
      breakdowns: {
        ...served,
        by_year: {
          ...served.by_year,
          all: { ...all, outcomes: { ...all.outcomes, within_year: 2, left_out: 0 } },
          not_placed: { ...notPlaced, total: 0, file: 0 },
        },
      },
    };
    const opts = { mode: 'merge' as const, planYearEndWeek: 104 as const, expandMulti: true };
    const st = useImportScenarios.getState();
    st.save({ name: 'Base', origin: 'saved', rules: null, fileName: null, rows: [], options: opts, edits: {}, response: SIMULATE_RESPONSE });
    st.save({ name: 'Lean', origin: 'variant', rules: 'at most 5 A+ · this file only', fileName: null, rows: [], options: opts, edits: {}, response: variantResponse });
    startAtResults();
    useImportPlan.setState({ resultsTab: 'compare' });
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ImportPlanView />);
    await screen.findByTestId('import-compare');
    const within_ = screen.getByTestId('compare-kpi-within_plan_year');
    // The Executive tile's served figures (by_year.all), not the kpis block.
    expect([...within_.querySelectorAll('[data-numeric]')].map((n) => n.textContent)).toEqual(['1', '2']);
    expect(within(within_).getByTestId('compare-delta')).toHaveTextContent('+1');
    expect(within(screen.getByTestId('compare-kpi-spillover')).getByTestId('compare-delta')).toHaveTextContent('±0');
    expect(within(screen.getByTestId('compare-kpi-not_placed')).getByTestId('compare-delta')).toHaveTextContent('−1');
    // Same served figure and wording as the Executive "All" tile (by_year.all.total = 3), not
    // kpis.projects_total (240, which also counts the not-scheduled plan projects).
    const scheduled = screen.getByTestId('compare-kpi-projects_scheduled');
    expect(scheduled).toHaveTextContent('Projects scheduled');
    expect(scheduled.querySelectorAll('[data-numeric]')[0]).toHaveTextContent(/^3$/);
    expect(within(scheduled).getByTestId('compare-delta')).toHaveTextContent('±0');
    expect(screen.getByTestId('compare-kpi-excluded')).toHaveTextContent('Not scheduled3');
    expect(screen.getByTestId('compare-kpi-within_plan_year')).toHaveTextContent('Finish in 2027');
    expect(screen.getByTestId('compare-kpi-file_projects')).toHaveTextContent('From the file2');
    expect(screen.queryByText('240')).toBeNull();
    expect(screen.getByTestId('compare-bars')).toHaveTextContent('Lean');
    expect(screen.getAllByTestId('compare-capacity-row')).toHaveLength(2);
    const diff = screen.getByTestId('compare-outcome-changes');
    expect(diff).toHaveTextContent('1 project changes outcome');
    expect(diff).toHaveTextContent('Synthetic Freezer 300');
    expect(await seriousAxeViolations(container)).toEqual([]);

    // Make "Lean" the baseline: deltas flip.
    await user.click(screen.getByRole('button', { name: 'Make Lean the baseline' }));
    expect(within(screen.getByTestId('compare-kpi-within_plan_year')).getByTestId('compare-delta')).toHaveTextContent('−1');
    // Untick one → fewer than two.
    await user.click(screen.getByRole('checkbox', { name: 'Compare Base' }));
    expect(screen.getByTestId('compare-need-two')).toBeInTheDocument();
  });
});
