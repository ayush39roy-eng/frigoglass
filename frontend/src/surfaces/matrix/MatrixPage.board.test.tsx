/**
 * P21-T05: the Priority board as the Matrix's second tab, end to end against a
 * mocked API (the test plays the server). Asserts the exact requests made and
 * the queries invalidated after each kind of change, so every view re-reads
 * the server after a move, a score edit, a scenario change, a filter, and under
 * a Hub Planner scope.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
  }),
}));
vi.mock('./components/band-distribution-chart', () => ({
  BandDistributionChart: () => <div data-testid="band-chart" />,
}));
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() };
});
vi.mock('@/lib/api/sse', () => ({
  streamSolverProgress: vi.fn(async (id: string) => ({ schedule_run_id: id, status: 'completed' })),
}));
vi.mock('@/lib/use-follow-up-run', () => ({
  useFollowUpRunWatcher: () => ({ start: vi.fn(), watching: false }),
}));

import { ApiError, apiGet, apiSend } from '@/lib/api/client';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createQueryClient } from '@/lib/query-client';
import { useHubFilterStore } from '@/stores/hub-filter';
import { useScenarioStore } from '@/stores/scenario';
import { seriousAxeViolations } from '@/test/axe';
import { ROLE_MATRIX } from '@/test/roles';
import { seedSession } from '@/test/session';
import type { HubName, ProjectCategory, ProjectPriority, ProjectStatus, ProjectType } from '@/types/enums';

import { INITIAL_TEST_DIMENSIONS } from './test-fixtures';
import { useCompareSelection } from './lib/compare-selection';
import MatrixPage from './MatrixPage';

const mockGet = vi.mocked(apiGet);
const mockSend = vi.mocked(apiSend);

// --- the mocked server -------------------------------------------------------------

interface ServerProject {
  id: string;
  name: string;
  hub: HubName;
  hub_id: string;
  category: ProjectCategory;
  type: ProjectType;
  status: ProjectStatus;
  priority: ProjectPriority;
  scores: Record<string, number>;
}
const NON_SCHEDULABLE: ProjectStatus[] = ['Cancelled', 'Commercialized', 'On Hold', 'Draft'];
const all = (n: number) => Object.fromEntries(INITIAL_TEST_DIMENSIONS.map((d) => [d.key, n])) as Record<string, number>;
let projects: ServerProject[] = [];
/** Hub scope of the signed-in user on the "server" (null = every hub). */
let scope: string[] | null = null;

function figures(p: ServerProject) {
  const dims = INITIAL_TEST_DIMENSIONS.map((d) => ({
    key: d.key, label: d.label, pillar: d.pillar, weight: d.weight, max_points: d.weight,
    score: p.scores[d.key] ?? 0, points: ((p.scores[d.key] ?? 0) / 5) * d.weight,
  }));
  const raw = dims.reduce((a, d) => a + d.points, 0);
  const pct = Math.round((raw / 295) * 100);
  const band: ProjectPriority = pct >= 70 ? 'P1' : pct >= 55 ? 'P2' : pct >= 40 ? 'P3' : 'P4';
  return { dims, raw, pct, band };
}
type Query = Record<string, string | undefined>;
function select(q: Query = {}): ServerProject[] {
  return projects.filter(
    (p) =>
      (scope === null || scope.includes(p.hub_id)) &&
      (!q.hub_id || q.hub_id === p.hub_id) &&
      (!q.category || q.category === p.category) &&
      (!q.type || q.type === p.type) &&
      (!q.status_ || q.status_ === p.status) &&
      (!q.q || p.name.toLowerCase().includes(q.q.toLowerCase())),
  );
}
function matrixRows(q: Query) {
  return select(q).map((p, i) => {
    const f = figures(p);
    return {
      project_id: p.id, project_name: p.name, hub: p.hub, category: p.category, type: p.type,
      set_priority: p.priority, status: p.status, leader_name: null, leader_engineer_id: null, rank: i + 1,
      has_score: true, missing_dimension_keys: [], rubric_version: 1, scoring_tags: [], tag_dimension_keys: [], hard_gates: [], weighted_score: f.raw, normalized_pct: f.pct,
      suggested_band: f.band, dimension_scores: f.dims, is_new_model: false, is_rm_saving_project: false,
      currency: 'EUR', capex_keur: null, rm_savings_keur: null, tcogs_eur: null, selling_price_eur: null,
      gross_margin_pct: null,
    };
  });
}
function board(q: Query) {
  const rows = select(q).filter((p) => !NON_SCHEDULABLE.includes(p.status));
  return {
    run_id: 'run-42',
    columns: (['P1', 'P2', 'P3', 'P4', 'Q'] as const).map((priority) => {
      const cards = rows
        .filter((p) => p.priority === priority)
        .map((p) => {
          const f = figures(p);
          return {
            project_id: p.id, name: p.name, hub_id: p.hub_id, hub: p.hub, category: p.category, status: p.status,
            score: f.raw, band: f.band, hard_gated: false, is_vip: false, projected_end_week: 40, within_year: true,
            health: 'on_track', tracking_status: 'live',
          };
        });
      return { priority, count: cards.length, design_weeks: 0, lab_weeks: 0, cards };
    }),
  };
}
function distribution(q: Query) {
  const rows = select(q).map((p) => figures(p));
  return {
    total_projects: rows.length,
    scored_projects: rows.length,
    band_distribution: (['P1', 'P2', 'P3', 'P4', 'Q', 'Unscored'] as const).map((b) => {
      const count = rows.filter((r) => r.band === b).length;
      return { band: b, count, share_pct: rows.length ? Math.round((count * 10000) / rows.length) / 100 : 0 };
    }),
    score_histogram: Array.from({ length: 10 }, (_, i) => ({
      bucket_from: i * 10, bucket_to: i * 10 + 10,
      count: rows.filter((r) => (i === 9 ? r.pct >= 90 : r.pct >= i * 10 && r.pct < i * 10 + 10)).length,
    })),
    capacity_fill_count: 0,
  };
}

function serveGet(path: string, opts?: { query?: Query }): Promise<unknown> {
  const q = opts?.query ?? {};
  if (path === '/priorities') return Promise.resolve(matrixRows(q));
  if (path === '/priorities/distribution') return Promise.resolve(distribution(q));
  if (path === '/priorities/summary') {
    return Promise.resolve({ total_projects: select(q).length, scored_projects: select(q).length, unscored_projects: 0, hard_gate_forced_count: 0, suggested_band_counts: {}, set_priority_counts: {} });
  }
  if (path === '/priority-board') return Promise.resolve(board(q));
  if (path === '/priorities/capacity-fill') {
    return Promise.resolve({ has_active_schedule_run: true, schedule_run_version: 42, hubs: [] });
  }
  if (path === '/currency-rates') return Promise.resolve([{ id: 'eur', currency_code: 'EUR', name: 'Euro', rate_to_eur: 1, configured: true, updated_by_user_id: null, updated_at: '' }]);
  if (path === '/dashboard/projects/facets') return Promise.resolve({ leaders: [], steps: [] });
  if (path === '/hubs') return Promise.resolve([]);
  if (path.startsWith('/schedule-runs/')) {
    return Promise.resolve({ run_id: 'run-43', run_version: 43, against_run_id: 'run-42', against_run_version: 42, hidden_count: 0, rows: [] });
  }
  return Promise.reject(new ApiError(404, `unmocked GET ${path}`));
}

function serveSend(method: string, path: string, body?: unknown): Promise<unknown> {
  const preview = /^\/projects\/([^/]+)\/priority\/preview$/.exec(path);
  if (method === 'POST' && preview) {
    const p = projects.find((x) => x.id === preview[1])!;
    const to = (body as { priority: ProjectPriority }).priority;
    return Promise.resolve({
      result: 'preview', project_id: p.id, from_priority: p.priority, to_priority: to, baseline_run_id: 'run-42',
      preview_token: 'tok-1', moved: { end_week_before: 40, end_week_after: 44, within_year_before: true, within_year_after: true, left_out_before: false, left_out_after: false },
      summary: { affected: 1, delayed: 1, earlier: 0, pushed_out_of_year: 0, pulled_into_year: 0 }, changes: [], hidden_count: 0, elapsed_ms: 3,
    });
  }
  const moveMatch = /^\/projects\/([^/]+)\/priority$/.exec(path);
  if (method === 'POST' && moveMatch) {
    const p = projects.find((x) => x.id === moveMatch[1])!;
    const before = p.priority;
    p.priority = (body as { priority: ProjectPriority }).priority;
    return Promise.resolve({ project_id: p.id, priority_before: before, priority_after: p.priority, recalc_status: 'applied', schedule_run_id: 'run-43', baseline_run_id: 'run-42', task_id: null });
  }
  const put = /^\/priorities\/([^/]+)$/.exec(path);
  if (method === 'PUT' && put) {
    const p = projects.find((x) => x.id === put[1])!;
    // P26: `{scores: {key: value}, hard_gates}`; omitted keys keep their value.
    const b = body as { scores: Record<string, number>; hard_gates: string[] };
    p.scores = { ...p.scores, ...b.scores };
    const f = figures(p);
    return Promise.resolve({
      id: 's', project_id: p.id, hard_gates: b.hard_gates, weighted_score: f.raw, normalized_pct: f.pct, suggested_band: f.band,
      dimension_scores: f.dims, missing_dimension_keys: [], rubric_version: 1,
    });
  }
  return Promise.reject(new ApiError(405, `unmocked ${method} ${path}`));
}

// --- render ---------------------------------------------------------------------------

function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

function renderMatrix(path: string, session: Parameters<typeof seedSession>[0] = {}) {
  seedSession(session);
  const client = createQueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <ThemeProvider defaultPreference="light">
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <TooltipProvider>
            <MatrixPage />
            <LocationProbe />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { client, invalidate };
}

const getCalls = (path: string) => mockGet.mock.calls.filter((c) => c[0] === path);
const lastQuery = (path: string) => (getCalls(path).at(-1)?.[1] as { query?: Query } | undefined)?.query ?? {};
const invalidatedRoots = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey?: unknown[] } | undefined)?.queryKey ?? null));
const boardTotal = () =>
  screen.getAllByTestId('board-column-count').reduce((a, el) => a + Number(el.textContent?.replace(/\D/g, '') ?? 0), 0);
const gridCount = () => Number(/\d+/.exec(screen.getByTestId('matrix-row-count').textContent ?? '')?.[0] ?? NaN);
function boardCard(name: string): HTMLElement {
  const el = screen.getByRole('link', { name, hidden: true }).closest<HTMLElement>('[data-testid="board-card"]');
  if (!el) throw new Error(name);
  return el;
}
function column(p: ProjectPriority): HTMLElement {
  return screen.getAllByTestId('board-column').find((c) => c.getAttribute('data-priority') === p)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  scope = null;
  projects = [
    { id: 'alpha', name: 'Alpha Cooler', hub: 'R&D-Greece', hub_id: 'hub-gr', category: 'A', type: 'NM', status: 'In Development', priority: 'P1', scores: all(4) },
    { id: 'beta', name: 'Beta Freezer', hub: 'PD-India', hub_id: 'hub-in', category: 'B', type: 'NM', status: 'In Development', priority: 'P2', scores: all(3) },
    { id: 'gamma', name: 'Gamma Chest', hub: 'PD-India', hub_id: 'hub-in', category: 'A', type: 'CO', status: 'In Queue', priority: 'P3', scores: all(2) },
    { id: 'delta', name: 'Delta Retired', hub: 'R&D-Greece', hub_id: 'hub-gr', category: 'A', type: 'NM', status: 'Cancelled', priority: 'P4', scores: all(1) },
  ];
  useHubFilterStore.setState({ hubId: null, region: null });
  useScenarioStore.setState({ active: false, notes: '', pending: {}, past: [], future: [] });
  useCompareSelection.setState({ items: [], capHit: false });
  mockGet.mockImplementation((path: string, opts?: unknown) => serveGet(path, opts as { query?: Query }));
  mockSend.mockImplementation((method: string, path: string, body?: unknown) => serveSend(method, path, body));
});

describe('P21-T05 Matrix tabs', () => {
  it('?view=board opens the board tab; the tablist is keyboard operable and the URL follows the tab', async () => {
    const user = userEvent.setup();
    renderMatrix('/matrix?view=board');
    const tabs = await screen.findByRole('tablist', { name: 'Prioritization views' });
    const boardTab = within(tabs).getByRole('tab', { name: 'Priority board' });
    expect(boardTab).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    // Board tab: no currency, no charts, no compare.
    // The currency control keeps its place (no layout jump) but is hidden: inside the grid-only wrapper.
    const currency = screen.queryByRole('radiogroup', { name: 'Display currency', hidden: true });
    expect(currency === null || currency.closest('[data-grid-only="hidden"]') !== null).toBe(true);
    expect(screen.queryByRole('button', { name: /Download/, hidden: true })?.closest('[data-grid-only="hidden"]')).not.toBeNull();
    expect(screen.queryByTestId('band-chart')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /to compare$/ })).not.toBeInTheDocument();
    // The board's toolbar sits in the View panel (the space the grid-only controls keep), and the
    // board has the grid's offset height with headers outside the scrolling column bodies.
    expect(within(screen.getByTestId('matrix-view-panel')).getByTestId('board-toolbar')).toHaveAttribute('data-in-panel', 'true');
    expect(screen.getByTestId('priority-board')).toHaveAttribute('data-fit', 'true');
    for (const col of screen.getAllByTestId('board-column')) {
      expect(within(col).getByTestId('board-column-body')).not.toContainElement(within(col).getByTestId('board-column-header'));
    }

    boardTab.focus();
    await user.keyboard('{ArrowLeft}');
    const gridTab = within(tabs).getByRole('tab', { name: 'Scoring grid' });
    await waitFor(() => expect(gridTab).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/matrix$/);
    expect(await screen.findByRole('radiogroup', { name: 'Display currency' })).toBeInTheDocument();
    await user.click(boardTab);
    expect(screen.getByTestId('location')).toHaveTextContent('/matrix?view=board');
  });

  it('a: a keyboard move on the board previews, confirms, and re-reads the grid, the distribution, the board and the run views', async () => {
    const user = userEvent.setup();
    const { invalidate } = renderMatrix('/matrix?view=board', { permissions: ROLE_MATRIX['Hub Planner'] });
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    const gridBefore = getCalls('/priorities').length;
    const distBefore = getCalls('/priorities/distribution').length;
    const boardBefore = getCalls('/priority-board').length;

    const handle = within(boardCard('Alpha Cooler')).getByTestId('board-drag-handle');
    handle.focus();
    await user.keyboard(' {ArrowRight} ');
    const dialog = await screen.findByRole('dialog', { name: 'Move to P2?' });
    expect(mockSend).toHaveBeenCalledWith('POST', '/projects/alpha/priority/preview', { priority: 'P2' }, expect.anything());
    const yes = within(dialog).getByRole('button', { name: 'Yes, apply' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(mockSend).toHaveBeenCalledWith('POST', '/projects/alpha/priority', { priority: 'P2', preview_token: 'tok-1' });

    await waitFor(() => expect(getCalls('/priority-board').length).toBeGreaterThan(boardBefore));
    await waitFor(() => expect(getCalls('/priorities').length).toBeGreaterThan(gridBefore));
    await waitFor(() => expect(getCalls('/priorities/distribution').length).toBeGreaterThan(distBefore));
    const roots = invalidatedRoots(invalidate);
    for (const key of ['priority-matrix', 'priority-board', 'dashboard', 'capacity', 'gantt', 'projects', 'vip-board']) {
      expect(roots).toContain(JSON.stringify([key]));
    }
    const done = screen.queryByRole('button', { name: 'Done' });
    if (done) await user.click(done);
    await waitFor(() => expect(within(column('P2')).getByRole('link', { name: 'Alpha Cooler', hidden: true })).toBeInTheDocument());
    // The grid's served set priority is P2 now.
    const rows = (await mockGet.mock.results.filter((_, i) => mockGet.mock.calls[i]?.[0] === '/priorities').at(-1)?.value) as { project_id: string; set_priority: string }[];
    expect(rows.find((r) => r.project_id === 'alpha')?.set_priority).toBe('P2');
  });

  it('b: a score save from the grid re-reads the grid, the distribution and (on the board) the card score and band', async () => {
    const user = userEvent.setup();
    const { invalidate } = renderMatrix('/matrix');
    await user.click(await screen.findByRole('button', { name: 'Edit prioritization score for Alpha Cooler' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit prioritization score' });
    const distBefore = getCalls('/priorities/distribution').length;
    for (const d of INITIAL_TEST_DIMENSIONS) {
      await user.selectOptions(within(dialog).getByLabelText(d.label), '1');
    }
    await user.click(within(dialog).getByRole('button', { name: 'Save score' }));
    expect(mockSend).toHaveBeenCalledWith('PUT', '/priorities/alpha', { scores: all(1), hard_gates: [] });
    await waitFor(() => expect(getCalls('/priorities/distribution').length).toBeGreaterThan(distBefore));
    const roots = invalidatedRoots(invalidate);
    expect(roots).toContain(JSON.stringify(['priority-matrix']));
    expect(roots).toContain(JSON.stringify(['priority-board']));
    expect(roots).toContain(JSON.stringify(['projects', 'workspace', 'alpha']));
    // Score /100 in the grid is the server's 20/100 now (all 1s → 59/295).
    await waitFor(() => expect(screen.getAllByText('20/100').length).toBeGreaterThan(0));

    await user.click(screen.getByRole('tab', { name: 'Priority board' }));
    const card = within(boardCard('Alpha Cooler'));
    await waitFor(() => expect(card.getByTestId('board-card-score')).toHaveTextContent('59'));
    expect(within(card.getByTestId('board-card-band')).getByTitle(/Priority band P4/)).toBeInTheDocument();
    // Thirteen typed inputs: allow for a loaded runner.
  }, 20_000);

  it('c: a scenario edit shows on both views with the Scenario badge, commits nothing, and Discard restores both', async () => {
    const user = userEvent.setup();
    renderMatrix('/matrix');
    await user.click(await screen.findByRole('checkbox', { name: 'Scenario mode' }));
    await user.click(await screen.findByRole('button', { name: 'Edit prioritization score for Alpha Cooler' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stage prioritization score change' });
    await user.selectOptions(within(dialog).getByLabelText('Strategic Project'), '1');
    await user.click(within(dialog).getByRole('button', { name: 'Stage change' }));
    expect(useScenarioStore.getState().pending.alpha?.next.scores.strategic_project).toBe(1);

    await user.click(screen.getByRole('tab', { name: 'Priority board' }));
    expect(await screen.findByTestId('board-scenario-note')).toHaveTextContent('Scenario');
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(within(boardCard('Alpha Cooler')).getByTestId('board-card-staged')).toBeInTheDocument();
    expect(within(boardCard('Beta Freezer')).queryByTestId('board-card-staged')).not.toBeInTheDocument();
    // Served score unchanged: nothing was written.
    expect(within(boardCard('Alpha Cooler')).getByTestId('board-card-score')).toHaveTextContent('236');
    expect(mockSend).not.toHaveBeenCalled();

    await user.click(within(screen.getByTestId('scenario-panel')).getByRole('button', { name: 'Discard' }));
    expect(within(boardCard('Alpha Cooler')).queryByTestId('board-card-staged')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Scoring grid' }));
    expect(useScenarioStore.getState().pending).toEqual({});
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('d: the View panel filters apply to both views; for schedulable statuses the board total equals the grid count', async () => {
    const user = userEvent.setup();
    renderMatrix('/matrix');
    await screen.findByRole('button', { name: 'Edit prioritization score for Alpha Cooler' });
    await user.click(within(screen.getByRole('radiogroup', { name: 'Status' })).getByRole('radio', { name: 'In Development' }));
    await waitFor(() => expect(lastQuery('/priorities')).toMatchObject({ status_: 'In Development' }));
    await waitFor(() => expect(gridCount()).toBe(2));
    const grid = gridCount();

    await user.click(screen.getByRole('tab', { name: 'Priority board' }));
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(lastQuery('/priority-board')).toMatchObject({ status_: 'In Development' });
    expect(boardTotal()).toBe(grid);

    // Category B narrows both.
    await user.click(within(screen.getByRole('radiogroup', { name: 'Cat' })).getByRole('radio', { name: 'B' }));
    await waitFor(() => expect(lastQuery('/priority-board')).toMatchObject({ status_: 'In Development', category: 'B' }));
    await waitFor(() => expect(boardTotal()).toBe(1));
    expect(lastQuery('/priorities')).toMatchObject({ status_: 'In Development', category: 'B' });
    // The shared search reaches the board as q.
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'beta');
    await waitFor(() => expect(lastQuery('/priority-board')).toMatchObject({ q: 'beta' }));
    await waitFor(() => expect(lastQuery('/priorities')).toMatchObject({ q: 'beta' }));
    // The board explains why an unfiltered total can be lower than the grid's.
    expect(screen.getByTestId('board-scope-note')).toHaveTextContent('Cancelled, Commercialized and On Hold projects appear in the scoring grid only');
  });

  it('e: a Hub Planner sees only own-hub projects in both views', async () => {
    const user = userEvent.setup();
    scope = ['hub-in'];
    renderMatrix('/matrix', { roles: ['Hub Planner'], hub_scope_all: false, hub_ids: ['hub-in'], permissions: ROLE_MATRIX['Hub Planner'] });
    await screen.findByRole('link', { name: 'Beta Freezer' });
    expect(screen.queryByRole('link', { name: 'Alpha Cooler' })).not.toBeInTheDocument();
    expect(gridCount()).toBe(2);
    await user.click(screen.getByRole('tab', { name: 'Priority board' }));
    await screen.findByRole('link', { name: 'Beta Freezer' });
    expect(screen.getByRole('link', { name: 'Gamma Chest' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Alpha Cooler' })).not.toBeInTheDocument();
    expect(boardTotal()).toBe(2);
    expect(screen.getAllByTestId('board-card').every((c) => c.textContent?.includes('PD-India'))).toBe(true);
  });

  it('?view=board&layout=list opens the list layout; the grid tab drops the layout param', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    renderMatrix('/matrix?view=board&layout=list');
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(screen.getByTestId('priority-board')).toHaveAttribute('data-layout', 'list');
    expect(screen.getAllByTestId('board-list-row')).toHaveLength(3);
    await user.click(screen.getByRole('tab', { name: 'Scoring grid' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/matrix$/);
    await user.click(screen.getByRole('tab', { name: 'Priority board' }));
    // A layout that only came from the URL is not stored, so the board reopens in the default Cards.
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(screen.getByTestId('priority-board')).toHaveAttribute('data-layout', 'cards');
  });

  it('has no serious or critical axe violations on either tab', async () => {
    const user = userEvent.setup();
    const container = document.body;
    renderMatrix('/matrix');
    await screen.findByRole('button', { name: 'Edit prioritization score for Alpha Cooler' });
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(screen.getByRole('tab', { name: 'Priority board' }));
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(await seriousAxeViolations(container)).toEqual([]);
    // Two whole-page axe runs: allow for a loaded runner.
  }, 30_000);
});
