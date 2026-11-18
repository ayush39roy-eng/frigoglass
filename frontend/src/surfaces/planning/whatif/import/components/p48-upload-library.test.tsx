import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { saveBlob } from '@/lib/download';

import { useImportPlan } from '../import-store';
import type { ImportSimulateRequest, SavedScenario } from '../import-types';
import { useImportScenarios } from '../scenarios-store';
import { P41_RESPONSE, p41Saved, SHA_A, SHA_B } from '../p41-fixtures';
import { PARSE_RESPONSE } from '../test-fixtures';
import { useImportToast } from '../toast-store';
import ImportPlanView from './import-plan-view';
import { UPLOAD_LIBRARY_EMPTY } from './upload-step';

/**
 * P48-T02 (owner 2026-11-18): the saved-scenario library on the Import plan (Excel) upload
 * step, before any file is chosen. Open / Export / Rename / Delete / Add to compare reuse the
 * P41 library; Open and Compare work without a workbook.
 */

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
  if (p === '/whatif/import/simulate') return json(P41_RESPONSE);
  if (p === '/whatif/import/scenarios/compare.xlsx') return xlsxFile('compare.xlsx');
  if (p === '/whatif/import/scenarios' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const all = Object.values(savedById).map(({ request: _r, result: _x, ...summary }) => summary);
    return json({ items: all.slice(offset, offset + limit), total: all.length, limit, offset });
  }
  const exp = /^\/whatif\/import\/scenarios\/([^/]+)\/export\.xlsx$/.exec(p);
  if (exp) return xlsxFile(`${exp[1] ?? ''}.xlsx`);
  const one = /^\/whatif\/import\/scenarios\/([^/]+)$/.exec(p);
  if (one?.[1] && savedById[one[1]]) return json(savedById[one[1]]);
  // The format card's GET falls back to the built-in names on a 404.
  return json({ detail: 'not found' }, 404);
}

const pathsSent = () => calls.map((c) => `${c.init.method ?? 'GET'} ${c.url.pathname}`);
const simulateBodies = () =>
  calls
    .filter((c) => c.url.pathname === '/whatif/import/simulate')
    .map((c) => JSON.parse(String(c.init.body)) as ImportSimulateRequest);

function twoSaved(): Record<string, SavedScenario> {
  // Served newest first: the November import, then an October one someone else saved.
  return {
    'saved-1': p41Saved(),
    'saved-2': p41Saved({
      id: 'saved-2',
      name: 'October plan',
      note: null,
      source_file_name: 'october-plan.xlsx',
      source_file_sha256: SHA_B,
      imported_at: '2026-10-20T09:00:00Z',
      created_by_name: 'Another Planner',
      simulated_week: 42,
      plan_version: 12,
      can_edit: false,
      can_delete: false,
    }),
  };
}

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

async function uploadPanel() {
  expect(screen.getByTestId('import-upload')).toBeInTheDocument();
  return screen.findByTestId('import-upload-library');
}

describe('P48 saved scenarios on the upload step', () => {
  it('lists every visible saved scenario before any file is chosen, grouped by file and date, newest first (axe)', async () => {
    savedById = twoSaved();
    const { container } = renderWithProviders(<ImportPlanView />);
    const panel = await uploadPanel();
    await waitFor(() => expect(within(panel).getAllByTestId('library-card')).toHaveLength(2));
    expect(panel).toHaveTextContent('Saved scenarios (2)');
    expect(within(panel).getAllByTestId('library-group-file').map((g) => g.textContent)).toEqual([
      'synthetic-plan.xlsx',
      'october-plan.xlsx',
    ]);
    // The unfiltered paged list (no sha filter), first page of 50.
    const list = calls.find((c) => c.url.pathname === '/whatif/import/scenarios');
    expect(list?.url.searchParams.has('source_file_sha256')).toBe(false);
    expect([list?.url.searchParams.get('limit'), list?.url.searchParams.get('offset')]).toEqual(['50', '0']);
    // Nothing is parsed or simulated just by showing the panel.
    expect(pathsSent().some((p) => p.endsWith('/parse') || p.endsWith('/simulate'))).toBe(false);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('Open without a file shows the stored result read-only with the saved banner; Back returns; Re-run simulates the stored request', async () => {
    const user = userEvent.setup();
    savedById = twoSaved();
    renderWithProviders(<ImportPlanView />);
    const panel = await uploadPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Open Saved base' }));

    const banner = await screen.findByTestId('import-view-banner');
    expect(banner).toHaveTextContent('Saved scenario — simulated W40 against plan v14');
    expect(screen.getByTestId('import-results')).toBeInTheDocument();
    expect(screen.queryByTestId('import-upload')).toBeNull();
    // No workbook: no Scenario bar (pick / save / export current), no variant builder, no review.
    expect(screen.queryByTestId('import-scenario-bar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to review' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Import steps' })).toBeNull();
    // Opening never simulates: the figures are the stored response.
    expect(simulateBodies()).toHaveLength(0);

    await user.click(within(banner).getByRole('button', { name: 'Back to saved scenarios' }));
    expect(await screen.findByTestId('import-upload-library')).toBeInTheDocument();
    expect(useImportPlan.getState().view).toBeNull();

    // Open again, then re-run on today's plan: the stored request is sent as-is.
    await user.click(await within(screen.getByTestId('import-upload-library')).findByRole('button', { name: 'Open Saved base' }));
    await user.click(await screen.findByRole('button', { name: "Re-run on today's plan" }));
    await waitFor(() => expect(simulateBodies()).toHaveLength(1));
    const sent = simulateBodies()[0];
    expect(sent?.exclude_plan_project_ids).toEqual(['plan-2']);
    expect(sent?.rows).toHaveLength(savedById['saved-1']?.request.rows.length ?? -1);
    // The served re-run becomes the current result, with the Scenario bar to save it.
    expect(await screen.findByTestId('import-scenario-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('import-view-banner')).toBeNull();
    expect(useImportPlan.getState().source?.sha256).toBe(savedById['saved-1']?.source_file_sha256);
    expect(screen.getByRole('button', { name: 'Back to upload' })).toBeInTheDocument();
  });

  it('Add to compare from the upload step: Compare works with saved scenarios only, and exports the comparison', async () => {
    const user = userEvent.setup();
    savedById = twoSaved();
    renderWithProviders(<ImportPlanView />);
    const panel = await uploadPanel();
    expect(within(panel).queryByTestId('library-show-compare')).toBeNull();
    await user.click(await within(panel).findByRole('button', { name: 'Add Saved base to compare' }));
    await within(panel).findByRole('button', { name: 'Remove Saved base from compare' });
    await user.click(within(panel).getByRole('button', { name: 'Add October plan to compare' }));
    const show = await within(panel).findByTestId('library-show-compare');
    expect(show).toHaveTextContent('Compare (2)');
    await user.click(show);

    expect(await screen.findByTestId('import-saved-only')).toBeInTheDocument();
    const kpis = await screen.findByRole('table', { name: 'Scenario figures' });
    expect(within(kpis).getAllByTestId('compare-source-chip').map((c) => c.textContent)).toEqual([
      'synthetic-plan.xlsx',
      'october-plan.xlsx',
    ]);
    expect(screen.getByTestId('compare-clock-banner')).toHaveTextContent('W40');
    expect(screen.queryByTestId('import-session-banner')).toBeNull();
    const exportBtn = screen.getByRole('button', { name: 'Export comparison to Excel (with Gantt charts)' });
    expect(exportBtn).toBeEnabled();
    await user.click(exportBtn);
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.anything(), 'compare.xlsx'));
    const cmp = calls.find((c) => c.url.pathname === '/whatif/import/scenarios/compare.xlsx');
    expect(cmp?.url.searchParams.get('ids')).toBe('saved-1,saved-2');
    expect(simulateBodies()).toHaveLength(0);

    // Opening one from the Compare tab's library shows it read-only; Back to upload works.
    const library = screen.getByTestId('import-library');
    await user.click(await within(library).findByRole('button', { name: 'Open October plan' }));
    expect(await screen.findByTestId('import-view-banner')).toHaveTextContent('Saved scenario — simulated W42 against plan v12');
    await user.click(screen.getByRole('button', { name: 'Back to upload' }));
    expect(await screen.findByTestId('import-upload-library')).toBeInTheDocument();
  });

  it('Export by id for everyone; Rename / Delete only when can_edit; Delete of another person\'s scenario is Super Admin only', async () => {
    const user = userEvent.setup();
    savedById = {
      ...twoSaved(),
      'saved-3': p41Saved({ id: 'saved-3', name: 'Shared by colleague', can_edit: true, can_delete: false }),
    };
    renderWithProviders(<ImportPlanView />, { session: { roles: ['Admin'] } });
    const panel = await uploadPanel();
    await waitFor(() => expect(within(panel).getAllByTestId('library-card')).toHaveLength(3));
    // Own scenario: rename and delete.
    expect(within(panel).getByRole('button', { name: 'Rename Saved base' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: 'Delete Saved base' })).toBeEnabled();
    // Not editable: neither control.
    expect(within(panel).queryByRole('button', { name: 'Rename October plan' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Delete October plan' })).toBeNull();
    // Editable but not deletable (ADR 0058): Delete shown disabled, "Super Admin only".
    const del = within(panel).getByRole('button', { name: 'Delete Shared by colleague' });
    expect(del).toBeDisabled();
    expect(del.closest('[data-super-admin-only]')).toHaveAttribute('title', 'Super Admin only');

    await user.click(within(panel).getByRole('button', { name: 'Export to Excel: October plan (with Gantt chart)' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.anything(), 'saved-2.xlsx'));
  });

  it('delete from the upload step asks first, then the list refreshes to the empty state', async () => {
    const user = userEvent.setup();
    savedById = { 'saved-1': p41Saved() };
    override = (url, init) => {
      if (init.method === 'DELETE' && url.pathname === '/whatif/import/scenarios/saved-1') {
        delete savedById['saved-1'];
        return new Response(null, { status: 204 });
      }
      return undefined;
    };
    renderWithProviders(<ImportPlanView />);
    const panel = await uploadPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Delete Saved base' }));
    await user.click(within(panel).getByRole('button', { name: 'Delete' }));
    expect(await within(panel).findByTestId('import-library-empty')).toHaveTextContent(UPLOAD_LIBRARY_EMPTY);
  });

  it('empty, loading and error states', async () => {
    // Loading: hold the list response.
    let release: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const url = new URL(raw, 'http://localhost');
        calls.push({ url, init });
        if (url.pathname === '/whatif/import/scenarios') return new Promise<Response>((res) => (release = res));
        return Promise.resolve(route(url, init));
      }),
    );
    const first = renderWithProviders(<ImportPlanView />);
    const panel = await uploadPanel();
    expect(panel.querySelector('[aria-busy="true"]')).not.toBeNull();
    release(json({ items: [], total: 0, limit: 50, offset: 0 }));
    expect(await within(panel).findByTestId('import-library-empty')).toHaveTextContent(
      'No saved scenarios yet — import a file, pick projects and Save scenario.',
    );
    first.unmount();

    // Error: a failed list shows plain copy in the panel, and the upload still works.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const url = new URL(raw, 'http://localhost');
        if (url.pathname === '/whatif/import/scenarios') return Promise.resolve(json({ detail: 'nope' }, 500));
        return Promise.resolve(route(url, init));
      }),
    );
    renderWithProviders(<ImportPlanView />);
    const failed = await uploadPanel();
    expect(await within(failed).findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
    expect(screen.getByRole('button', { name: 'Parse file' })).toBeInTheDocument();
  });
});

/**
 * P48-R01 (QA48-2): a workbook parsed but not simulated, then back to Upload. Open / Compare
 * from the panel must not simulate that workbook and must not depend on it.
 */
describe('P48-R01 saved scenarios from the upload step with a parsed, unsimulated workbook', () => {
  function parsedNotSimulated() {
    useImportPlan.setState({
      parsed: PARSE_RESPONSE,
      rows: PARSE_RESPONSE.rows.map((r) => ({ ...r })),
      result: null,
      step: 'upload',
      source: { file_name: 'loaded-plan.xlsx', sha256: SHA_A, imported_at: '2026-11-18T09:00:00Z' },
    });
  }

  it.each([
    ['the workbook would simulate', false],
    ['the workbook would answer 422', true],
  ])('Open from the panel shows the view and sends no simulate (%s)', async (_label, fails) => {
    if (fails)
      override = (url) =>
        url.pathname === '/whatif/import/simulate'
          ? json({ detail: 'unknown engineer id eng-404', code: 'INVALID_IMPORT' }, 422)
          : undefined;
    const user = userEvent.setup();
    savedById = twoSaved();
    parsedNotSimulated();
    renderWithProviders(<ImportPlanView />);
    const panel = await uploadPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Open Saved base' }));

    expect(await screen.findByTestId('import-view-banner')).toHaveTextContent('Saved scenario — simulated W40 against plan v14');
    expect(screen.getByTestId('import-results')).toBeInTheDocument();
    expect(screen.queryByTestId('import-review')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // Give any stray (debounced) effect time to fire: still nothing simulated.
    await new Promise((r) => setTimeout(r, 700));
    expect(simulateBodies()).toHaveLength(0);
    expect(screen.getByTestId('import-view-banner')).toBeInTheDocument();
    // The loaded workbook is still there to go back to.
    expect(screen.getByRole('button', { name: 'Back to review' })).toBeInTheDocument();
  });

  it('Compare from the panel works on saved scenarios only and sends no simulate', async () => {
    const user = userEvent.setup();
    savedById = twoSaved();
    parsedNotSimulated();
    renderWithProviders(<ImportPlanView />);
    const panel = await uploadPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Add Saved base to compare' }));
    await within(panel).findByRole('button', { name: 'Remove Saved base from compare' });
    await user.click(within(panel).getByRole('button', { name: 'Add October plan to compare' }));
    await user.click(await within(panel).findByTestId('library-show-compare'));

    expect(await screen.findByTestId('import-saved-only')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Scenario figures' })).toBeInTheDocument();
    expect(screen.queryByTestId('import-review')).toBeNull();
    await new Promise((r) => setTimeout(r, 700));
    expect(simulateBodies()).toHaveLength(0);
  });

  it('"Re-run on today\'s plan" still simulates the stored request, not the loaded workbook', async () => {
    const user = userEvent.setup();
    savedById = twoSaved();
    parsedNotSimulated();
    renderWithProviders(<ImportPlanView />);
    const panel = await uploadPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Open Saved base' }));
    await user.click(await screen.findByRole('button', { name: "Re-run on today's plan" }));
    await waitFor(() => expect(simulateBodies()).toHaveLength(1));
    expect(simulateBodies()[0]?.exclude_plan_project_ids).toEqual(['plan-2']);
    expect(await screen.findByTestId('import-scenario-bar')).toBeInTheDocument();
    expect(useImportPlan.getState().source?.file_name).toBe('synthetic-plan.xlsx');
  });
});
