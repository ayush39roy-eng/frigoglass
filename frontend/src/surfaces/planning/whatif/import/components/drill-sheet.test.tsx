import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { useDrill } from '../drill-store';
import { useImportPlan } from '../import-store';
import type { ImportSimulateResponse } from '../import-types';
import { useImportScenarios } from '../scenarios-store';
import { DRILL_RESPONSE, PARSE_RESPONSE, SIMULATE_RESPONSE } from '../test-fixtures';
import ImportPlanView from './import-plan-view';

/** P32-R07: every number of the import Review / Results opens the list behind it. */

/** What the mocked `/simulate` answers (the view re-simulates when it opens on Results). */
let reply: ImportSimulateResponse = DRILL_RESPONSE;

function startAtResults(result: ImportSimulateResponse = DRILL_RESPONSE) {
  reply = result;
  useImportPlan.setState({
    parsed: PARSE_RESPONSE,
    rows: PARSE_RESPONSE.rows.map((r) => ({ ...r })),
    result,
    step: 'results',
  });
}

beforeEach(() => {
  useImportPlan.getState().reset();
  useImportScenarios.getState().clear();
  useDrill.getState().close(false);
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** The first integer of a text ("1 plan" → 1, "Show the 2 projects…" → 2). */
function firstInt(text: string | null | undefined): number {
  const m = /\d[\d,]*/.exec(text ?? '');
  if (!m) throw new Error(`no number in "${text ?? ''}"`);
  return Number(m[0].replace(/,/g, ''));
}

/** The number the button SHOWS: a tile's figure, a chip's count, a bar's count, the button text. */
function displayed(btn: HTMLElement): number {
  const legend = btn.dataset.testid?.includes('-legend-');
  if (legend) return firstInt(btn.lastElementChild?.textContent);
  const numeric = btn.querySelector('[data-numeric]');
  return firstInt(numeric ? numeric.textContent : btn.textContent);
}

/** Open the sheet from `btn`, read it, close it with Escape. */
async function openRead(btn: HTMLElement): Promise<{ rows: number; count: number; title: string; shortfall: string | null }> {
  fireEvent.click(btn);
  const sheet = await screen.findByTestId('drill-sheet');
  const out = {
    rows: within(sheet).queryAllByTestId('drill-row').length,
    count: Number(within(sheet).getByTestId('drill-count').dataset.count),
    title: within(sheet).getByTestId('drill-title').textContent ?? '',
    shortfall: within(sheet).queryByTestId('drill-shortfall')?.textContent ?? null,
  };
  fireEvent.keyDown(sheet, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByTestId('drill-sheet')).toBeNull());
  return out;
}

const drillButtons = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('button[aria-haspopup="dialog"]')].filter((b) =>
    (b.getAttribute('aria-label') ?? '').startsWith('Show the '),
  );

describe('P32-R07 drill-down sheet', () => {
  it('every Executive figure (tiles, slices, chips, quarters, list headers) lists exactly its number, for every Year', async () => {
    startAtResults();
    renderWithProviders(<ImportPlanView />);
    await screen.findByTestId('import-executive');
    await waitFor(() => expect(screen.getByTestId('import-kpi-total')).toHaveTextContent('Projects scheduled7'));

    const years = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label') ?? r.textContent ?? '');
    expect(years).toHaveLength(5);
    let checked = 0;
    for (const name of years) {
      fireEvent.click(screen.getByRole('radio', { name }));
      const exec = screen.getByTestId('import-executive');
      // Let the count-up settle to the served figures.
      await waitFor(() => {
        for (const b of drillButtons(exec)) expect(displayed(b)).toBe(firstInt(b.getAttribute('aria-label')));
      });
      const buttons = drillButtons(exec);
      expect(buttons.length).toBeGreaterThan(8);
      for (const b of buttons) {
        const shown = displayed(b);
        const read = await openRead(b);
        const what = `${name} · ${b.getAttribute('aria-label') ?? ''}`;
        expect(read.rows, what).toBe(shown);
        expect(read.count, what).toBe(shown);
        expect(read.title, what).toContain(` · ${String(shown)} `);
        expect(read.shortfall, what).toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  }, 60_000);

  it('a figure the planner cannot list in full says "N of M shown"; Escape returns focus; axe clean', async () => {
    startAtResults({ ...DRILL_RESPONSE, mode: 'file_only' });
    const user = userEvent.setup();
    renderWithProviders(<ImportPlanView />);
    const tile = await screen.findByTestId('import-kpi-excluded');
    expect(tile).toHaveAttribute('aria-label', 'Show the 3 projects not scheduled');
    await user.click(tile);
    const sheet = await screen.findByTestId('drill-sheet');
    expect(within(sheet).getByTestId('drill-title')).toHaveTextContent('Not scheduled · 3 projects');
    expect(within(sheet).getAllByTestId('drill-row')).toHaveLength(1);
    expect(within(sheet).getByTestId('drill-shortfall')).toHaveTextContent(
      '1 of 3 shown (the other plan projects that are not scheduled',
    );
    expect(await seriousAxeViolations(document.body)).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('drill-sheet')).toBeNull());
    await waitFor(() => expect(tile).toHaveFocus());
  });

  it('search, Open project, and Show on Gantt (tab, filter, expand, focus; Year reset when hidden)', async () => {
    startAtResults();
    const user = userEvent.setup();
    renderWithProviders(<ImportPlanView />);
    await screen.findByTestId('import-executive');
    await user.click(screen.getByRole('radio', { name: '2027' }));
    // plan-1 slips out of 2027 (finish W110 = after 2027), so the 2027 filter hides it.
    await user.click(screen.getByTestId('import-newly-slipping-drill'));
    let sheet = await screen.findByTestId('drill-sheet');
    expect(within(sheet).getByTestId('drill-title')).toHaveTextContent('Newly slipping out of 2027 · 1 project');
    const row = within(sheet).getByTestId('drill-row');
    expect(row).toHaveTextContent('Existing Plan Project');
    expect(row).toHaveTextContent("W48 '27");
    expect(row).toHaveTextContent("W6 '28");
    expect(within(row).getByTestId('drill-open-project')).toHaveAttribute('href', '/projects/plan-1');
    await user.type(within(sheet).getByTestId('drill-search'), 'zzz');
    expect(within(sheet).queryAllByTestId('drill-row')).toHaveLength(0);
    expect(sheet).toHaveTextContent('0 of 1 match');
    await user.clear(within(sheet).getByTestId('drill-search'));
    await user.click(within(sheet).getByTestId('drill-show-gantt'));

    await waitFor(() => expect(screen.queryByTestId('drill-sheet')).toBeNull());
    expect(useImportPlan.getState().resultsTab).toBe('gantt');
    expect(useImportPlan.getState().yearFilter).toBe('all');
    const projects = await screen.findAllByTestId('import-gantt-project');
    expect(projects.map((p) => p.dataset.ref)).toEqual(['plan-1']);
    expect(screen.getAllByTestId('import-gantt-step').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/search/i)).toHaveValue('Existing Plan Project');
    await waitFor(() => expect(within(projects[0]!).getByRole('button', { name: /collapse steps/ })).toHaveFocus());
    expect(useImportPlan.getState().ganttFocus).toBeNull();

    // A file copy: source shows the file row and the copy; no "Open project".
    await user.click(screen.getByRole('tab', { name: 'Executive' }));
    await user.click(await screen.findByTestId('import-exec-category-legend-unknown'));
    sheet = await screen.findByTestId('drill-sheet');
    const copy = within(sheet).getByTestId('drill-row');
    expect(copy).toHaveTextContent('row 8');
    expect(copy).toHaveTextContent('(2/2)');
    expect(within(copy).queryByTestId('drill-open-project')).toBeNull();
  });

  it('Capacity cells and designers list the projects booked / led', async () => {
    startAtResults();
    useImportPlan.setState({ resultsTab: 'capacity' });
    renderWithProviders(<ImportPlanView />);
    const cap = await screen.findByTestId('import-capacity');
    const cells = within(cap).getAllByTestId('import-cap-cell');
    // Design hubs: R&D-Greece y0, y1, PD-India y0, y1, PD-Romania y0, y1; then the lab regions.
    const expected = [2, 1, 1, 1, 0, 0, 2, 1, 1, 1, 0, 0];
    expect(cells).toHaveLength(expected.length);
    for (const [i, c] of cells.entries()) {
      const read = await openRead(c);
      expect(read.rows, c.getAttribute('aria-label') ?? '').toBe(expected[i]);
      expect(read.count).toBe(expected[i]);
      expect(firstInt(c.getAttribute('aria-label'))).toBe(expected[i]);
    }
    const designers = within(cap).getAllByTestId('import-designer-drill');
    const led: number[] = [];
    for (const d of designers) led.push((await openRead(d)).rows);
    expect(led).toEqual([1, 2, 1]);
    expect(designers[0]).toHaveAttribute('aria-label', 'Show the 1 project led by Nikos');
  });

  it('Compare cells and the "changes outcome" count list their projects', async () => {
    const opts = { mode: 'merge' as const, planYearEndWeek: 104 as const, expandMulti: true };
    const st = useImportScenarios.getState();
    st.save({ name: 'Base', origin: 'saved', rules: null, fileName: null, rows: [], options: opts, edits: {}, response: DRILL_RESPONSE });
    st.save({ name: 'Old', origin: 'saved', rules: null, fileName: null, rows: [], options: opts, edits: {}, response: SIMULATE_RESPONSE });
    startAtResults();
    useImportPlan.setState({ resultsTab: 'compare' });
    renderWithProviders(<ImportPlanView />);
    await screen.findByTestId('import-compare');
    const cells = screen.getAllByTestId(/^compare-drill-/);
    expect(cells.length).toBe(22);
    for (const c of cells) {
      const shown = displayed(c);
      const read = await openRead(c);
      const what = c.getAttribute('aria-label') ?? '';
      expect(read.title, what).toContain(` · ${String(shown)} `);
      if (read.shortfall === null) expect(read.rows, what).toBe(shown);
      else expect(read.shortfall, what).toMatch(new RegExp(`^${String(read.rows)} of ${String(shown)} shown`));
    }
    // Not reproducible by filtering: "Not scheduled" (kpis.excluded counts plan projects not returned).
    const short: string[] = [];
    for (const c of cells) if ((await openRead(c)).shortfall !== null) short.push(c.dataset.testid ?? '');
    // Base (consistent fixture): only "Not scheduled". Old is the P32-R05 fixture whose kpis
    // stand for a whole plan of 240 against 3 returned rows, so its outcome rows are short too.
    expect(short).toEqual([
      'compare-drill-excluded',
      'compare-drill-excluded',
      'compare-drill-left_out',
      'compare-drill-blocked',
      'compare-drill-data_error',
    ]);
    const changes = screen.getByTestId('compare-changes-drill');
    expect(displayed(changes)).toBe(4);
    const read = await openRead(changes);
    expect(read.rows).toBe(4);
    expect(read.title).toContain('Change outcome · 4 projects');
  }, 30_000);

  it('Review count tiles list their rows (axe on the open sheet)', async () => {
    useImportPlan.getState().setParsed(PARSE_RESPONSE);
    const user = userEvent.setup();
    renderWithProviders(<ImportPlanView />);
    const counts = await screen.findByTestId('import-counts');
    const tiles = drillButtons(counts);
    expect(tiles).toHaveLength(8);
    for (const t of tiles) {
      const shown = displayed(t);
      const read = await openRead(t);
      const what = t.getAttribute('aria-label') ?? '';
      expect(read.count, what).toBe(shown);
      if (t.dataset.testid === 'import-review-drill-new_designers') expect(read.rows, what).toBe(1);
      else expect(read.rows, what).toBe(shown);
    }
    await user.click(screen.getByTestId('import-review-drill-auto_assign'));
    const sheet = await screen.findByTestId('drill-sheet');
    expect(within(sheet).getByTestId('drill-title')).toHaveTextContent('Auto-assign · 1 row');
    expect(within(sheet).getByTestId('drill-row')).toHaveTextContent('Synthetic Freezer 300');
    expect(await seriousAxeViolations(document.body)).toEqual([]);
  });
});
