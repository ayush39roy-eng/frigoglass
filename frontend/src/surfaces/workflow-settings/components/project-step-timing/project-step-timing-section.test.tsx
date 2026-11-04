import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { ApiError } from '@/lib/api/client';
import type { ScheduleRunChanges } from '@/lib/api/priority-move';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { ROLE_MATRIX } from '@/test/roles';
import { makeMe } from '@/test/session';
import { useHubFilterStore } from '@/stores/hub-filter';
import { visibleNavGroups } from '@/app/nav-visibility';
import type { GanttProjectRow, GanttResponse, GanttStepRow, StepTimingResponse } from '@/surfaces/gantt/api/types';
import { P13_GANTT_ROW_DEFAULTS } from '@/surfaces/gantt/test-fixtures';
import type { RoleName, WorkflowStepKind } from '@/types/enums';

const api = { fetchGantt: vi.fn(), setStepTiming: vi.fn() };
vi.mock('@/surfaces/gantt/api/gantt-api', async () => {
  const actual = await vi.importActual<typeof import('@/surfaces/gantt/api/gantt-api')>('@/surfaces/gantt/api/gantt-api');
  return {
    ...actual,
    fetchGantt: (...a: unknown[]) => api.fetchGantt(...a),
    setStepTiming: (...a: unknown[]) => api.setStepTiming(...a),
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
const changesApi = { fetchScheduleRunChanges: vi.fn() };
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return { ...actual, fetchScheduleRunChanges: (...a: unknown[]) => changesApi.fetchScheduleRunChanges(...a) };
});
const sse = { streamSolverProgress: vi.fn() };
vi.mock('@/lib/api/sse', () => ({
  streamSolverProgress: (...a: unknown[]) => sse.streamSolverProgress(...a),
}));
vi.mock('@/lib/use-follow-up-run', () => ({
  useFollowUpRunWatcher: () => ({ start: vi.fn(), watching: false }),
}));
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

const WEEK_PX = 24; // WATERFALL_WEEK_PX
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
      duration_override_weeks: null,
      effort_weeks: null,
      start_not_before_week: null,
      timing_editable: 'move_resize',
      span_fte: null,
      overlap_weeks: null,
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
  { project_id: 'p2', project_name: 'Freezer Beta', external_code: null, hub: 'R&D-India', status: 'In Queue', priority: 'P3' },
];

function response(over: Partial<StepTimingResponse> = {}): StepTimingResponse {
  return {
    project_id: 'p1',
    step_id: 'PDD-B',
    duration_override_weeks: null,
    start_not_before_week: 42,
    effective_duration_weeks: 1,
    effort_weeks: null,
    overlap_weeks: 1,
    lead_time_weeks: 1,
    recalc_status: 'queued',
    schedule_run_id: 'run-2',
    baseline_run_id: 'run-1',
    task_id: null,
    ...over,
  };
}

const CHANGES: ScheduleRunChanges = {
  run_id: 'run-2',
  run_version: 8,
  against_run_id: 'run-1',
  against_run_version: 7,
  hidden_count: 0,
  rows: [],
};

let projectRow: GanttProjectRow = row();

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

/** Calls of `fetchGantt` for one project (the waterfall's read). */
function projectReads(): number {
  return api.fetchGantt.mock.calls.filter((c) => (c[0] as { projectId?: string }).projectId === 'p1').length;
}

function drag(el: Element, fromX: number, toX: number) {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: fromX });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: toX });
  fireEvent.pointerUp(el, { pointerId: 1, button: 0, clientX: toX });
}

function stepRow(stepId: string): HTMLElement {
  const el = screen.getAllByTestId('waterfall-step-row').find((r) => r.getAttribute('data-step-id') === stepId);
  if (!el) throw new Error(`no row ${stepId}`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null, region: null });
  projectRow = row();
  api.fetchGantt.mockImplementation((params: { projectId?: string }) =>
    Promise.resolve(params.projectId ? gantt(params.projectId === projectRow.project_id ? [projectRow] : []) : gantt([projectRow])),
  );
  api.setStepTiming.mockResolvedValue(response());
  dash.fetchDashboardProjects.mockResolvedValue({ total_count: PROJECTS.length, rows: PROJECTS });
  sse.streamSolverProgress.mockResolvedValue({ status: 'completed' });
  changesApi.fetchScheduleRunChanges.mockResolvedValue(CHANGES);
});

describe('Workflow page — Project step timing tab (P32-R04)', () => {
  it('is the first, selected tab and starts with the empty state', async () => {
    renderPage();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Project step timing', 'Workflow templates']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Pick a project to adjust its steps')).toBeInTheDocument();
    expect(api.fetchGantt).not.toHaveBeenCalled();
    await waitFor(() => expect(dash.fetchDashboardProjects).toHaveBeenCalledWith(
      { hub_id: undefined, region: undefined, sort: 'name' },
      expect.anything(),
    ));
  });

  it('picking a project puts it in the URL and draws its 14 steps one below another', async () => {
    const user = userEvent.setup();
    renderPage();
    const picker = screen.getByRole('combobox', { name: 'Project' });
    await user.click(picker);
    await user.type(picker, 'alpha');
    const option = await screen.findByRole('option', { name: /Cooler Alpha/ });
    expect(option).toHaveTextContent('R&D-Greece · In Development');
    await user.click(option);

    expect(screen.getByTestId('location')).toHaveTextContent('/settings/workflow?project=p1');
    const card = await screen.findByTestId('step-timing-project');
    expect(within(card).getByTestId('step-timing-project-name')).toHaveTextContent('Cooler Alpha');
    expect(card).toHaveTextContent('Category A');
    expect(within(card).getByTestId('step-timing-finish-week')).toHaveTextContent("Finish W3 '27");
    expect(within(card).getByText('In Development')).toBeInTheDocument();
    const rows = screen.getAllByTestId('waterfall-step-row');
    expect(rows).toHaveLength(14);
    expect(rows.map((r) => r.getAttribute('data-step-id'))).toEqual(Array.from(LETTERS).map((l) => `PDD-${l}`));
    expect(screen.getAllByTestId('step-drag-body')).toHaveLength(14);
    expect(api.fetchGantt).toHaveBeenCalledWith({ projectId: 'p1' }, expect.anything());
  });

  it('the hub filter narrows the picker list (server param)', async () => {
    useHubFilterStore.setState({ hubId: 'hub-gr', region: null });
    renderPage();
    await waitFor(() =>
      expect(dash.fetchDashboardProjects).toHaveBeenCalledWith({ hub_id: 'hub-gr', region: undefined, sort: 'name' }, expect.anything()),
    );
  });

  it('axis: from 2 weeks before the earlier of the first start and the current week to max(W52, last end)+2; next-year labels', async () => {
    renderPage('/settings/workflow?project=p1');
    const scroll = await screen.findByTestId('waterfall-scroll');
    // first start W42 = CURRENT_WEEK 42 → W40; last end W55 → W57.
    expect(scroll).toHaveAttribute('data-origin-week', '40');
    expect(scroll).toHaveAttribute('data-last-week', '57');
    const axis = within(screen.getByTestId('waterfall-axis'));
    expect(axis.getByTestId('gantt-year-end-label')).toHaveTextContent('W52 year-end');
    expect(axis.getByText('W42 now')).toBeInTheDocument();
    expect(axis.getByText("W2 '27")).toBeInTheDocument();
  });

  it('dropping a bar onto the step above sends the overlap, shows the parallel label, then refetches this view', async () => {
    renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    const body = within(stepRow('PDD-B')).getByTestId('step-drag-body');
    fireEvent.pointerDown(body, { pointerId: 1, button: 0, clientX: 300 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 300 - WEEK_PX });
    expect(within(stepRow('PDD-B')).getByTestId('step-drag-label')).toHaveTextContent(
      'Parallel with Step A · 1 wk overlap · same designer — will start when they are free',
    );
    const before = projectReads();
    fireEvent.pointerUp(body, { pointerId: 1, button: 0, clientX: 300 - WEEK_PX });
    await waitFor(() =>
      expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-B', { start_not_before_week: 42, overlap_weeks: 1 }),
    );
    const panel = await screen.findByTestId('step-timing-panel');
    await waitFor(() => expect(panel).toHaveAttribute('data-kind', 'updated'));
    expect(within(panel).getByText('Timeline updated')).toBeInTheDocument();
    await waitFor(() => expect(projectReads()).toBeGreaterThan(before));
  });

  it('the overlap drag cannot go before the start of the step above (clamp)', async () => {
    renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    drag(within(stepRow('PDD-B')).getByTestId('step-drag-body'), 300, 300 - 5 * WEEK_PX);
    await waitFor(() =>
      expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-B', { start_not_before_week: 42, overlap_weeks: 1 }),
    );
  });

  it('a move past the axis end clamps at W78 (the scheduler horizon)', async () => {
    renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    drag(within(stepRow('PDD-N')).getByTestId('step-drag-body'), 300, 300 + 60 * WEEK_PX);
    await waitFor(() =>
      expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-N', { start_not_before_week: 78, overlap_weeks: null }),
    );
  });

  it('dragging the right edge sends the new duration', async () => {
    api.setStepTiming.mockResolvedValue(response({ step_id: 'PDD-D', duration_override_weeks: 3, start_not_before_week: null, overlap_weeks: null }));
    renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    drag(within(stepRow('PDD-D')).getByTestId('step-drag-handle'), 400, 400 + 2 * WEEK_PX);
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-D', { duration_override_weeks: 3 }));
  });

  it('Edit timing dialog and Reset timing', async () => {
    const user = userEvent.setup();
    projectRow = row({ steps: steps((i) => (i === 5 ? { duration_override_weeks: 3, duration_weeks: 3 } : {})) });
    renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    await user.click(screen.getByRole('button', { name: 'Edit timing for Step E (Cooler Alpha)' }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset timing' }));
    await waitFor(() =>
      expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', {
        duration_override_weeks: null,
        start_not_before_week: null,
        overlap_weeks: null,
      }),
    );
  });

  it('honours the served timing_editable: Done / started steps', async () => {
    projectRow = row({
      steps: steps((i) =>
        i === 1 ? { status: 'Done', timing_editable: 'none' } : i === 2 ? { status: 'In Progress', timing_editable: 'resize' } : {},
      ),
    });
    renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    expect(within(stepRow('PDD-A')).queryByTestId('step-drag-overlay')).not.toBeInTheDocument();
    expect(within(stepRow('PDD-A')).getByTestId('waterfall-step-status')).toHaveTextContent('Done');
    expect(within(stepRow('PDD-B')).queryByTestId('step-drag-body')).not.toBeInTheDocument();
    expect(within(stepRow('PDD-B')).getByTestId('step-drag-handle')).toBeInTheDocument();
  });

  it('read only for a viewer: no drag, no resize, no Edit timing, a read-only hint', async () => {
    projectRow = row({ steps: steps(() => ({ timing_editable: 'none' })) });
    renderPage('/settings/workflow?project=p1', 'Executive Viewer');
    expect(screen.queryByRole('tab', { name: 'Workflow templates' })).not.toBeInTheDocument();
    await screen.findByTestId('step-timing-project');
    expect(screen.getAllByTestId('waterfall-step-row')).toHaveLength(14);
    expect(screen.queryByTestId('step-drag-body')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-drag-handle')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit timing/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('step-timing-read-only')).toBeInTheDocument();
  });

  it('an Engineer (no dashboard read) picks from the Timeline rows', async () => {
    const user = userEvent.setup();
    renderPage('/settings/workflow', 'Engineer');
    await waitFor(() =>
      expect(api.fetchGantt).toHaveBeenCalledWith({ hubId: undefined, region: undefined, sort: 'name' }, expect.anything()),
    );
    expect(dash.fetchDashboardProjects).not.toHaveBeenCalled();
    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    expect(await screen.findByRole('option', { name: /Cooler Alpha/ })).toHaveTextContent('R&D-Greece');
  });

  it('states: no active run, project not served, 403', async () => {
    api.fetchGantt.mockResolvedValueOnce({ ...gantt([]), has_active_schedule_run: false });
    const { unmount } = renderPage('/settings/workflow?project=p1');
    expect(await screen.findByText('No schedule yet')).toBeInTheDocument();
    unmount();

    renderPage('/settings/workflow?project=zz');
    expect(await screen.findByText('This project is not on the timeline')).toBeInTheDocument();
  });

  it('a 403 on the project read says the timeline is not available', async () => {
    api.fetchGantt.mockRejectedValue(new ApiError(403, 'Forbidden', 'no'));
    renderPage('/settings/workflow?project=p1');
    expect(await screen.findByText('Timeline not available')).toBeInTheDocument();
  });

  it('has no serious axe violations with a project open', async () => {
    const { container } = renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    expect(await seriousAxeViolations(container)).toEqual([]);
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
    expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
  });

  it('?tab=templates falls back to step timing for a role without template read', () => {
    renderPage('/settings/workflow?tab=templates', 'Hub Planner');
    expect(screen.getByRole('tab', { name: 'Project step timing' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Pick a project to adjust its steps')).toBeInTheDocument();
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

/** A workspace payload for p1 with all 14 stages (not placed: no planned weeks). */
function workspace(project: Partial<WorkspaceResponse['project']> = {}, stageOver: (i: number) => object = () => ({})) {
  const base = workspaceFixture();
  return {
    ...base,
    project: { ...base.project, id: 'p1', status: 'In Queue' as const, frozen: false, ...project },
    stages: Array.from({ length: 14 }, (_, i) =>
      stage(i, { planned_start_week: null, planned_end_week: null, skipped: i === 2, ...stageOver(i) }),
    ),
  };
}

describe('P32-R04 follow-up — width', () => {
  it('weeks grow so the axis fills the card; the minimum (24 px) applies when it does not fit', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'project-step-waterfall' ? 1750 : 0;
    });
    try {
      renderPage('/settings/workflow?project=p1');
      const box = await screen.findByTestId('project-step-waterfall');
      // 1750 − 300 (step) − 132 (status) − 3 (borders) over W40–W57 (18 weeks).
      await waitFor(() => expect(Number(box.getAttribute('data-week-px'))).toBeCloseTo(1315 / 18, 5));
      // A one-week drag is now one (wider) week.
      const px = 1315 / 18;
      drag(within(stepRow('PDD-N')).getByTestId('step-drag-body'), 600, 600 + px);
      await waitFor(() =>
        expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-N', { start_not_before_week: 56, overlap_weeks: null }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('jsdom (no width): the minimum week width', async () => {
    renderPage('/settings/workflow?project=p1');
    expect(await screen.findByTestId('project-step-waterfall')).toHaveAttribute('data-week-px', '24');
  });

  it('a tick label that would be clipped at the axis end is skipped', () => {
    const scale = (horizonWeeks: number) => ({ originWeek: 41, horizonWeeks, weekWidthPx: 24, totalWidthPx: horizonWeeks * 24 });
    const fmt = (w: number) => (w > 52 ? `W${String(w - 52)} '27` : `W${String(w)}`);
    const { unmount } = render(<GanttWeekAxis scale={scale(14)} weekLabel={fmt} />);
    expect(screen.getByText("W1 '27")).toBeInTheDocument();
    unmount();
    render(<GanttWeekAxis scale={scale(13)} weekLabel={fmt} />);
    expect(screen.queryByText("W1 '27")).not.toBeInTheDocument();
    expect(screen.queryByText(/^W1 '$/)).not.toBeInTheDocument();
    expect(screen.getByText('W51')).toBeInTheDocument();
  });
});

describe('P32-R04 follow-up — projects the run did not place', () => {
  it('a left-out project with no served step rows lists its 14 steps from the workspace, a banner, no bars, and Edit timing', async () => {
    const user = userEvent.setup();
    projectRow = row({ left_out: true, projected_end_week: null, expected_end_week: 63, leader_engineer_id: 'eng-1', steps: [] });
    wsApi.fetchWorkspace.mockResolvedValue(workspace());
    api.setStepTiming.mockResolvedValue(response({ step_id: 'PDD-E', duration_override_weeks: 1, start_not_before_week: null, overlap_weeks: null }));
    renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    expect(wsApi.fetchWorkspace).toHaveBeenCalledWith('p1', expect.anything());
    expect(screen.getAllByTestId('waterfall-step-row')).toHaveLength(14);
    expect(screen.getByTestId('step-timing-not-placed')).toHaveTextContent(
      "Not placed: the scheduler found no slot before the planning horizon (W26 '27).",
    );
    expect(screen.getByTestId('step-timing-not-placed')).toHaveTextContent('usually engineer or chamber capacity');
    expect(screen.queryByTestId('step-timing-read-only')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-drag-body')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('waterfall-step-unplaced')).toHaveLength(13); // 14 minus the skipped one
    // 13 non-skipped steps offer the keyboard dialog; the skipped one does not.
    expect(screen.getAllByRole('button', { name: /^Edit timing for / })).toHaveLength(13);
    await user.click(screen.getByRole('button', { name: 'Edit timing for Design Detailing (Cooler Alpha)' }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    const work = within(dialog).getByLabelText('Work (weeks)');
    await user.clear(work);
    await user.type(work, '1');
    await user.click(within(dialog).getByRole('button', { name: 'Save timing' }));
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { duration_override_weeks: 1 }));
  });

  it('names a served reason: no leader', async () => {
    projectRow = row({ left_out: true, projected_end_week: null, leader_engineer_id: null, steps: [] });
    wsApi.fetchWorkspace.mockResolvedValue(workspace());
    renderPage('/settings/workflow?project=p1');
    expect(await screen.findByTestId('step-timing-not-placed')).toHaveTextContent('Reason: the project has no leader.');
  });

  it('a partly placed project keeps its served rows and adds the rest', async () => {
    projectRow = row({ left_out: true, projected_end_week: null, leader_engineer_id: 'eng-1', steps: steps().slice(0, 4) });
    wsApi.fetchWorkspace.mockResolvedValue(workspace());
    renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    expect(screen.getAllByTestId('waterfall-step-row')).toHaveLength(14);
    expect(screen.getAllByTestId('step-drag-body')).toHaveLength(4);
    expect(screen.getByTestId('step-timing-not-placed')).toHaveTextContent('Partly placed: 10 of 14 steps found no slot');
  });

  it('a fully placed project does not read the workspace', async () => {
    renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-project');
    expect(wsApi.fetchWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('step-timing-not-placed')).not.toBeInTheDocument();
  });

  it('read only only when the user genuinely cannot edit: a viewer, a frozen project', async () => {
    projectRow = row({ left_out: true, projected_end_week: null, steps: [] });
    wsApi.fetchWorkspace.mockResolvedValue(workspace());
    const { unmount } = renderPage('/settings/workflow?project=p1', 'Executive Viewer');
    expect(await screen.findByTestId('step-timing-read-only')).toHaveTextContent('Your role can view step timing but not change it.');
    expect(screen.queryByRole('button', { name: /^Edit timing for / })).not.toBeInTheDocument();
    unmount();

    projectRow = row({ left_out: true, projected_end_week: null, frozen: true, steps: [] });
    wsApi.fetchWorkspace.mockResolvedValue(workspace({ frozen: true }));
    renderPage('/settings/workflow?project=p1');
    expect(await screen.findByTestId('step-timing-read-only')).toHaveTextContent('This project is frozen');
  });

  it('axe: no serious violations on a left-out project', async () => {
    projectRow = row({ left_out: true, projected_end_week: null, steps: [] });
    wsApi.fetchWorkspace.mockResolvedValue(workspace());
    const { container } = renderPage('/settings/workflow?project=p1');
    await screen.findByTestId('step-timing-not-placed');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
