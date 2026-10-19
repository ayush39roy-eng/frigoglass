import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import type { ScheduleRunChanges } from '@/lib/api/priority-move';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { GanttProjectRow, GanttStepRow, StepTimingResponse, TimingEditable } from '../../api/types';

// Deterministic virtualization: render every visual row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
  }),
}));

const api = { setStepTiming: vi.fn() };
vi.mock('../../api/gantt-api', async () => {
  const actual = await vi.importActual<typeof import('../../api/gantt-api')>('../../api/gantt-api');
  return { ...actual, setStepTiming: (...a: unknown[]) => api.setStepTiming(...a) };
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
const followUp = { start: vi.fn() };
vi.mock('@/lib/use-follow-up-run', () => ({
  useFollowUpRunWatcher: () => ({ start: followUp.start, watching: followUp.start.mock.calls.length > 0 }),
}));

import { GanttChart } from '../gantt-chart';
import { StepTimingProvider } from './step-timing-provider';
import { P13_GANTT_ROW_DEFAULTS } from '../../test-fixtures';

// weeks zoom: 15 px per week, week 1 at x = 0.
const WEEK_PX = 15;

function step(over: Partial<GanttStepRow> = {}): GanttStepRow {
  return {
    step_id: 'PDD-E',
    step_name: 'Prototype build',
    kind: 'design',
    sequence_order: 5,
    skipped: false,
    status: 'Not Started',
    percent_complete: 0,
    duration_weeks: 4,
    planned_start_week: 10,
    planned_end_week: 13,
    actual_start_week: null,
    actual_end_week: null,
    assigned_engineer_name: null,
    assigned_chamber_code: null,
    eng_conflict: false,
    chamber_overlap: false,
    lead_time_weeks: 4,
    duration_override_weeks: null,
    start_not_before_week: null,
    timing_editable: 'move_resize',
    ...over,
  };
}

function project(stepOver: Partial<GanttStepRow> = {}, over: Partial<GanttProjectRow> = {}): GanttProjectRow {
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
    steps: [step(stepOver)],
    ...over,
  };
}

function response(over: Partial<StepTimingResponse> = {}): StepTimingResponse {
  return {
    project_id: 'p1',
    step_id: 'PDD-E',
    duration_override_weeks: null,
    start_not_before_week: 13,
    effective_duration_weeks: 4,
    recalc_status: 'queued',
    schedule_run_id: 'run-2',
    baseline_run_id: 'run-1',
    task_id: 't1',
    ...over,
  };
}

const CHANGES: ScheduleRunChanges = {
  run_id: 'run-2',
  run_version: 8,
  against_run_id: 'run-1',
  against_run_version: 7,
  hidden_count: 0,
  rows: [
    {
      project_id: 'p1',
      project_name: 'Cooler Alpha',
      hub: 'R&D-Greece',
      priority: 'P1',
      before_projected_end_week: 30,
      after_projected_end_week: 33,
      delta_weeks: 3,
      before_within_year: true,
      after_within_year: true,
      before_left_out: false,
      after_left_out: false,
      before_blocked: false,
      after_blocked: false,
      is_new: false,
      is_removed: false,
    },
  ],
};

function renderChart(row: GanttProjectRow = project(), { host = true }: { host?: boolean } = {}) {
  const chart = (
    <GanttChart
      rows={[row]}
      zoom="weeks"
      expandedIds={new Set([row.project_id])}
      onToggleExpand={() => undefined}
      onFreezeClick={() => undefined}
      canWrite
    />
  );
  return renderWithProviders(host ? <StepTimingProvider>{chart}</StepTimingProvider> : chart);
}

function drag(el: Element, fromX: number, toX: number, { cancel = false }: { cancel?: boolean } = {}) {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: fromX });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: toX });
  if (cancel) fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.pointerUp(el, { pointerId: 1, button: 0, clientX: toX });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.setStepTiming.mockResolvedValue(response());
  sse.streamSolverProgress.mockResolvedValue({ status: 'completed' });
  changesApi.fetchScheduleRunChanges.mockResolvedValue(CHANGES);
});

describe('timing_editable gating (served, ADR 0019 §4)', () => {
  it.each<[TimingEditable, boolean, boolean]>([
    ['move_resize', true, true],
    ['resize', false, true],
    ['none', false, false],
  ])('%s → body handle %s, right-edge handle %s', (editable, body, edge) => {
    renderChart(project({ timing_editable: editable }));
    expect(screen.queryAllByTestId('step-drag-body')).toHaveLength(body ? 1 : 0);
    expect(screen.queryAllByTestId('step-drag-handle')).toHaveLength(edge ? 1 : 0);
    expect(screen.queryAllByRole('button', { name: /Edit timing for Prototype build/ })).toHaveLength(edge ? 1 : 0);
  });

  it('a skipped step has no handles even if editable is served', () => {
    renderChart(project({ skipped: true, planned_start_week: null, planned_end_week: null }));
    expect(screen.queryByTestId('step-drag-overlay')).not.toBeInTheDocument();
  });

  it('without a host (read-only page) nothing is draggable', () => {
    renderChart(project(), { host: false });
    expect(screen.queryByTestId('step-drag-overlay')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit timing/ })).not.toBeInTheDocument();
  });
});

describe('pointer drag', () => {
  it('moving the bar body snaps to whole weeks, shows a ghost + week label, and sends start_not_before_week', async () => {
    renderChart();
    const body = screen.getByTestId('step-drag-body');
    fireEvent.pointerDown(body, { pointerId: 1, button: 0, clientX: 200 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 200 + 3 * WEEK_PX + 4 });
    expect(screen.getByTestId('step-drag-ghost')).toBeInTheDocument();
    expect(screen.getByTestId('step-drag-label')).toHaveTextContent('Start ≥ W13 · W13–W16');
    fireEvent.pointerUp(body, { pointerId: 1, button: 0, clientX: 200 + 3 * WEEK_PX + 4 });
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { start_not_before_week: 13 }));
  });

  it('dragging the right edge sends duration_override_weeks (effective duration + Δ)', async () => {
    api.setStepTiming.mockResolvedValue(response({ duration_override_weeks: 6, start_not_before_week: null, effective_duration_weeks: 6 }));
    renderChart();
    drag(screen.getByTestId('step-drag-handle'), 300, 300 + 2 * WEEK_PX);
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { duration_override_weeks: 6 }));
  });

  it('a started step resizes from its served effective duration, not the drawn tail', async () => {
    renderChart(project({ status: 'In Progress', timing_editable: 'resize', duration_weeks: 6, planned_start_week: 10, planned_end_week: 11 }));
    drag(screen.getByTestId('step-drag-handle'), 300, 300 + WEEK_PX);
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { duration_override_weeks: 7 }));
  });

  it('Escape cancels a drag: no ghost, no request', () => {
    renderChart();
    drag(screen.getByTestId('step-drag-body'), 200, 260, { cancel: true });
    expect(screen.queryByTestId('step-drag-ghost')).not.toBeInTheDocument();
    expect(api.setStepTiming).not.toHaveBeenCalled();
  });

  it('a drop under half a week sends nothing', () => {
    renderChart();
    drag(screen.getByTestId('step-drag-body'), 200, 205);
    expect(api.setStepTiming).not.toHaveBeenCalled();
  });

  it('keeps the ghost while saving, then rolls it back on a 409 with the coded copy', async () => {
    let reject: (e: unknown) => void = () => undefined;
    api.setStepTiming.mockReturnValue(new Promise((_, r) => { reject = r; }));
    renderChart();
    drag(screen.getByTestId('step-drag-body'), 200, 200 + 2 * WEEK_PX);
    expect(await screen.findByTestId('step-drag-label')).toHaveTextContent('Saving…');
    reject(new ApiError(409, 'Conflict', 'The project is frozen.', 'PROJECT_FROZEN'));
    expect(await screen.findByTestId('step-timing-notice')).toHaveTextContent('This project is frozen');
    expect(screen.queryByTestId('step-drag-ghost')).not.toBeInTheDocument();
  });
});

describe('recalc_status outcomes', () => {
  it('queued: follows the run, then shows the served "Timeline updated" panel', async () => {
    renderChart();
    drag(screen.getByTestId('step-drag-body'), 200, 200 + 3 * WEEK_PX);
    const panel = await screen.findByTestId('step-timing-panel');
    await waitFor(() => expect(panel).toHaveAttribute('data-kind', 'updated'));
    expect(sse.streamSolverProgress).toHaveBeenCalledWith('run-2', expect.any(Function), expect.anything());
    expect(changesApi.fetchScheduleRunChanges).toHaveBeenCalledWith('run-2', 'run-1', expect.anything());
    expect(within(panel).getByText('Timeline updated')).toBeInTheDocument();
    expect(await within(panel).findByText(/Prototype build: 4 wks \(lead-time table\) · earliest start W13/)).toBeInTheDocument();
    expect(await within(panel).findByTestId('timeline-own-change')).toHaveTextContent('+3 wk');
  });

  it('queued but the run fails: says the timing is saved and the timeline is stale', async () => {
    sse.streamSolverProgress.mockResolvedValue({ status: 'failed', error: 'Solver crashed.' });
    renderChart();
    drag(screen.getByTestId('step-drag-body'), 200, 200 + WEEK_PX);
    expect(await screen.findByTestId('step-timing-notice')).toHaveTextContent(
      'Solver crashed. The timing is saved and the timeline is marked stale.',
    );
  });

  it('deferred: "updates automatically" and starts the follow-up watcher (ADR 0023)', async () => {
    api.setStepTiming.mockResolvedValue(response({ recalc_status: 'deferred', schedule_run_id: null, baseline_run_id: null, task_id: null }));
    renderChart();
    drag(screen.getByTestId('step-drag-body'), 200, 200 + WEEK_PX);
    expect(await screen.findByTestId('step-timing-notice')).toHaveTextContent(
      'Saved — the timeline updates automatically after the current recalculation',
    );
    expect(followUp.start).toHaveBeenCalledTimes(1);
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
  });

  it('not_needed: the skipped-lab-step copy, no run', async () => {
    api.setStepTiming.mockResolvedValue(response({ recalc_status: 'not_needed', schedule_run_id: null, baseline_run_id: null, task_id: null }));
    renderChart();
    drag(screen.getByTestId('step-drag-handle'), 300, 300 + WEEK_PX);
    expect(await screen.findByTestId('step-timing-notice')).toHaveTextContent('needs no certification testing');
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
  });

  it('unchanged: says nothing changed, no run', async () => {
    api.setStepTiming.mockResolvedValue(response({ recalc_status: 'unchanged', schedule_run_id: null, baseline_run_id: null, task_id: null }));
    renderChart();
    drag(screen.getByTestId('step-drag-body'), 200, 200 + WEEK_PX);
    expect(await screen.findByTestId('step-timing-notice')).toHaveTextContent('Nothing changed');
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
  });

  it.each([
    ['PROJECT_FROZEN', 'This project is frozen'],
    ['NOT_SCHEDULABLE', "status is not scheduled"],
    ['STEP_DONE', 'This step is Done'],
    ['STEP_STARTED', 'its start is fixed'],
    ['STEP_SKIPPED', 'skipped for the project (0 weeks)'],
  ])('409 %s: honest copy, nothing saved', async (code, text) => {
    api.setStepTiming.mockRejectedValue(new ApiError(409, 'Conflict', 'detail', code));
    renderChart();
    drag(screen.getByTestId('step-drag-body'), 200, 200 + WEEK_PX);
    const notice = await screen.findByTestId('step-timing-notice');
    expect(notice).toHaveTextContent(text);
    expect(notice).toHaveTextContent('Nothing was saved.');
    expect(notice).toHaveAttribute('role', 'alert');
  });
});

describe('"Edit timing" dialog (keyboard alternative)', () => {
  it('sends only the changed duration', async () => {
    const user = userEvent.setup();
    renderChart();
    await user.click(screen.getByRole('button', { name: 'Edit timing for Prototype build (Cooler Alpha)' }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    const duration = within(dialog).getByLabelText('Duration (weeks)');
    expect(duration).toHaveValue(4);
    await user.clear(duration);
    await user.type(duration, '6');
    await user.click(within(dialog).getByRole('button', { name: 'Save timing' }));
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { duration_override_weeks: 6 }));
  });

  it('sets and clears the earliest start week', async () => {
    const user = userEvent.setup();
    renderChart(project({ start_not_before_week: 20 }));
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    const start = within(dialog).getByLabelText('Earliest start week');
    expect(start).toHaveValue(20);
    await user.clear(start);
    await user.click(within(dialog).getByRole('button', { name: 'Save timing' }));
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { start_not_before_week: null }));
  });

  it('validates the range client-side and sends nothing', async () => {
    const user = userEvent.setup();
    renderChart();
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    const start = within(dialog).getByLabelText('Earliest start week');
    await user.type(start, '99');
    await user.click(within(dialog).getByRole('button', { name: 'Save timing' }));
    expect(await within(dialog).findByText('Enter a week of 1–52, or leave it blank.')).toBeInTheDocument();
    expect(api.setStepTiming).not.toHaveBeenCalled();
  });

  it('"Reset timing" sends both fields as null, and is disabled with no edit', async () => {
    const user = userEvent.setup();
    const { unmount } = renderChart();
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    expect(within(await screen.findByTestId('step-timing-dialog')).getByRole('button', { name: 'Reset timing' })).toBeDisabled();
    unmount();

    renderChart(project({ duration_override_weeks: 6, duration_weeks: 6 }));
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    await user.click(within(await screen.findByTestId('step-timing-dialog')).getByRole('button', { name: 'Reset timing' }));
    await waitFor(() =>
      expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { duration_override_weeks: null, start_not_before_week: null }),
    );
  });

  it('a started step (resize) offers the duration only', async () => {
    const user = userEvent.setup();
    renderChart(project({ status: 'In Progress', timing_editable: 'resize' }));
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    expect(within(dialog).getByLabelText('Earliest start week')).toBeDisabled();
    expect(dialog).toHaveTextContent('its start is fixed');
  });

  it('has no serious/critical axe violations', async () => {
    const user = userEvent.setup();
    renderChart(project({ duration_override_weeks: 6 }));
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    expect(await seriousAxeViolations(dialog)).toEqual([]);
  });
});

describe('row markers', () => {
  it('shows "edited" when an override or floor is set, with the served values', () => {
    renderChart(project({ duration_override_weeks: 6, start_not_before_week: 40, lead_time_weeks: 4 }));
    const marker = screen.getByTestId('step-timing-edited');
    expect(marker).toHaveTextContent('edited');
    expect(marker).toHaveAttribute('title', 'Timing edited: duration 6 wks (table 4) · earliest start W40');
  });

  it('no marker without an edit', () => {
    renderChart();
    expect(screen.queryByTestId('step-timing-edited')).not.toBeInTheDocument();
  });

  it('the project row shows the VIP badge and the served tracking chip', () => {
    renderChart(project({}, { is_vip: true, tracking_status: 'overdue' }));
    const row = screen.getByTestId('gantt-project-row');
    expect(within(row).getByTestId('vip-badge')).toBeInTheDocument();
    expect(within(row).getByTestId('tracking-status-chip')).toHaveAttribute('data-tracking', 'overdue');
  });

  it('chart with handles + markers has no serious/critical axe violations', async () => {
    const { container } = renderChart(project({ duration_override_weeks: 6 }, { is_vip: true, tracking_status: 'live' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
