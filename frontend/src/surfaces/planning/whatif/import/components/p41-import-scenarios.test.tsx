import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { saveBlob } from '@/lib/download';

import { useImportPlan } from '../import-store';
import type { ImportSimulateRequest, SavedScenario } from '../import-types';
import { useImportScenarios } from '../scenarios-store';
import { PARSE_RESPONSE } from '../test-fixtures';
import { P41_RESPONSE, p41Format, p41Saved, SHA_A, SHA_B } from '../p41-fixtures';
import { useImportToast } from '../toast-store';
import ImportPlanView from './import-plan-view';

/** P41 (ADR 0055, contract E): format card, picker, save, library, compare, exports. */

vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));

type Handler = (url: URL, init: RequestInit) => Response | undefined;
const calls: { url: URL; init: RequestInit }[] = [];
let override: Handler = () => undefined;
let savedById: Record<string, SavedScenario> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function xlsxFile(name: string): Response {
  return new Response('PK-synthetic', {
    status: 200,
    headers: { 'Content-Disposition': `attachment; filename="${name}"` },
  });
}

function route(url: URL, init: RequestInit): Response {
  const hit = override(url, init);
  if (hit) return hit;
  const method = init.method ?? 'GET';
  const p = url.pathname;
  if (p === '/whatif/import/format' && method === 'GET') return json(p41Format());
  if (p === '/whatif/import/format' && method === 'PUT') return json({ ...p41Format(), version: 4 });
  if (p === '/whatif/import/simulate') return json(P41_RESPONSE);
  if (p === '/whatif/import/export.xlsx') return xlsxFile('current.xlsx');
  if (p === '/whatif/import/format/template.xlsx') return xlsxFile('import-template.xlsx');
  if (p === '/whatif/import/scenarios/compare.xlsx') return xlsxFile('compare.xlsx');
  if (p === '/whatif/import/scenarios' && method === 'GET') {
    const sha = url.searchParams.get('source_file_sha256');
    const items = Object.values(savedById)
      .filter((s) => sha === null || s.source_file_sha256 === sha)
      .map(({ request: _r, result: _x, ...summary }) => summary);
    return json({ items });
  }
  if (p === '/whatif/import/scenarios' && method === 'POST') {
    const body = JSON.parse(String(init.body)) as { name: string; note?: string };
    return json(p41Saved({ id: 'new-1', name: body.name, note: body.note ?? null }), 201);
  }
  const exp = /^\/whatif\/import\/scenarios\/([^/]+)\/export\.xlsx$/.exec(p);
  if (exp) return xlsxFile(`${exp[1] ?? ''}.xlsx`);
  const one = /^\/whatif\/import\/scenarios\/([^/]+)$/.exec(p);
  if (one?.[1] && savedById[one[1]]) return json(savedById[one[1]]);
  return json({ detail: 'not found' }, 404);
}

const bodiesOf = (path: string, method = 'POST') =>
  calls.filter((c) => c.url.pathname === path && (c.init.method ?? 'GET') === method).map((c) => JSON.parse(String(c.init.body)) as unknown);

beforeEach(() => {
  useImportPlan.getState().reset();
  useImportScenarios.getState().clear();
  useImportToast.getState().dismiss();
  calls.length = 0;
  override = () => undefined;
  savedById = {};
  vi.mocked(saveBlob).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, 'http://localhost');
      calls.push({ url, init });
      return Promise.resolve(route(url, init));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** The results re-simulate once on mount; the bar's actions are off until it settles. */
async function idleBar() {
  const bar = await screen.findByTestId('import-scenario-bar');
  await waitFor(() => expect(within(bar).getByRole('button', { name: 'Export' })).toBeEnabled());
  return bar;
}

function startAtResults(sha: string | null = SHA_A) {
  useImportPlan.setState({
    parsed: PARSE_RESPONSE,
    rows: PARSE_RESPONSE.rows.map((r) => ({ ...r })),
    result: P41_RESPONSE,
    step: 'results',
    source: { file_name: 'synthetic-plan.xlsx', sha256: sha, imported_at: '2026-11-17T09:00:00Z' },
  });
}

describe('P41 Excel format card', () => {
  it('Super Admin sees "Edit format"; the served format and the template download are for everyone (axe)', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ImportPlanView />);
    const card = screen.getByTestId('import-format-help');
    await within(card).findByTestId('import-format-fields');
    expect(card).toHaveTextContent('project description');
    expect(card).toHaveTextContent('Edited by Synthetic Admin');
    expect(within(card).getByRole('button', { name: 'Edit format' })).toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);

    await user.click(within(card).getByRole('button', { name: 'Download template' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.anything(), 'import-template.xlsx'));
    expect(calls.some((c) => c.url.pathname === '/whatif/import/format/template.xlsx')).toBe(true);
  });

  it.each([['Hub Planner'], ['Executive Viewer'], ['Portfolio Manager']])(
    '%s never sees the edit button, even when the server says can_edit',
    async (role) => {
      renderWithProviders(<ImportPlanView />, { session: { roles: [role as 'Hub Planner'] } });
      const card = screen.getByTestId('import-format-help');
      await within(card).findByTestId('import-format-fields');
      expect(within(card).queryByRole('button', { name: 'Edit format' })).toBeNull();
      expect(within(card).getByRole('button', { name: 'Download template' })).toBeInTheDocument();
    },
  );

  it('Admin edits aliases and saves a PUT with the version; a 409 shows the reload message', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportPlanView />, { session: { roles: ['Admin'] } });
    await user.click(await screen.findByRole('button', { name: 'Edit format' }));
    const dialog = await screen.findByTestId('import-format-dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Project name' }), 'Project title{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Remove plant from Plant' }));
    // Plant now has no header name: Save is blocked until one is added back.
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Reset Plant to default' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodiesOf('/whatif/import/format', 'PUT')).toHaveLength(1));
    const put = bodiesOf('/whatif/import/format', 'PUT')[0] as { version: number; fields: Record<string, string[]> };
    expect(put.version).toBe(3);
    expect(put.fields.name).toEqual(['project description', 'Project title']);
    expect(put.fields.plant).toEqual(['plant']);
    expect(Object.keys(put.fields)).toHaveLength(16);
    expect(await screen.findByTestId('import-toast')).toHaveTextContent('Excel format saved');
    expect(screen.queryByTestId('import-format-dialog')).toBeNull();

    override = (url, init) =>
      url.pathname === '/whatif/import/format' && init.method === 'PUT'
        ? json({ detail: 'stale', code: 'FORMAT_VERSION_CONFLICT' }, 409)
        : undefined;
    await user.click(screen.getByRole('button', { name: 'Edit format' }));
    const again = await screen.findByTestId('import-format-dialog');
    await user.click(within(again).getByRole('button', { name: 'Save' }));
    expect(await within(again).findByTestId('format-save-error')).toHaveTextContent(
      'Someone else changed the format — reload',
    );
    expect(within(again).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('"Reset all to default" asks first, then posts the version', async () => {
    const user = userEvent.setup();
    override = (url) => (url.pathname === '/whatif/import/format/reset' ? json(p41Format({ version: 4, is_default: true })) : undefined);
    renderWithProviders(<ImportPlanView />);
    await user.click(await screen.findByRole('button', { name: 'Edit format' }));
    const dialog = await screen.findByTestId('import-format-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset all to default' }));
    expect(bodiesOf('/whatif/import/format/reset')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Reset all' }));
    await waitFor(() => expect(bodiesOf('/whatif/import/format/reset')).toEqual([{ version: 3 }]));
  });
});

describe('P41 Executive scenario bar', () => {
  it('the picker sends the ticked rows as include and the unticked plan projects as exclude_plan_project_ids', async () => {
    const user = userEvent.setup();
    startAtResults();
    const { container } = renderWithProviders(<ImportPlanView />);
    const bar = await idleBar();
    await user.click(within(bar).getByRole('button', { name: 'Pick projects…' }));
    const sheet = await screen.findByTestId('import-picker');
    expect(within(sheet).getByTestId('picker-count')).toHaveTextContent('5 of 5 included');
    expect(within(sheet).getAllByTestId('picker-row')).toHaveLength(5);
    expect(await seriousAxeViolations(container)).toEqual([]);

    await user.click(within(sheet).getByRole('checkbox', { name: 'Include Synthetic Freezer 300' }));
    await user.click(within(sheet).getByRole('checkbox', { name: 'Include Existing Greek Project' }));
    expect(within(sheet).getByTestId('picker-count')).toHaveTextContent('3 of 5 included');

    // The Source filter narrows; "Select none" applies to the shown rows only.
    await user.selectOptions(within(sheet).getByRole('combobox', { name: 'Source' }), 'plan');
    expect(within(sheet).getAllByTestId('picker-row')).toHaveLength(2);
    await user.click(within(sheet).getByRole('button', { name: 'Select all' }));
    expect(within(sheet).getByTestId('picker-count')).toHaveTextContent('4 of 5 included');
    await user.click(within(sheet).getByRole('checkbox', { name: 'Include Existing Greek Project' }));

    const before = bodiesOf('/whatif/import/simulate').length;
    await user.click(within(sheet).getByRole('button', { name: 'Compute scenario' }));
    await waitFor(() => expect(bodiesOf('/whatif/import/simulate').length).toBeGreaterThan(before));
    const body = bodiesOf('/whatif/import/simulate').at(-1) as ImportSimulateRequest;
    expect(body.rows.map((r) => [r.key, r.include])).toEqual([
      ['row-5', true],
      ['row-6', false],
      ['row-7', true],
    ]);
    expect(body.exclude_plan_project_ids).toEqual(['plan-2']);
    expect(useImportPlan.getState().excludedPlanIds).toEqual(['plan-2']);
  });

  it('"Save scenario" posts the name, note, source and the request (never a result); a toast confirms', async () => {
    const user = userEvent.setup();
    startAtResults();
    useImportPlan.setState({ excludedPlanIds: ['plan-1'] });
    renderWithProviders(<ImportPlanView />);
    const bar = await idleBar();
    await user.click(within(bar).getByRole('button', { name: 'Save scenario' }));
    const dialog = await screen.findByTestId('import-save-scenario');
    await user.type(within(dialog).getByLabelText('Scenario name'), 'Only India');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Synthetic note');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodiesOf('/whatif/import/scenarios')).toHaveLength(1));
    const body = bodiesOf('/whatif/import/scenarios')[0] as Record<string, unknown> & { request: ImportSimulateRequest };
    expect(Object.keys(body).sort()).toEqual(
      ['imported_at', 'name', 'note', 'request', 'source_file_name', 'source_file_sha256'].sort(),
    );
    expect(body).toMatchObject({
      name: 'Only India',
      note: 'Synthetic note',
      source_file_name: 'synthetic-plan.xlsx',
      source_file_sha256: SHA_A,
      imported_at: '2026-11-17T09:00:00Z',
    });
    expect(body.request.exclude_plan_project_ids).toEqual(['plan-1']);
    expect(body.request).not.toHaveProperty('result');
    expect(await screen.findByTestId('import-toast')).toHaveTextContent('Scenario “Only India” saved');
    // The saved record joins the Compare list (stored, ticked).
    expect(useImportScenarios.getState().scenarios).toMatchObject([{ name: 'Only India', origin: 'stored', stored: { id: 'new-1' } }]);
  });

  it('saving is off when the file could not be fingerprinted', async () => {
    startAtResults(null);
    renderWithProviders(<ImportPlanView />);
    const bar = await idleBar();
    expect(within(bar).getByRole('button', { name: 'Save scenario' })).toBeDisabled();
  });

  it('Export of the current result POSTs {name, request}; a saved scenario exports by id, shows its banner and re-runs', async () => {
    const user = userEvent.setup();
    savedById = { 'saved-1': p41Saved() };
    startAtResults();
    renderWithProviders(<ImportPlanView />);
    const bar = await idleBar();
    await user.click(within(bar).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.anything(), 'current.xlsx'));
    const exp = bodiesOf('/whatif/import/export.xlsx')[0] as Record<string, unknown>;
    expect(Object.keys(exp).sort()).toEqual(['name', 'request']);
    expect(exp.name).toBe('Current result');

    // The selector lists this import's saved scenarios (filtered by the file's sha).
    const select = within(bar).getByTestId('scenario-select');
    await within(select).findByRole('option', { name: 'Saved base' });
    expect(calls.some((c) => c.url.searchParams.get('source_file_sha256') === SHA_A)).toBe(true);
    await user.selectOptions(select, 'saved:saved-1');
    expect(await screen.findByTestId('import-view-banner')).toHaveTextContent(
      'Saved scenario — simulated W40 against plan v14',
    );
    expect(within(bar).getByRole('button', { name: 'Save scenario' })).toBeDisabled();
    await user.click(within(bar).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.anything(), 'saved-1.xlsx'));
    expect(calls.some((c) => c.url.pathname === '/whatif/import/scenarios/saved-1/export.xlsx')).toBe(true);

    const before = bodiesOf('/whatif/import/simulate').length;
    await user.click(screen.getByRole('button', { name: "Re-run on today's plan" }));
    await waitFor(() => expect(bodiesOf('/whatif/import/simulate').length).toBeGreaterThan(before));
    const rerun = bodiesOf('/whatif/import/simulate').at(-1) as ImportSimulateRequest;
    expect(rerun.exclude_plan_project_ids).toEqual(['plan-2']);
    expect(screen.queryByTestId('import-view-banner')).toBeNull();
  });
});

describe('P41 library and compare', () => {
  it('groups by source file, mixes saved and session scenarios in Compare, and exports an all-saved comparison', async () => {
    const user = userEvent.setup();
    savedById = {
      'saved-1': p41Saved(),
      'saved-2': p41Saved({
        id: 'saved-2',
        name: 'October plan',
        source_file_name: 'october-plan.xlsx',
        source_file_sha256: SHA_B,
        imported_at: '2026-10-20T09:00:00Z',
        simulated_week: 42,
        plan_version: 12,
        can_edit: false,
      }),
    };
    startAtResults();
    useImportScenarios.getState().save({
      name: 'Session variant',
      origin: 'variant',
      rules: 'only A+',
      fileName: 'synthetic-plan.xlsx',
      rows: PARSE_RESPONSE.rows,
      options: useImportPlan.getState().options,
      edits: {},
      response: P41_RESPONSE,
    });
    const { container } = renderWithProviders(<ImportPlanView />);
    await user.click(await screen.findByRole('tab', { name: 'Compare (1)' }));
    const library = await screen.findByTestId('import-library');
    await within(library).findAllByTestId('library-card');
    expect(within(library).getAllByTestId('library-group-file').map((g) => g.textContent)).toEqual([
      'synthetic-plan.xlsx',
      'october-plan.xlsx',
    ]);
    // Rename / delete only where the server says can_edit.
    expect(within(library).getByRole('button', { name: 'Rename Saved base' })).toBeInTheDocument();
    expect(within(library).queryByRole('button', { name: 'Rename October plan' })).toBeNull();
    expect(screen.getByTestId('import-session-banner')).toBeInTheDocument();

    await user.click(within(library).getByRole('button', { name: 'Add October plan to compare' }));
    await within(library).findByRole('button', { name: 'Remove October plan from compare' });
    // Session variant (W42 served) + saved October (W42, v12): two files, same week.
    const kpis = await screen.findByRole('table', { name: 'Scenario figures' });
    expect(within(kpis).getAllByTestId('compare-source-chip').map((c) => c.textContent)).toEqual([
      'synthetic-plan.xlsx',
      'october-plan.xlsx',
    ]);
    expect(screen.queryByTestId('compare-clock-banner')).toBeNull();
    expect(screen.getByRole('button', { name: 'Export comparison' })).toBeDisabled();
    expect(await seriousAxeViolations(container)).toEqual([]);

    // Add the W40 saved scenario: a clock banner; drop the session one: export is on.
    await user.click(within(library).getByRole('button', { name: 'Add Saved base to compare' }));
    expect(await screen.findByTestId('compare-clock-banner')).toHaveTextContent('W40');
    await user.click(screen.getByRole('checkbox', { name: 'Compare Session variant' }));
    const exportBtn = screen.getByRole('button', { name: 'Export comparison' });
    expect(exportBtn).toBeEnabled();
    await user.click(exportBtn);
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.anything(), 'compare.xlsx'));
    const cmp = calls.find((c) => c.url.pathname === '/whatif/import/scenarios/compare.xlsx');
    expect(cmp?.url.searchParams.get('ids')).toBe('saved-2,saved-1');
  });

  it('delete asks first, calls DELETE and drops the scenario from the compare list', async () => {
    const user = userEvent.setup();
    savedById = { 'saved-1': p41Saved() };
    override = (url, init) => {
      if (init.method === 'DELETE' && url.pathname === '/whatif/import/scenarios/saved-1') {
        delete savedById['saved-1'];
        return new Response(null, { status: 204 });
      }
      return undefined;
    };
    startAtResults();
    renderWithProviders(<ImportPlanView />);
    await user.click(await screen.findByRole('tab', { name: /Compare/ }));
    const library = await screen.findByTestId('import-library');
    await user.click(await within(library).findByRole('button', { name: 'Add Saved base to compare' }));
    await waitFor(() => expect(useImportScenarios.getState().scenarios).toHaveLength(1));
    await user.click(within(library).getByRole('button', { name: 'Delete Saved base' }));
    await user.click(within(library).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(calls.some((c) => c.init.method === 'DELETE' && c.url.pathname === '/whatif/import/scenarios/saved-1')).toBe(true),
    );
    await waitFor(() => expect(useImportScenarios.getState().scenarios).toEqual([]));
    expect(await within(library).findByTestId('import-library-empty')).toBeInTheDocument();
  });
});
