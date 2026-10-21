import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { makeWeekScale } from '../lib/gantt-coordinates';
import { GANTT_NARROW_MAX_PX, ganttColumnWidths, placeDragLabel } from '../lib/gantt-layout';
import { projectStatusLabels, stepStatusLabels } from '../lib/gantt-status-labels';
import { P13_GANTT_ROW_DEFAULTS } from '../test-fixtures';
import { GanttChart } from './gantt-chart';
import { StepDragOverlay } from './step-timing/step-drag-overlay';
import { StepTimingContext, stepTimingTarget, type StepTimingApi } from './step-timing/step-timing-context';

/**
 * P19-R02 — gate remediation for QA-P19-1 (skipped-step badge dimmed by
 * opacity), QA-P19-2 (fixed columns wider than the 390 px chart) and
 * observation O1 (drag label cut off under the status column near W52).
 */

// Deterministic virtualization: render every visual row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
  }),
}));

function step(over: Partial<GanttStepRow> = {}): GanttStepRow {
  return {
    step_id: 'PDD-E',
    step_name: 'Design Detailing',
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
    ...over,
  };
}

const SKIPPED_LAB = step({
  step_id: 'PDD-F',
  step_name: 'Proof of Concept',
  kind: 'lab',
  sequence_order: 6,
  skipped: true,
  duration_weeks: 0,
  planned_start_week: 14,
  planned_end_week: 14,
  timing_editable: 'none',
});

function project(over: Partial<GanttProjectRow> = {}, steps: GanttStepRow[] = [step(), SKIPPED_LAB]): GanttProjectRow {
  return {
    project_id: 'p1',
    project_name: 'Cooler Alpha with a long project name',
    hub: 'R&D-Greece',
    category: 'B',
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
    steps,
    ...over,
  };
}

/** Make `(max-width: 767px)` match (a 390 px phone) or not (1440 desktop). */
function setViewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: /max-width:\s*(\d+)px/.test(query) ? width <= Number(/max-width:\s*(\d+)px/.exec(query)![1]) : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

const HOST: StepTimingApi = { submit: vi.fn(), openDialog: vi.fn(), pending: null, busy: false };

function renderChart(row: GanttProjectRow = project(), canWrite = true) {
  return renderWithProviders(
    <StepTimingContext.Provider value={HOST}>
      <GanttChart
        rows={[row]}
        zoom="weeks"
        expandedIds={new Set([row.project_id])}
        onToggleExpand={() => undefined}
        onFreezeClick={() => undefined}
        canWrite={canWrite}
      />
    </StepTimingContext.Provider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('QA-P19-1: a skipped step is not dimmed with opacity', () => {
  it.each([1440, 390])('at %i px the lab badge has no opacity-dimmed ancestor; the name is muted + struck through', (width) => {
    setViewport(width);
    renderChart();
    const rows = screen.getAllByTestId('gantt-step-row');
    const skippedRow = rows.find((r) => r.querySelector('[data-skipped]'))!;
    const badge = skippedRow.querySelector('[data-kind="lab"]') as HTMLElement;
    expect(badge).toBeInTheDocument();
    for (let el: HTMLElement | null = badge; el && el !== skippedRow.parentElement; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)opacity-/);
      expect(el.style.opacity).toBe('');
    }
    const name = within(skippedRow).getByTestId('gantt-step-name');
    expect(name.className).toMatch(/line-through/);
    expect(name.className).toMatch(/text-text-muted/);
    expect(name).toHaveTextContent('(skipped)');
  });

  it('nothing in the Gantt uses an opacity class on text', () => {
    setViewport(1440);
    const { container } = renderChart(project({ frozen: true, schedule_stale: true }));
    expect(container.querySelectorAll('[class*="opacity-"]')).toHaveLength(0);
    expect(container.querySelectorAll('[class*="text-text-subtle/"]')).toHaveLength(0);
  });

  it('a skipped row has no serious axe violation', async () => {
    setViewport(1440);
    const { container } = renderChart();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('QA-P19-2: responsive fixed columns', () => {
  it('pure widths: 272 + 148 wide; narrow = one name column (40 % of the chart, 88..124 px), no status column', () => {
    expect(GANTT_NARROW_MAX_PX).toBe(767);
    expect(ganttColumnWidths(false)).toEqual({ left: 272, status: 148 });
    expect(ganttColumnWidths(false, 1200)).toEqual({ left: 272, status: 148 });
    expect(ganttColumnWidths(true)).toEqual({ left: 124, status: 0 }); // not measured yet
    // 390 px phone with the app's icon rail: the chart box is 198 px wide.
    const phone = ganttColumnWidths(true, 198);
    expect(phone).toEqual({ left: 88, status: 0 });
    expect(198 - phone.left).toBeGreaterThan(phone.left); // the timeline keeps most of the width
    expect(ganttColumnWidths(true, 260)).toEqual({ left: 104, status: 0 });
    expect(ganttColumnWidths(true, 700)).toEqual({ left: 124, status: 0 });
  });

  it('1440: name column 272 px and a 148 px status column on every row (unchanged)', () => {
    setViewport(1440);
    renderChart();
    expect(screen.getByTestId('gantt-scroll')).toHaveAttribute('data-layout', 'wide');
    expect(screen.getByTestId('step-drag-handle')).toHaveStyle({ width: '8px' });
    expect(screen.getByTestId('gantt-left-header')).toHaveStyle({ width: '272px' });
    expect(screen.getByTestId('gantt-status-header')).toHaveStyle({ width: '148px' });
    const cells = screen.getAllByTestId('gantt-left-cell');
    cells.forEach((c) => expect(c).toHaveStyle({ width: '272px' }));
    expect(screen.getAllByTestId('gantt-status-cell')).toHaveLength(cells.length);
    expect(screen.queryByTestId('gantt-row-details')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open .* in the Project Workspace/ })).toBeInTheDocument();
  });

  it('390: one 124 px name column, no status column, the timeline region is labelled and focusable', () => {
    setViewport(390);
    renderChart();
    const region = screen.getByRole('region', { name: /Project timeline/ });
    expect(region).toHaveAttribute('data-layout', 'narrow');
    expect(region).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('gantt-left-header')).toHaveStyle({ width: '124px' });
    screen.getAllByTestId('gantt-left-cell').forEach((c) => expect(c).toHaveStyle({ width: '124px' }));
    expect(screen.queryByTestId('gantt-status-header')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('gantt-status-cell')).toHaveLength(0);
    // Row meta, priority, workspace link and freeze are not crammed into the row.
    expect(screen.queryByTestId('gantt-row-meta')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Project Workspace/ })).not.toBeInTheDocument();
    // The skipped step says so in words, since the n/a chip column is gone.
    expect(screen.getByTestId('gantt-step-skipped')).toHaveTextContent('n/a');
    // Drag handles still render, with a wider touch target.
    expect(screen.getByTestId('step-drag-handle')).toHaveStyle({ width: '20px' });
    // ... and the keyboard route stays: the Edit timing button on the step row.
    expect(screen.getByRole('button', { name: /Edit timing for Design Detailing/ })).toBeInTheDocument();
  });

  it('390: the status flags are a compact row icon and live in the details dialog', async () => {
    setViewport(390);
    const user = userEvent.setup();
    renderChart(project({ frozen: true, spillover: true }));
    const details = screen.getByTestId('gantt-row-details');
    expect(details).toHaveAccessibleName(/Details for Cooler Alpha.*status: Frozen, Spillover/);
    expect(screen.getByTestId('gantt-row-flag-dot')).toBeInTheDocument();
    await user.click(details);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Frozen')).toBeInTheDocument();
    expect(within(dialog).getByText('Spillover')).toBeInTheDocument();
    expect(within(dialog).getByTestId('gantt-row-meta')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Open in Project Workspace/ })).toHaveAttribute('href', '/projects/p1');
    expect(within(dialog).getByRole('button', { name: 'Unfreeze project' })).toBeInTheDocument();
    expect(await seriousAxeViolations(dialog)).toEqual([]);
  });

  it('390: a step flag is an icon with an accessible label', () => {
    setViewport(390);
    renderChart(project({}, [step({ eng_conflict: true })]));
    expect(screen.getByTestId('gantt-step-flag')).toHaveAccessibleName('Status: Eng. conflict');
  });

  it('status labels are the served flags in chip order', () => {
    expect(projectStatusLabels(project())).toEqual([]);
    expect(
      projectStatusLabels(project({ frozen: true, delay_weeks: 2, left_out: true, blocked: true, schedule_stale: true })),
    ).toEqual(['Frozen', 'Delay +2w', 'Spillover · unplaced', 'On Hold', 'Stale']);
    expect(stepStatusLabels(SKIPPED_LAB)).toEqual(['Skipped (n/a)']);
    expect(stepStatusLabels(step({ status: 'Blocked', chamber_overlap: true }))).toEqual(['On Hold', 'Chamber overlap']);
  });
});

describe('O1: the drag label flips to stay inside the visible timeline', () => {
  it('pure placement: right of the anchor by default, flipped left near the right edge, clamped, unmeasured = default', () => {
    const base = { gap: 6, visibleLeft: 0, visibleRight: 500, labelWidth: 120 };
    expect(placeDragLabel({ ...base, anchorX: 200 })).toEqual({ left: 206, side: 'right' });
    expect(placeDragLabel({ ...base, anchorX: 374 })).toEqual({ left: 380, side: 'right' }); // 380 + 120 = 500 fits
    expect(placeDragLabel({ ...base, anchorX: 400 })).toEqual({ left: 274, side: 'left' });
    expect(placeDragLabel({ ...base, anchorX: 60, visibleRight: 150 })).toEqual({ left: 0, side: 'left' });
    expect(placeDragLabel({ ...base, anchorX: 400, visibleLeft: 0, visibleRight: 0 })).toEqual({ left: 406, side: 'right' });
  });

  function renderOverlay(viewportRight: number, viewportLeft = 0) {
    const host = HOST;
    const p = project({}, [step({ planned_start_week: 46, planned_end_week: 50 })]);
    const t = stepTimingTarget(p, p.steps[0]!);
    // Overlay starts at client x 0; the label is 160 px wide when measured.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(160);
    renderWithProviders(
      <StepTimingContext.Provider value={host}>
        <div style={{ position: 'relative' }}>
          <StepDragOverlay
            target={t}
            scale={makeWeekScale('weeks')}
            rowHeight={44}
            viewport={() => ({ left: viewportLeft, right: viewportRight })}
          />
        </div>
      </StepTimingContext.Provider>,
    );
    const handle = screen.getByTestId('step-drag-handle');
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 700 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 + 2 * 15 });
    return screen.getByTestId('step-drag-label');
  }

  it('near the right edge (W52) the label sits left of the cursor and inside the viewport', () => {
    const label = renderOverlay(800);
    const anchor = Number(label.dataset.anchor);
    expect(label).toHaveAttribute('data-side', 'left');
    expect(parseFloat(label.style.left)).toBe(anchor - 6 - 160);
    expect(parseFloat(label.style.left) + 160).toBeLessThanOrEqual(800);
  });

  it('a phone timeline narrower than the label: the label wraps to the visible width (never clipped)', () => {
    const label = renderOverlay(800, 690); // 110 px of visible timeline, as at 390 px
    expect(label).toHaveAttribute('data-wrapped', 'true');
    expect(label.style.maxWidth).toBe('106px');
    expect(label.style.whiteSpace).toBe('normal');
    expect(parseFloat(label.style.left)).toBeGreaterThanOrEqual(690);
    // the dragged row is raised above its neighbours while the label shows
    expect(screen.getByTestId('step-drag-overlay')).toHaveAttribute('data-dragging', 'true');
  });

  it('with room on the right the label stays right of the cursor', () => {
    const label = renderOverlay(2000);
    expect(label).toHaveAttribute('data-side', 'right');
    expect(parseFloat(label.style.left)).toBe(Number(label.dataset.anchor) + 6);
  });
});

describe('span_fte absent from an older server', () => {
  it('is treated as not served (null), so no label reads "undefined FTE"', () => {
    const p = project({}, [step()]);
    const legacy = { ...p.steps[0]! } as Partial<GanttStepRow>;
    delete legacy.span_fte;
    expect(stepTimingTarget(p, legacy as GanttStepRow).spanFte).toBeNull();
  });
});
