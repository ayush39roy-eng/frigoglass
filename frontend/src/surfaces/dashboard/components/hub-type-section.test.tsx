import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { HubName, LabRegion, ProjectType } from '@/types/enums';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 40, size: 40 })),
    measureElement: () => undefined,
  }),
}));

const client = { apiGet: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: (...a: unknown[]) => client.apiGet(...a) };
});

import type {
  CompletingWithinYear,
  CompletingWithinYearRow,
  DashboardAnalytics,
  HubTypePipelineRow,
  ProjectFilterRow,
} from '../api/types';
import { HubTypeSection } from './hub-type-section';

/* ------------------------- one fixture, every payload ------------------------ */

const HUBS = [
  { id: 'h-pdin', name: 'PD-India' as HubName, lab_region: 'India' as LabRegion, is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-gr', name: 'R&D-Greece' as HubName, lab_region: 'Greece' as LabRegion, is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
];

interface P {
  id: string;
  hub: HubName;
  type: ProjectType | null;
  within: boolean;
  blocked?: boolean;
  inRun?: boolean;
}
const PROJECTS: P[] = [
  { id: 'a', hub: 'PD-India', type: 'NM', within: true },
  { id: 'b', hub: 'PD-India', type: 'NM', within: true },
  { id: 'c', hub: 'PD-India', type: 'NM', within: false },
  // within_year AND blocked: counted as blocked, never as completing (P9-F02).
  { id: 'd', hub: 'PD-India', type: 'NM', within: true, blocked: true },
  { id: 'e', hub: 'PD-India', type: 'CO', within: true },
  { id: 'f', hub: 'PD-India', type: null, within: true },
  { id: 'g', hub: 'R&D-Greece', type: 'NM', within: true },
  { id: 'h', hub: 'R&D-Greece', type: 'CO', within: false, inRun: false },
];
const regionOf = (hub: HubName): LabRegion => HUBS.find((h) => h.name === hub)!.lab_region;
const completes = (p: P) => p.inRun !== false && p.within && !p.blocked;

function registerRow(p: P): ProjectFilterRow {
  return {
    project_id: p.id,
    project_name: `Project ${p.id}`,
    hub: p.hub,
    category: 'B',
    status: 'In Development',
    priority: 'P2',
    is_vip: false,
    tracking_status: 'idle',
    external_code: null,
    type: p.type,
    region: regionOf(p.hub),
    leader_name: null,
    leader_engineer_id: null,
    current_step_code: null,
    current_step_name: null,
    end_week: 40,
    outcome: null,
    reg_year: 2026,
    carry_over: false,
    priority_rank: null,
    plant: null,
    requesting_department: null,
    product_type: null,
  };
}

function runRow(p: P): CompletingWithinYearRow {
  return {
    project_id: p.id,
    project_name: `Project ${p.id}`,
    hub: p.hub,
    category: 'B',
    priority: 'P2',
    within_year: p.within,
    spillover: !p.within,
    left_out: false,
    blocked: p.blocked ?? false,
    cat_not_allowed: false,
    last_step_end_week: p.within ? 40 : 60,
    type: p.type,
    status: 'In Development',
    not_started: false,
  };
}

/** Builds every served payload from `scope` (what the server would do). */
function payloads(scope: P[]) {
  const key = (p: P) => `${p.hub}::${p.type ?? 'null'}`;
  const cells = new Map<string, P[]>();
  for (const p of scope) cells.set(key(p), [...(cells.get(key(p)) ?? []), p]);
  const hubType: HubTypePipelineRow[] = [...cells.values()].map((ps) => ({ hub: ps[0]!.hub, type: ps[0]!.type, count: ps.length }));
  const count = (f: (p: P) => boolean) => scope.filter(f).length;
  const hubs = [...new Set(scope.map((p) => p.hub))];
  const types = ['NM', 'CO', 'Unmapped'] as const;
  const tk = (p: P) => p.type ?? 'Unmapped';
  const analytics: DashboardAnalytics = {
    by_type: types.map((t) => ({ key: t, count: count((p) => tk(p) === t), share_pct: 0 })),
    by_category: [],
    by_hub: hubs.map((h) => ({ key: h, count: count((p) => p.hub === h), share_pct: 0 })),
    by_reg_year: [],
    completing_hub_type: [...cells.values()].map((ps) => ({
      hub: ps[0]!.hub,
      type: ps[0]!.type,
      pipeline_count: ps.length,
      completing_count: ps.filter(completes).length,
      completing_pct: 0,
    })),
    completing_by_type: types.map((t) => ({
      key: t,
      pipeline_count: count((p) => tk(p) === t),
      completing_count: count((p) => tk(p) === t && completes(p)),
      completing_pct: 0,
    })),
    completing_by_hub: hubs.map((h) => ({
      key: h,
      pipeline_count: count((p) => p.hub === h),
      completing_count: count((p) => p.hub === h && completes(p)),
      completing_pct: 0,
    })),
    has_active_schedule_run: true,
  };
  const inRun = scope.filter((p) => p.inRun !== false);
  const withinYear: CompletingWithinYear = {
    has_active_schedule_run: true,
    schedule_run_version: 3,
    within_year_count: count(completes),
    spillover_count: 0,
    left_out_count: 0,
    blocked_count: 0,
    priority_delivery: [],
    rows: inRun.map(runRow),
  };
  return { hubType, analytics, withinYear, total: scope.length };
}

function ok<T>(data: T): UseQueryResult<T> {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() } as unknown as UseQueryResult<T>;
}

/** A fake `GET /dashboard/projects`: ANDs `hub_id`, `region` and `type`, like the server
 *  (`type=Unmapped` = no type, P17-R09). */
function fakeServer(path: string, opts?: { query?: Record<string, string | undefined> }) {
  if (path === '/hubs') return Promise.resolve(HUBS);
  if (path === '/dashboard/projects') {
    const q = opts?.query ?? {};
    const hubName = q.hub_id ? HUBS.find((h) => h.id === q.hub_id)?.name : undefined;
    const rows = PROJECTS.filter(
      (p) =>
        (!q.hub_id || p.hub === hubName) &&
        (!q.region || regionOf(p.hub) === q.region) &&
        (!q.type || (q.type === 'Unmapped' ? p.type === null : p.type === q.type)),
    ).map(registerRow);
    return Promise.resolve({ total_count: rows.length, rows });
  }
  return Promise.reject(new Error(`unexpected GET ${path}`));
}

function renderSection(scope: P[] = PROJECTS, hubId: string | null = null, region: LabRegion | null = null) {
  const d = payloads(scope);
  return renderWithProviders(
    <HubTypeSection
      hubTypePipeline={ok(d.hubType)}
      analytics={ok(d.analytics)}
      withinYear={d.withinYear}
      pipelineTotal={d.total}
      hubId={hubId}
      region={region}
    />,
  );
}

async function openAndCount(name: string): Promise<{ cell: number; list: number; dialog: HTMLElement }> {
  const btn = screen.getByRole('button', { name });
  await userEvent.click(btn);
  const dialog = await screen.findByTestId('hub-type-drilldown');
  const count = await within(dialog).findByTestId('drilldown-count');
  const list = Number(count.getAttribute('data-count'));
  expect(within(dialog).getAllByRole('row')).toHaveLength(list + 1); // + header row
  return { cell: Number(btn.textContent), list, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.apiGet.mockImplementation(fakeServer);
});

describe('HubTypeSection drill-down (P17-R08)', () => {
  it('pipeline cell: list count equals the cell count (server filters hub_id + type)', async () => {
    renderSection();
    const r = await openAndCount('View 4 New Model projects in PD-India');
    expect(r.list).toBe(r.cell);
    expect(r.list).toBe(4);
    expect(client.apiGet).toHaveBeenCalledWith('/dashboard/projects', expect.objectContaining({ query: expect.objectContaining({ hub_id: 'h-pdin', type: 'NM' }) }));
    expect(within(r.dialog).getByRole('heading', { name: 'New Model · PD-India' })).toBeInTheDocument();
    expect(within(r.dialog).queryByTestId('drilldown-mismatch')).not.toBeInTheDocument();
  });

  it('completing cell: within_year AND NOT blocked only, count equals the cell', async () => {
    renderSection();
    const r = await openAndCount('View 2 New Model projects in PD-India completing within the year');
    expect(r.list).toBe(r.cell);
    expect(within(r.dialog).getByText('Project a')).toBeInTheDocument();
    expect(within(r.dialog).queryByText('Project d')).not.toBeInTheDocument(); // blocked
    expect(within(r.dialog).queryByText('Project c')).not.toBeInTheDocument(); // spillover
    expect(within(r.dialog).getAllByText('W40').length).toBe(2);
    expect(within(r.dialog).getAllByText('Within year').length).toBe(2);
  });

  it('row total (pipeline) and grand total (both tables) match their lists', async () => {
    renderSection();
    let r = await openAndCount('View all 6 projects in PD-India');
    expect(r.list).toBe(r.cell);
    await userEvent.keyboard('{Escape}');
    r = await openAndCount('View all 8 projects');
    expect(r.list).toBe(r.cell);
    await userEvent.keyboard('{Escape}');
    r = await openAndCount('View all 5 projects completing within the year');
    expect(r.list).toBe(r.cell);
    await userEvent.keyboard('{Escape}');
    r = await openAndCount('View all 1 untyped project completing within the year');
    expect(r.list).toBe(1);
  });

  it('P17-R09: untyped pipeline cell and column total ask the server for type=Unmapped', async () => {
    renderSection();
    let r = await openAndCount('View 1 untyped project in PD-India');
    expect(r.list).toBe(r.cell);
    expect(r.list).toBe(1);
    expect(client.apiGet).toHaveBeenLastCalledWith('/dashboard/projects', expect.objectContaining({ query: expect.objectContaining({ hub_id: 'h-pdin', type: 'Unmapped' }) }));
    expect(within(r.dialog).getByText('Project f')).toBeInTheDocument();
    expect(within(r.dialog).queryByTestId('drilldown-mismatch')).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    r = await openAndCount('View all 1 untyped project');
    expect(r.list).toBe(r.cell);
    expect(client.apiGet).toHaveBeenLastCalledWith('/dashboard/projects', expect.objectContaining({ query: expect.objectContaining({ type: 'Unmapped' }) }));
  });

  it('hub-filtered: passes the global filter and the lists still match the cells', async () => {
    const scope = PROJECTS.filter((p) => p.hub === 'R&D-Greece');
    renderSection(scope, 'h-gr');
    const r = await openAndCount('View all 2 projects');
    expect(r.list).toBe(r.cell);
    expect(client.apiGet).toHaveBeenLastCalledWith('/dashboard/projects', expect.objectContaining({ query: expect.objectContaining({ hub_id: 'h-gr' }) }));
    await userEvent.keyboard('{Escape}');
    const c = await openAndCount('View all 1 project completing within the year');
    expect(c.list).toBe(c.cell);
  });

  it('country-filtered: sends region with the cell hub', async () => {
    renderSection(PROJECTS.filter((p) => p.hub === 'PD-India'), null, 'India');
    const r = await openAndCount('View 1 Cost Optimization project in PD-India');
    expect(r.list).toBe(1);
    expect(client.apiGet).toHaveBeenLastCalledWith('/dashboard/projects', expect.objectContaining({ query: expect.objectContaining({ hub_id: 'h-pdin', region: 'India', type: 'CO' }) }));
  });

  it('returns focus to the clicked figure on close, shows no financial fields, and is axe-clean', async () => {
    renderSection();
    const btn = screen.getByRole('button', { name: 'View 4 New Model projects in PD-India' });
    const r = await openAndCount('View 4 New Model projects in PD-India');
    const headers = within(r.dialog).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Project', 'Hub', 'Type', 'Cat', 'Priority', 'Status']);
    expect(r.dialog.textContent).not.toMatch(/TCOGS|margin|selling price|customer/i);
    expect(await seriousAxeViolations(r.dialog)).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('hub-type-drilldown')).not.toBeInTheDocument());
    expect(btn).toHaveFocus();
  });

  it('flags a list that disagrees with the clicked figure instead of hiding it', async () => {
    renderSection();
    // The server now returns one project fewer than the table showed.
    client.apiGet.mockImplementation((path: string, opts?: { query?: Record<string, string | undefined> }) =>
      path === '/dashboard/projects'
        ? (fakeServer(path, opts) as Promise<{ total_count: number; rows: ProjectFilterRow[] }>).then((r) => ({ total_count: r.total_count - 1, rows: r.rows.slice(1) }))
        : fakeServer(path, opts),
    );
    const r = await openAndCount('View 4 New Model projects in PD-India');
    expect(r.list).toBe(3);
    expect(within(r.dialog).getByTestId('drilldown-mismatch')).toHaveTextContent('This list has 3 projects but the table shows 4');
  });
});
