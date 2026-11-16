import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { permissionsFrom } from '@/test/session';
import { ApiError } from '@/lib/api/client';
import { useHubFilterStore } from '@/stores/hub-filter';
import { seriousAxeViolations } from '@/test/axe';
import type { GanttProjectRow, GanttStepRow, StepPinsResponse } from './api/types';

/**
 * P40-T03c (ADR 0054, docs/API_CONTRACT_P40.md): the Timeline's manual step
 * Start / End weeks — inputs, typing rules, red state, Clear, the batch Save
 * and its outcomes, per-item server errors, badges, Unfreeze for Admins only,
 * and the per-step activity strip / count chips.
 */

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
    measure: () => undefined,
  }),
}));

const hooks = {
  useGantt: vi.fn(),
  useActiveScheduleRun: vi.fn(),
  useToggleFreeze: vi.fn(),
  useGanttFacets: vi.fn(),
};
vi.mock('./hooks/use-gantt', () => ({
  useGantt: (args: unknown) => hooks.useGantt(args),
  useActiveScheduleRun: (enabled: boolean) => hooks.useActiveScheduleRun(enabled),
  useToggleFreeze: () => hooks.useToggleFreeze(),
  useGanttFacets: (...args: unknown[]) => hooks.useGanttFacets(...args),
}));
vi.mock('@/lib/api/reference', () => ({ useHubs: () => ({ data: [] }) }));

const saveStepPins = vi.fn();
vi.mock('./api/step-pins-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/step-pins-api')>();
  return { ...actual, saveStepPins: (...args: unknown[]) => saveStepPins(...args) as unknown };
});

import GanttPage from './GanttPage';
import { P13_GANTT_ROW_DEFAULTS, P40_GANTT_STEP_PIN_DEFAULTS } from './test-fixtures';

function step(seq: number, start: number | null, end: number | null, over: Partial<GanttStepRow> = {}): GanttStepRow {
  return {
    step_id: `PDD-${String.fromCharCode(64 + seq)}`,
    step_name: `Step ${String(seq)}`,
    kind: 'design',
    sequence_order: seq,
    skipped: false,
    status: 'Not Started',
    percent_complete: 0,
    duration_weeks: 2,
    planned_start_week: start,
    planned_end_week: end,
    actual_start_week: null,
    actual_end_week: null,
    assigned_engineer_name: null,
    assigned_chamber_code: null,
    eng_conflict: false,
    chamber_overlap: false,
    lead_time_weeks: 2,
    span_fte: null,
    effort_weeks: null,
    plan_weeks: 2,
    gap_weeks: 0,
    own_effort: false,
    predecessor_ids: [],
    ...P40_GANTT_STEP_PIN_DEFAULTS,
    current_length_weeks: 4,
    pin_editable: true,
    pin_block_reason: null,
    ...over,
  };
}

function project(over: Partial<GanttProjectRow> = {}, steps?: GanttStepRow[]): GanttProjectRow {
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
    expected_end_week: null,
    projected_end_week: null,
    unconstrained_end_week: null,
    slip_weeks: null,
    blocked: false,
    schedule_stale: false,
    workflow_id: 'PDD',
    is_vip: false,
    tracking_status: 'idle',
    ...P13_GANTT_ROW_DEFAULTS,
    steps: steps ?? [
      step(1, 32, 35),
      step(2, 36, 38, { pin_editable: false, pin_block_reason: 'STEP_STARTED', status: 'In Progress' }),
      step(3, 40, 42, { manual_start_week: 40, manual_end_week: 42, pinned: true }),
      step(4, null, null),
    ],
    ...over,
  };
}

function ganttData(over: Record<string, unknown> = {}) {
  return {
    data: {
      has_active_schedule_run: true,
      schedule_run_version: 5,
      total_count: 1,
      rows: [project()],
      weekly_active_counts: Array.from({ length: 52 }, (_, i) => ({
        week: i + 1,
        pdd: i === 31 ? 3 : 0,
        oem: 0,
        by_step: i === 31 ? { 'PDD-A': 2, 'PDD-C': 1 } : {},
      })),
      current_step_counts: { 'PDD-A': 2, 'PDD-C': 1 },
      current_week: 31,
      ...over,
    },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

function okResponse(over: Partial<StepPinsResponse> = {}): StepPinsResponse {
  return {
    changes: [],
    unchanged_count: 0,
    projects_marked_stale: ['p1'],
    current_week: 31,
    recalc_status: 'not_needed',
    schedule_run_id: null,
    baseline_run_id: null,
    task_id: null,
    ...over,
  };
}

async function expand(user: ReturnType<typeof userEvent.setup>, name = 'Cooler Alpha') {
  await user.click(screen.getByRole('button', { name: `Expand steps for ${name}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.getState().setSelection([], []);
  hooks.useActiveScheduleRun.mockReturnValue({ data: null });
  hooks.useToggleFreeze.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useGantt.mockReturnValue(ganttData());
  hooks.useGanttFacets.mockReturnValue({ data: { leaders: [], steps: [] }, isError: false });
});

describe('P40-T03c step Start / End weeks', () => {
  it('asks for the unplaced steps too (include_unplaced)', () => {
    renderWithProviders(<GanttPage />);
    expect(hooks.useGantt).toHaveBeenCalledWith(expect.objectContaining({ includeUnplaced: true }));
  });

  it('labels the inputs per step; typing a Start pushes the End by the served length; End keeps the Start', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    await expand(user);
    const start = screen.getByRole('spinbutton', { name: 'Start week, Step 1' });
    const end = screen.getByRole('spinbutton', { name: 'End week, Step 1' });
    // Placeholders are the served planned weeks; no pin = empty.
    expect(start).toHaveValue(null);
    expect(start).toHaveAttribute('placeholder', '32');
    await user.type(start, '44');
    expect(end).toHaveValue(47); // 44 + 4 − 1, current_length_weeks = 4
    await user.clear(end);
    await user.type(end, '45');
    expect(start).toHaveValue(44); // squeezed, start kept
    expect(screen.getByTestId('step-pin-edit-count')).toHaveTextContent('1 step changed in 1 project');
    // Only the edited step changed: its neighbour has no draft.
    expect(screen.getByRole('spinbutton', { name: 'Start week, Step 3' })).toHaveValue(40);
  });

  it('End < Start and weeks outside current week..52 are red, described and block Save', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    await expand(user);
    const start = screen.getByRole('spinbutton', { name: 'Start week, Step 1' });
    const end = screen.getByRole('spinbutton', { name: 'End week, Step 1' });
    await user.type(start, '44');
    await user.clear(end);
    await user.type(end, '43');
    expect(end).toHaveAttribute('aria-invalid', 'true');
    const describedBy = end.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy.split(' ')[0] ?? '')).toHaveTextContent('The end week is before the start week.');
    expect(screen.getByTestId('step-pin-edit-save')).toBeDisabled();
    expect(screen.getByTestId('step-pin-edit-error')).toHaveTextContent('1 step has weeks in red');

    await user.clear(start);
    await user.type(start, '20');
    expect(start).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('step-pin-error')).toHaveTextContent('Pick weeks between W31 and W52.');
    expect(screen.getByTestId('step-pin-edit-save')).toBeDisabled();
  });

  it('a step the server does not allow is read-only, with the served reason as tooltip and description', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    await expand(user);
    const start = screen.getByRole('spinbutton', { name: 'Start week, Step 2' });
    expect(start).toHaveAttribute('readonly');
    expect(start).toHaveAttribute('title', expect.stringMatching(/has started/));
    expect(start).toHaveAccessibleDescription(expect.stringMatching(/has started/));
    await user.type(start, '44');
    expect(start).toHaveValue(null);
    expect(screen.queryByTestId('step-pin-edit-bar')).not.toBeInTheDocument();
  });

  it('saves one batch; not_needed shows the outcome and clears the drafts', async () => {
    saveStepPins.mockResolvedValue(okResponse({ changes: [{ project_id: 'p1', step_template_id: 'PDD-A', action: 'pinned', before_start_week: null, before_end_week: null, manual_start_week: 44, manual_end_week: 47 }] }));
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    await expand(user);
    await user.type(screen.getByRole('spinbutton', { name: 'Start week, Step 1' }), '44');
    await user.click(screen.getByRole('button', { name: 'Clear weeks, Step 3' }));
    expect(screen.getByTestId('step-pin-will-clear')).toHaveTextContent('Cleared on save');
    await user.click(screen.getByTestId('step-pin-edit-save'));
    expect(saveStepPins).toHaveBeenCalledWith({
      items: [
        { project_id: 'p1', step_template_id: 'PDD-A', manual_start_week: 44, manual_end_week: 47 },
        { project_id: 'p1', step_template_id: 'PDD-C', manual_start_week: null, manual_end_week: null },
      ],
    });
    const panel = await screen.findByTestId('step-pin-save-panel');
    expect(panel).toHaveAttribute('data-status', 'not_needed');
    expect(within(panel).getByText(/Saved 1 step\./)).toBeInTheDocument();
    expect(screen.queryByTestId('step-pin-edit-bar')).not.toBeInTheDocument();
  });

  it.each([
    ['deferred', /updates automatically|follow-up|in flight|after the run/i],
    ['dispatch_failed', /could not be started/],
    ['unchanged', /already had these weeks/],
  ] as const)('reports %s as the priority move does', async (status, text) => {
    saveStepPins.mockResolvedValue(okResponse({ recalc_status: status }));
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    await expand(user);
    await user.type(screen.getByRole('spinbutton', { name: 'Start week, Step 1' }), '44');
    await user.click(screen.getByTestId('step-pin-edit-save'));
    const panel = await screen.findByTestId('step-pin-save-panel');
    expect(panel).toHaveAttribute('data-status', status);
    expect(within(panel).getByTestId('step-pin-save-body').textContent).toMatch(text);
  });

  it('maps per-item refusals back onto their inputs and keeps the drafts', async () => {
    saveStepPins.mockRejectedValue(
      new ApiError(
        409,
        'Conflict',
        JSON.stringify({
          code: 'STEP_STARTED',
          message: 'Nothing was saved: fix the steps listed in errors.',
          errors: [{ index: 0, project_id: 'p1', step_template_id: 'PDD-A', code: 'STEP_STARTED', message: 'Started.' }],
        }),
        'STEP_STARTED',
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    await expand(user);
    const start = screen.getByRole('spinbutton', { name: 'Start week, Step 1' });
    await user.type(start, '44');
    await user.click(screen.getByTestId('step-pin-edit-save'));
    await waitFor(() => expect(start).toHaveAttribute('aria-invalid', 'true'));
    expect(start).toHaveAccessibleDescription(expect.stringMatching(/has started/));
    expect(screen.getByTestId('step-pin-edit-error')).toHaveTextContent('Nothing was saved');
    expect(screen.getByTestId('step-pin-edit-count')).toHaveTextContent('1 step changed');
    expect(screen.queryByTestId('step-pin-save-panel')).not.toBeInTheDocument();
  });

  it('Cancel asks first, then drops every draft', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    await expand(user);
    await user.type(screen.getByRole('spinbutton', { name: 'Start week, Step 1' }), '44');
    await user.click(within(screen.getByTestId('step-pin-edit-bar')).getByRole('button', { name: 'Cancel' }));
    await user.click(within(await screen.findByTestId('step-pin-discard-dialog')).getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByTestId('step-pin-edit-bar')).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Start week, Step 1' })).toHaveValue(null);
  });

  it('shows Pinned, Manual overlap, Pin lapsed and "Pin applies on the next run" from served flags', async () => {
    const steps = [
      step(1, 32, 35, { pinned: true, manual_overlap: true, manual_start_week: 32, manual_end_week: 35 }),
      step(2, 36, 38, { manual_start_week: 44, manual_end_week: 46 }),
      step(3, 40, 42),
      step(4, 44, 45),
    ];
    hooks.useGantt.mockReturnValue(ganttData({ rows: [project({ manual_overlap: true, pin_lapsed: true }, steps)] }));
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    expect(screen.getByTestId('manual-overlap-chip')).toHaveTextContent('Manual overlap');
    expect(screen.getByTestId('pin-lapsed-chip')).toHaveTextContent('Pin lapsed');
    await expand(user);
    expect(screen.getAllByTestId('pinned-chip')).toHaveLength(1);
    expect(screen.getAllByTestId('gantt-pin-marker').length).toBeGreaterThanOrEqual(2); // project line + step row
    expect(screen.getAllByTestId('step-pin-next-run')).toHaveLength(1);
    expect(screen.getAllByTestId('manual-overlap-chip')).toHaveLength(2);
  });

  it('marks a step the run did not place', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    await expand(user);
    expect(screen.getAllByTestId('gantt-step-unplaced')).toHaveLength(1);
  });

  it('Unfreeze shows only for Admin / Super Admin; Freeze stays for a Hub Planner', () => {
    hooks.useGantt.mockReturnValue(
      ganttData({ rows: [project({ frozen: true }), project({ project_id: 'p2', project_name: 'Cooler Beta' })] }),
    );
    renderWithProviders(<GanttPage />, {
      session: { roles: ['Hub Planner'], permissions: permissionsFrom({ gantt: 'rw', dashboard: 'r' }) },
    });
    expect(screen.queryByRole('button', { name: 'Unfreeze Cooler Alpha' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Freeze Cooler Beta' })).toBeInTheDocument();
  });

  it('an Admin sees Unfreeze', () => {
    hooks.useGantt.mockReturnValue(ganttData({ rows: [project({ frozen: true })] }));
    renderWithProviders(<GanttPage />, { session: { roles: ['Admin'] } });
    expect(screen.getByRole('button', { name: 'Unfreeze Cooler Alpha' })).toBeInTheDocument();
  });

  it('stacks the activity strip by step and shows the served per-step count chips', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    await user.click(screen.getByRole('button', { name: /Legend & stats/i }));
    const strip = screen.getByTestId('gantt-activity-strip');
    const rects = strip.querySelectorAll('rect[data-step]');
    expect([...rects].map((r) => [r.getAttribute('data-step'), r.getAttribute('data-count')])).toEqual([
      ['PDD-A', '2'],
      ['PDD-C', '1'],
    ]);
    expect(rects[0]?.getAttribute('fill')).toBe('hsl(var(--step-1))');
    const chips = screen.getByTestId('gantt-step-counts');
    expect(chips).toHaveTextContent('In each step, W31');
    expect(within(chips).getByText(/PDD-A Step 1: 2 projects/)).toBeInTheDocument();
  });

  it('expanded step rows with the inputs have no serious axe violation', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<GanttPage />);
    await expand(user);
    await user.type(screen.getByRole('spinbutton', { name: 'Start week, Step 1' }), '20');
    expect(await seriousAxeViolations(container)).toEqual([]);
  }, 90_000);
});
