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
import { makeWeekScale } from '../../lib/gantt-coordinates';
import { StepDragOverlay } from './step-drag-overlay';
import { StepTimingContext, stepTimingTarget, type StepTimingApi, type StepTimingTarget } from './step-timing-context';
import { StepTimingDialog } from './step-timing-dialog';
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
    span_fte: null,
    effort_weeks: null,
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
    effort_weeks: null,
    lead_time_weeks: 4,
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
    const duration = within(dialog).getByLabelText('Work (weeks)');
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
    expect(marker).toHaveAttribute('title', 'Timing edited: work 6 wks (table 4) · earliest start W40');
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

describe('P20 (ADR 0032): calendar weeks vs work weeks', () => {
  /** A target as `stepTimingTarget` builds it, with a given served FTE. */
  function target(stepOver: Partial<GanttStepRow>, spanFte: number | null): StepTimingTarget {
    const p = project({ ...stepOver, span_fte: spanFte });
    return stepTimingTarget(p, p.steps[0]!);
  }

  function renderOverlay(t: StepTimingTarget) {
    const host: StepTimingApi = { submit: vi.fn(), openDialog: vi.fn(), pending: null, busy: false };
    renderWithProviders(
      <StepTimingContext.Provider value={host}>
        <div style={{ position: 'relative' }}>
          <StepDragOverlay target={t} scale={makeWeekScale('weeks')} rowHeight={44} />
        </div>
      </StepTimingContext.Provider>,
    );
    return host;
  }

  function resize(toDx: number) {
    const handle = screen.getByTestId('step-drag-handle');
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500 + toDx });
    const label = screen.queryByTestId('step-drag-label')?.textContent ?? null;
    fireEvent.pointerUp(handle, { pointerId: 1, button: 0, clientX: 500 + toDx });
    return label;
  }

  it('stepTimingTarget maps the served span_fte (and null stays null)', () => {
    const served = project({ span_fte: 0.5 });
    expect(stepTimingTarget(served, served.steps[0]!).spanFte).toBe(0.5);
    expect(stepTimingTarget(project(), project().steps[0]!).spanFte).toBeNull();
  });

  it('served span_fte 0.5 drives the chart drag: +2 calendar weeks sends 5 work weeks, not 6', async () => {
    api.setStepTiming.mockResolvedValue(response({ duration_override_weeks: 5, start_not_before_week: null, effective_duration_weeks: 5 }));
    renderChart(project({ planned_start_week: 10, planned_end_week: 17, span_fte: 0.5 }));
    const handle = screen.getByTestId('step-drag-handle');
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 300 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300 + 2 * WEEK_PX });
    expect(screen.getByTestId('step-drag-label')).toHaveTextContent('10 wks on the calendar · 5 wks of work at 0.5 FTE');
    fireEvent.pointerUp(handle, { pointerId: 1, button: 0, clientX: 300 + 2 * WEEK_PX });
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { duration_override_weeks: 5 }));
  });

  it('served span_fte null falls back 1:1: +2 calendar weeks sends 6 work weeks', async () => {
    api.setStepTiming.mockResolvedValue(response({ duration_override_weeks: 6, start_not_before_week: null, effective_duration_weeks: 6 }));
    renderChart(project({ span_fte: null }));
    drag(screen.getByTestId('step-drag-handle'), 300, 300 + 2 * WEEK_PX);
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { duration_override_weeks: 6 }));
  });

  it('at 1.0 FTE a +2 week drag sends 6 work weeks and says both figures', () => {
    const host = renderOverlay(target({}, 1));
    expect(resize(2 * WEEK_PX)).toBe('6 wks on the calendar · 6 wks of work at 1 FTE');
    expect(host.submit).toHaveBeenCalledWith(expect.anything(), { duration_override_weeks: 6 }, { startWeek: 10, endWeek: 15 });
  });

  it('at 0.5 FTE a +2 calendar-week drag sends 5 work weeks, not 6', () => {
    const host = renderOverlay(target({ planned_start_week: 10, planned_end_week: 17 }, 0.5));
    expect(resize(2 * WEEK_PX)).toBe('10 wks on the calendar · 5 wks of work at 0.5 FTE');
    expect(host.submit).toHaveBeenCalledWith(expect.anything(), { duration_override_weeks: 5 }, { startWeek: 10, endWeek: 19 });
  });

  it('at 0.63 FTE the label shows the snapped calendar span of the work sent', () => {
    const host = renderOverlay(target({ planned_start_week: 10, planned_end_week: 16 }, 0.63));
    expect(resize(WEEK_PX)).toBe('8 wks on the calendar · 5 wks of work at 0.63 FTE');
    expect(host.submit).toHaveBeenCalledWith(expect.anything(), { duration_override_weeks: 5 }, { startWeek: 10, endWeek: 17 });
  });

  it('with no served FTE the drag is unchanged and the label does not guess the calendar span', async () => {
    renderChart();
    const handle = screen.getByTestId('step-drag-handle');
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 300 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300 + 2 * WEEK_PX });
    expect(screen.getByTestId('step-drag-label')).toHaveTextContent("6 wks of work · calendar weeks follow the leader's FTE");
    fireEvent.pointerUp(handle, { pointerId: 1, button: 0, clientX: 300 + 2 * WEEK_PX });
    await waitFor(() => expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { duration_override_weeks: 6 }));
  });

  it('a lab step says it is not stretched by FTE', () => {
    renderOverlay(target({ kind: 'lab', step_id: 'PDD-F', step_name: 'Lab test' }, null));
    expect(resize(2 * WEEK_PX)).toBe('6 wks on the calendar · not stretched by FTE');
  });

  it('the step bar hover text names calendar weeks and work weeks', () => {
    const { container } = renderChart(project({ planned_start_week: 10, planned_end_week: 17 }));
    const titles = Array.from(container.querySelectorAll('title')).map((t) => t.textContent);
    expect(titles).toContain('Prototype build · planned W10–W17 on the calendar · 4 wks of work');
  });

  it('the step bar hover text adds the served FTE', () => {
    const { container } = renderChart(project({ planned_start_week: 10, planned_end_week: 17, span_fte: 0.5 }));
    const titles = Array.from(container.querySelectorAll('title')).map((t) => t.textContent);
    expect(titles).toContain('Prototype build · planned W10–W17 on the calendar · 4 wks of work at 0.5 FTE');
  });

  it('the dialog labels the field as work and shows the served bar as calendar weeks', async () => {
    const user = userEvent.setup();
    renderChart(project({ planned_start_week: 10, planned_end_week: 17 }));
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    expect(within(dialog).getByLabelText('Work (weeks)')).toHaveValue(4);
    const note = within(dialog).getByTestId('step-timing-weeks-note');
    expect(note).toHaveTextContent('Planned now: W10–W17 on the calendar · 4 wks of work.');
    expect(note).toHaveTextContent('at 0.5 FTE, 4 weeks of work take 8 calendar weeks');
  });

  it('the dialog adds "at 0.5 FTE" once the FTE is served', () => {
    renderWithProviders(
      <StepTimingDialog
        target={target({ planned_start_week: 10, planned_end_week: 17 }, 0.5)}
        busy={false}
        onOpenChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(screen.getByTestId('step-timing-weeks-note')).toHaveTextContent(
      'Planned now: W10–W17 on the calendar · 4 wks of work at 0.5 FTE.',
    );
  });

  it('a lab step keeps "Duration (weeks)" and says FTE does not stretch it', async () => {
    const user = userEvent.setup();
    renderChart(project({ kind: 'lab', step_name: 'Lab test' }));
    await user.click(screen.getByRole('button', { name: /Edit timing for Lab test/ }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    expect(within(dialog).getByLabelText('Duration (weeks)')).toHaveValue(4);
    expect(within(dialog).getByTestId('step-timing-weeks-note')).toHaveTextContent('not stretched by FTE');
  });
});

describe('P30 (ADR 0041 R4): effort values are not timing edits', () => {
  it('a step on its client effort figure has no "edited" marker, Reset is disabled, and the bar says "client effort"', async () => {
    const user = userEvent.setup();
    const { container } = renderChart(
      project({ effort_weeks: 4, lead_time_weeks: 10, duration_weeks: 4, planned_start_week: 10, planned_end_week: 13 }),
    );
    expect(screen.queryByTestId('step-timing-edited')).not.toBeInTheDocument();
    const titles = Array.from(container.querySelectorAll('title')).map((t) => t.textContent);
    expect(titles).toContain('Prototype build · planned W10–W13 on the calendar · 4 wks of work (client effort)');
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    expect(within(dialog).getByRole('button', { name: 'Reset timing' })).toBeDisabled();
    expect(dialog).toHaveTextContent('Lead-time table: 10 wks of work · client effort 4');
    expect(dialog).not.toHaveTextContent('overridden to');
  });

  it('a user value over an effort value: the marker names both baselines, Reset falls back to the effort and sends nulls', async () => {
    const user = userEvent.setup();
    renderChart(project({ effort_weeks: 4, lead_time_weeks: 10, duration_override_weeks: 6, duration_weeks: 6 }));
    expect(screen.getByTestId('step-timing-edited')).toHaveAttribute('title', 'Timing edited: work 6 wks (client effort 4, table 10)');
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    const dialog = await screen.findByTestId('step-timing-dialog');
    const reset = within(dialog).getByRole('button', { name: 'Reset timing' });
    expect(reset).toBeEnabled();
    expect(reset).toHaveAttribute('title', 'Clear your timing edit: the step goes back to the client effort figure (4 wks)');
    expect(dialog).toHaveTextContent('client effort 4 · overridden to 6');
    api.setStepTiming.mockResolvedValue(
      response({ duration_override_weeks: null, start_not_before_week: null, effective_duration_weeks: 4, effort_weeks: 4, lead_time_weeks: 10 }),
    );
    await user.click(reset);
    await waitFor(() =>
      expect(api.setStepTiming).toHaveBeenCalledWith('p1', 'PDD-E', { duration_override_weeks: null, start_not_before_week: null }),
    );
    const panel = await screen.findByTestId('step-timing-panel');
    await waitFor(() => expect(panel).toHaveTextContent('Prototype build: 4 wks (client effort) · no start floor'));
  });

  it('without an effort value Reset still names the lead-time table', async () => {
    const user = userEvent.setup();
    renderChart(project({ duration_override_weeks: 6, duration_weeks: 6, lead_time_weeks: 4 }));
    await user.click(screen.getByRole('button', { name: /Edit timing for Prototype build/ }));
    expect(within(await screen.findByTestId('step-timing-dialog')).getByRole('button', { name: 'Reset timing' })).toHaveAttribute(
      'title',
      'Clear your timing edit: the step goes back to the lead-time table (4 wks)',
    );
  });

  it('409 STEP_SKIPPED on a step the effort split zeroed shows the effort message inline; nothing saved', async () => {
    api.setStepTiming.mockRejectedValue(
      new ApiError(409, 'Conflict', "Step PDD-D is skipped: its effort share is 0 weeks; nothing to time.", 'STEP_SKIPPED'),
    );
    renderChart(project({ effort_weeks: 0, lead_time_weeks: 1 }));
    drag(screen.getByTestId('step-drag-body'), 200, 200 + 2 * WEEK_PX);
    const notice = await screen.findByTestId('step-timing-notice');
    expect(notice).toHaveTextContent("This step's share of the project's client effort figure is 0 weeks");
    expect(notice).toHaveTextContent('Nothing was saved.');
    expect(screen.queryByTestId('step-drag-ghost')).not.toBeInTheDocument();
  });

  it('a lead-0 STEP_SKIPPED keeps the generic copy', async () => {
    api.setStepTiming.mockRejectedValue(new ApiError(409, 'Conflict', 'Step has no lead time.', 'STEP_SKIPPED'));
    renderChart();
    drag(screen.getByTestId('step-drag-body'), 200, 200 + 2 * WEEK_PX);
    expect(await screen.findByTestId('step-timing-notice')).toHaveTextContent('This step is skipped for the project (0 weeks)');
  });

  it('a step skipped by the effort split says so on its name', () => {
    renderChart(project({ skipped: true, effort_weeks: 0, lead_time_weeks: 1, timing_editable: 'none', duration_weeks: 0 }));
    expect(screen.getByTestId('gantt-step-name')).toHaveAttribute(
      'title',
      "Prototype build — skipped: its share of the project's client effort figure is 0 weeks",
    );
  });

  it('stepTimingTarget carries the served effort_weeks (absent on an older API → null)', () => {
    expect(stepTimingTarget(project(), step({ effort_weeks: 3 })).effortWeeks).toBe(3);
    const legacy = step() as Partial<GanttStepRow>;
    delete legacy.effort_weeks;
    expect(stepTimingTarget(project(), legacy as GanttStepRow).effortWeeks).toBeNull();
  });
});
