import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { ApiError } from '@/lib/api/client';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { ROLE_MATRIX } from '@/test/roles';
import { makeMe } from '@/test/session';
import { useHubFilterStore } from '@/stores/hub-filter';
import { visibleNavGroups } from '@/app/nav-visibility';
import type { GanttProjectRow, GanttResponse, GanttStepRow } from '@/surfaces/gantt/api/types';
import { P13_GANTT_ROW_DEFAULTS } from '@/surfaces/gantt/test-fixtures';
import type { RoleName, WorkflowStepKind } from '@/types/enums';

// Deterministic virtualization: render every visual row.
const virt = { scrollToIndex: vi.fn() };
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
    scrollToIndex: (...a: unknown[]) => virt.scrollToIndex(...a),
  }),
}));

const api = { fetchGantt: vi.fn() };
vi.mock('@/surfaces/gantt/api/gantt-api', async () => {
  const actual = await vi.importActual<typeof import('@/surfaces/gantt/api/gantt-api')>('@/surfaces/gantt/api/gantt-api');
  return {
    ...actual,
    fetchGantt: (...a: unknown[]) => api.fetchGantt(...a),
  };
});
const dash = { fetchDashboardProjects: vi.fn() };
vi.mock('@/surfaces/dashboard/api/dashboard-api', async () => {
  const actual = await vi.importActual<typeof import('@/surfaces/dashboard/api/dashboard-api')>(
    '@/surfaces/dashboard/api/dashboard-api',
  );
  return { ...actual, fetchDashboardProjects: (...a: unknown[]) => dash.fetchDashboardProjects(...a) };
});
const wsApi = { fetchWorkspace: vi.fn() };
vi.mock('@/surfaces/project-workspace/api/workspace-api', async () => {
  const actual = await vi.importActual<typeof import('@/surfaces/project-workspace/api/workspace-api')>(
    '@/surfaces/project-workspace/api/workspace-api',
  );
  return { ...actual, fetchWorkspace: (...a: unknown[]) => wsApi.fetchWorkspace(...a) };
});
// The template tab's own reads (only mounted when that tab is open).
vi.mock('../../hooks/use-workflow-settings', () => ({
  useWorkflowSettings: () => ({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() }),
  useSaveSteps: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveLeadTimes: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveHubCalendar: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveChamber: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCategoryTimelines: () => ({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() }),
  useBEquivalent: () => ({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() }),
}));

import WorkflowSettingsPage from '../../WorkflowSettingsPage';
import { stage, workspaceFixture } from '@/surfaces/project-workspace/test-fixtures';
import type { WorkspaceResponse } from '@/surfaces/project-workspace/api/types';
import { GanttWeekAxis } from '@/surfaces/gantt/components/gantt-time-axis';
import { render } from '@testing-library/react';

const LETTERS = 'ABCDEFGHIJKLMN';
const KINDS: WorkflowStepKind[] = ['design', 'design', 'elapsed', 'design', 'design', 'lab', 'design', 'elapsed', 'lab', 'design', 'design', 'lab', 'design', 'elapsed'];

/** 14 one-week steps in a chain, step i at W(41 + i). */
function steps(over: (i: number) => Partial<GanttStepRow> = () => ({})): GanttStepRow[] {
  return Array.from(LETTERS).map((letter, idx) => {
    const i = idx + 1;
    const week = 41 + i;
    return {
      step_id: `PDD-${letter}`,
      step_name: `Step ${letter}`,
      kind: KINDS[idx] ?? 'design',
      sequence_order: i,
      skipped: false,
      status: 'Not Started',
      percent_complete: 0,
      duration_weeks: 1,
      planned_start_week: week,
      planned_end_week: week,
      actual_start_week: null,
      actual_end_week: null,
      assigned_engineer_name: null,
      assigned_chamber_code: null,
      eng_conflict: false,
      chamber_overlap: false,
      lead_time_weeks: 1,
      effort_weeks: null,
      plan_weeks: 1,
      gap_weeks: 0,
      own_effort: false,
      span_fte: null,
      predecessor_ids: idx === 0 ? [] : [`PDD-${LETTERS[idx - 1] ?? 'A'}`],
      ...over(i),
    };
  });
}

function row(over: Partial<GanttProjectRow> = {}): GanttProjectRow {
  return {
    project_id: 'p1',
    project_name: 'Cooler Alpha',
    hub: 'R&D-Greece',
    category: 'A',
    priority: 'P1',
    frozen: false,
    delay_weeks: 0,
    left_out: false,
    spillover: false,
    cat_not_allowed: false,
    target_end_week: null,
    expected_end_week: 55,
    projected_end_week: 55,
    unconstrained_end_week: 55,
    slip_weeks: 0,
    blocked: false,
    schedule_stale: false,
    workflow_id: 'PDD',
    is_vip: false,
    tracking_status: 'idle',
    ...P13_GANTT_ROW_DEFAULTS,
    steps: steps(),
    ...over,
  };
}

function gantt(rows: GanttProjectRow[]): GanttResponse {
  return { has_active_schedule_run: true, schedule_run_version: 7, total_count: rows.length, rows, weekly_active_counts: [] };
}

const PROJECTS = [
  { project_id: 'p1', project_name: 'Cooler Alpha', external_code: '24-001', hub: 'R&D-Greece', status: 'In Development', priority: 'P1' },
  { project_id: 'p2', project_name: 'Frameless Door E-47', external_code: null, hub: 'R&D-Greece', status: 'In Queue', priority: 'P1' },
  { project_id: 'p3', project_name: 'Freezer Beta', external_code: null, hub: 'PD-India', status: 'On Hold', priority: 'P3' },
];

/** p1 fully placed (14 steps W42–W55); p2 left out (no served steps); p3 placed, another hub. */
let rowsServed: GanttProjectRow[] = [];
function defaultRows(): GanttProjectRow[] {
  return [
    row({ leader_engineer_id: 'eng-1', external_code: '24-001' }),
    row({ project_id: 'p2', project_name: 'Frameless Door E-47', left_out: true, projected_end_week: null, expected_end_week: 63, leader_engineer_id: 'eng-1', steps: [] }),
    row({ project_id: 'p3', project_name: 'Freezer Beta', hub: 'PD-India', priority: 'P3', leader_engineer_id: 'eng-2', steps: steps() }),
  ];
}

/** A workspace payload for p2 with all 14 stages (PDD-C skipped, none placed). */
function workspace(project: Partial<WorkspaceResponse['project']> = {}) {
  const base = workspaceFixture();
  return {
    ...base,
    project: { ...base.project, id: 'p2', status: 'In Queue' as const, frozen: false, ...project },
    stages: Array.from({ length: 14 }, (_, i) => stage(i, { planned_start_week: null, planned_end_week: null, skipped: i === 2 })),
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

function renderPage(route = '/settings/workflow', role?: RoleName) {
  return renderWithProviders(
    <>
      <WorkflowSettingsPage />
      <LocationProbe />
    </>,
    { route, ...(role ? { session: { roles: [role], permissions: ROLE_MATRIX[role] } } : {}) },
  );
}

function projectRows(): HTMLElement[] {
  return screen.getAllByTestId('gantt-project-row');
}
function stepRows(projectId: string): HTMLElement[] {
  return screen.getAllByTestId('gantt-step-row').filter((r) => r.getAttribute('data-project-id') === projectId);
}
function stepRow(projectId: string, sequence: number): HTMLElement {
  const el = stepRows(projectId)[sequence - 1];
  if (!el) throw new Error(`no step ${String(sequence)} of ${projectId}`);
  return el;
}
async function expand(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Expand steps for ${name}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null, region: null });
  rowsServed = defaultRows();
  api.fetchGantt.mockImplementation(() => Promise.resolve(gantt(rowsServed)));
  dash.fetchDashboardProjects.mockResolvedValue({ total_count: PROJECTS.length, rows: PROJECTS });
  wsApi.fetchWorkspace.mockResolvedValue(workspace());
});

describe('Workflow page — Project step timing: every project as a timeline (P32-R04)', () => {
  it('is the first tab and lists every project in scope, collapsed, with status and a Not placed badge', async () => {
    renderPage();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Project step timing', 'Workflow templates']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(projectRows()).toHaveLength(3));
    expect(screen.queryAllByTestId('gantt-step-row')).toHaveLength(0);
    expect(screen.getByTestId('step-timing-count')).toHaveTextContent('3 of 3 projects shown');
    expect(api.fetchGantt).toHaveBeenCalledWith({ hubId: undefined, region: undefined, priority: undefined }, expect.anything());
    const badges = await screen.findAllByTestId('step-timing-not-placed');
    expect(badges).toHaveLength(1);
    expect(projectRows()[1]).toContainElement(badges[0]!);
    expect(badges[0]).toHaveTextContent('Not placed');
    expect(badges[0]).toHaveAttribute('title', expect.stringContaining('usually engineer or chamber capacity'));
    expect(await within(projectRows()[2]!).findByText('On Hold')).toBeInTheDocument();
    // Fully placed projects need no workspace read; a collapsed left-out one neither.
    expect(wsApi.fetchWorkspace).not.toHaveBeenCalled();
  });

  it('the hub filter is a server param', async () => {
    useHubFilterStore.setState({ hubId: 'hub-gr', region: null });
    renderPage();
    await waitFor(() =>
      expect(api.fetchGantt).toHaveBeenCalledWith({ hubId: 'hub-gr', region: undefined, priority: undefined }, expect.anything()),
    );
  });

  it('expanding a project shows its 14 steps, read-only, and puts it in the URL', async () => {
    renderPage();
    await expand('Cooler Alpha');
    expect(stepRows('p1')).toHaveLength(14);
    expect(screen.queryByTestId('step-drag-body')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit timing/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/workflow?project=p1');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse steps for Cooler Alpha' }));
    expect(screen.queryAllByTestId('gantt-step-row')).toHaveLength(0);
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/settings\/workflow$/);
  });

  it('Expand all / Collapse all', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(projectRows()).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(stepRows('p1')).toHaveLength(14);
    expect(stepRows('p3')).toHaveLength(14);
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryAllByTestId('gantt-step-row')).toHaveLength(0);
  });

  it('?project=<id> expands that project and scrolls it into view', async () => {
    renderPage('/settings/workflow?project=p3');
    await waitFor(() => expect(stepRows('p3')).toHaveLength(14));
    expect(stepRows('p1')).toHaveLength(0);
    // p1, p2 (collapsed) then p3: visual index 2.
    await waitFor(() => expect(virt.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' }));
  });

  it('axis runs past W52 with next-year labels, the W52 marker and the current week', async () => {
    renderPage();
    await waitFor(() => expect(projectRows()).toHaveLength(3));
    // starts W42 = CURRENT_WEEK → W40; last end W55 → W57.
    const axis = screen.getByRole('img', { name: 'Week axis, week 40 to week 57' });
    expect(within(axis).getByTestId('gantt-year-end-label')).toHaveTextContent('W52 year-end');
    expect(within(axis).getByText('W42 now')).toBeInTheDocument();
    expect(within(axis).getByText('W52')).toBeInTheDocument();
    // At the 16 px minimum the stride is 4: W56 ("W4 '27") would be clipped, so it is skipped.
    expect(within(axis).queryByText(/^W4 '/)).not.toBeInTheDocument();
  });

  it('weeks grow to fill the card width (the Timeline keeps its fixed width)', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1750);
    try {
      renderPage();
      await waitFor(() => expect(projectRows()).toHaveLength(3));
      const axis = screen.getByRole('img', { name: 'Week axis, week 40 to week 57' });
      // 1750 − 272 (names) − 148 (status) − 3 (borders).
      await waitFor(() => expect(Number(axis.getAttribute('width'))).toBeCloseTo(1327, 5));
      expect(within(axis).getByText("W4 '27")).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('P33-T15 (ADR 0048): no drag, resize, Edit timing, Reset or edited marker for a GANTT writer; the gap is a read-only chip', async () => {
    rowsServed = [row({ steps: steps((i) => (i === 2 ? { gap_weeks: -1 } : i === 6 ? { gap_weeks: 2 } : {})) })];
    renderPage('/settings/workflow?project=p1', 'Super Admin');
    await waitFor(() => expect(stepRows('p1')).toHaveLength(14));
    expect(screen.queryByTestId('step-drag-overlay')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-drag-body')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-drag-handle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-timing-edited')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit timing|Reset timing/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
    expect(screen.getByText(/Step timing is read-only here/)).toBeInTheDocument();
    expect(within(stepRow('p1', 2)).getByTestId('step-gap-chip')).toHaveTextContent(/^parallel 1 wk/);
    expect(within(stepRow('p1', 6)).getByTestId('step-gap-chip')).toHaveTextContent(/^wait 2 wk/);
    expect(screen.getAllByTestId('step-gap-chip')).toHaveLength(2);
  });

  it('the search filters the list by name, code, hub or status', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(projectRows()).toHaveLength(3));
    const search = screen.getByRole('searchbox', { name: 'Search' });
    await user.type(search, 'india');
    expect(projectRows()).toHaveLength(1);
    expect(projectRows()[0]).toHaveTextContent('Freezer Beta');
    expect(screen.getByTestId('step-timing-count')).toHaveTextContent('1 of 3 projects shown');
    await user.clear(search);
    await user.type(search, 'in queue');
    await waitFor(() => expect(projectRows()).toHaveLength(1));
    expect(projectRows()[0]).toHaveTextContent('Frameless Door E-47');
    await user.clear(search);
    await user.type(search, '24-001');
    expect(projectRows()[0]).toHaveTextContent('Cooler Alpha');
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('No project matches the search')).toBeInTheDocument();
  });

  it('the priority filter is a server param', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(projectRows()).toHaveLength(3));
    await user.click(screen.getByRole('radio', { name: /^P3/ }));
    await waitFor(() =>
      expect(api.fetchGantt).toHaveBeenCalledWith({ hubId: undefined, region: undefined, priority: 'P3' }, expect.anything()),
    );
  });

  it('read only for a viewer: no affordances, no templates tab', async () => {
    renderPage('/settings/workflow?project=p1', 'Executive Viewer');
    expect(screen.queryByRole('tab', { name: 'Workflow templates' })).not.toBeInTheDocument();
    await waitFor(() => expect(stepRows('p1')).toHaveLength(14));
    expect(screen.queryByTestId('step-drag-body')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit timing/ })).not.toBeInTheDocument();
  });

  it('an Engineer (no dashboard read) still gets the list, without statuses', async () => {
    renderPage('/settings/workflow', 'Engineer');
    await waitFor(() => expect(projectRows()).toHaveLength(3));
    expect(dash.fetchDashboardProjects).not.toHaveBeenCalled();
  });

  it('states: no active run, 403', async () => {
    api.fetchGantt.mockResolvedValue({ ...gantt([]), has_active_schedule_run: false });
    const { unmount } = renderPage();
    expect(await screen.findByText('No schedule yet')).toBeInTheDocument();
    unmount();
    api.fetchGantt.mockRejectedValue(new ApiError(403, 'Forbidden', 'no'));
    renderPage();
    expect(await screen.findByText('Your role does not have access to the Project Execution Timeline')).toBeInTheDocument();
  });

  it('has no serious axe violations with a project expanded', async () => {
    const { container } = renderPage('/settings/workflow?project=p1');
    await waitFor(() => expect(stepRows('p1')).toHaveLength(14));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('P32-R04 — projects the run did not place', () => {
  it('expanded, a left-out project lists its 14 steps from the workspace with "Not placed", read-only', async () => {
    wsApi.fetchWorkspace.mockResolvedValue({
      ...workspace(),
      stages: Array.from({ length: 14 }, (_, i) =>
        stage(i, { planned_start_week: null, planned_end_week: null, skipped: i === 2, gap_weeks: i === 4 ? 3 : 0 }),
      ),
    });
    renderPage();
    await expand('Frameless Door E-47');
    await waitFor(() => expect(stepRows('p2')).toHaveLength(14));
    expect(wsApi.fetchWorkspace).toHaveBeenCalledTimes(1);
    expect(wsApi.fetchWorkspace).toHaveBeenCalledWith('p2', expect.anything());
    expect(screen.getAllByTestId('gantt-step-unplaced')).toHaveLength(13); // PDD-C is skipped
    expect(screen.queryByTestId('step-drag-body')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit timing/ })).not.toBeInTheDocument();
    // The workspace stage's served gap is carried to the row.
    expect(within(stepRow('p2', 5)).getByTestId('step-gap-chip')).toHaveTextContent(/^wait 3 wk/);
  });

  it('a partly placed project keeps its served rows and adds the rest', async () => {
    rowsServed = [row({ project_id: 'p2', project_name: 'Frameless Door E-47', left_out: true, projected_end_week: null, leader_engineer_id: 'eng-1', steps: steps().slice(0, 4) })];
    renderPage('/settings/workflow?project=p2');
    await waitFor(() => expect(stepRows('p2')).toHaveLength(14));
    expect(screen.getAllByTestId('gantt-step-unplaced')).toHaveLength(10);
  });

  it('the badge names a served reason: no leader', async () => {
    rowsServed = [row({ project_id: 'p2', project_name: 'Frameless Door E-47', left_out: true, projected_end_week: null, leader_engineer_id: null, steps: [] })];
    renderPage();
    expect(await screen.findByTestId('step-timing-not-placed')).toHaveAttribute('title', expect.stringContaining('Reason: the project has no leader.'));
  });

  it('axe: no serious violations with a left-out project expanded', async () => {
    const { container } = renderPage('/settings/workflow?project=p2');
    await waitFor(() => expect(stepRows('p2')).toHaveLength(14));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('Week axis labels (P32-R04)', () => {
  it('a tick label that would be clipped at the axis end is skipped', () => {
    const scale = (horizonWeeks: number) => ({ originWeek: 41, horizonWeeks, weekWidthPx: 24, totalWidthPx: horizonWeeks * 24 });
    const fmt = (w: number) => (w > 52 ? `W${String(w - 52)} '27` : `W${String(w)}`);
    const { unmount } = render(<GanttWeekAxis scale={scale(14)} weekLabel={fmt} />);
    expect(screen.getByText("W1 '27")).toBeInTheDocument();
    unmount();
    render(<GanttWeekAxis scale={scale(13)} weekLabel={fmt} />);
    expect(screen.queryByText("W1 '27")).not.toBeInTheDocument();
    expect(screen.getByText('W51')).toBeInTheDocument();
  });
});

describe('Workflow page — RBAC (P32-R04)', () => {
  it('the template tab is for workflow_settings readers only (Admin reads, Super Admin edits)', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage('/settings/workflow', 'Hub Planner');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Project step timing']);
    unmount();

    renderPage('/settings/workflow', 'Admin');
    await user.click(screen.getByRole('tab', { name: 'Workflow templates' }));
    expect(screen.getByTestId('location')).toHaveTextContent('?tab=templates');
  });

  it('?tab=templates falls back to step timing for a role without template read', async () => {
    renderPage('/settings/workflow?tab=templates', 'Hub Planner');
    expect(screen.getByRole('tab', { name: 'Project step timing' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(projectRows()).toHaveLength(3));
  });

  it('the Workflow nav item shows for Timeline readers, not for the Auditor', () => {
    const paths = (role: RoleName) =>
      visibleNavGroups(makeMe({ roles: [role], permissions: ROLE_MATRIX[role] }))
        .flatMap(([, items]) => items)
        .map((i) => i.path);
    for (const role of ['Hub Planner', 'Portfolio Manager', 'Admin', 'Super Admin', 'Executive Viewer', 'Engineer'] as const) {
      expect(paths(role)).toContain('/settings/workflow');
    }
    expect(paths('Auditor')).not.toContain('/settings/workflow');
  });
});
