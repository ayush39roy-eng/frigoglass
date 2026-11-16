import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { GANTT_NARROW_MAX_PX, ganttColumnWidths } from '../lib/gantt-layout';
import { projectStatusLabels, stepStatusLabels } from '../lib/gantt-status-labels';
import { stepBarTitle } from '../lib/step-row-text';
import { P13_GANTT_ROW_DEFAULTS, P40_GANTT_STEP_PIN_DEFAULTS } from '../test-fixtures';
import { GanttChart } from './gantt-chart';

/**
 * P19-R02 — gate remediation for QA-P19-1 (skipped-step badge dimmed by
 * opacity) and QA-P19-2 (fixed columns wider than the 390 px chart). The
 * drag-label cases (O1, QA-P19-4, O-R1) went with the drag (P33-T15, ADR 0048).
 */

// Deterministic virtualization: render every visual row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
    measure: () => undefined,
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
    span_fte: null,
    effort_weeks: null,
    plan_weeks: 4,
    gap_weeks: 0,
    own_effort: false,
    predecessor_ids: [],
    ...P40_GANTT_STEP_PIN_DEFAULTS,
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

function renderChart(row: GanttProjectRow = project(), canWrite = true) {
  return renderWithProviders(
    <GanttChart
      rows={[row]}
      zoom="weeks"
      expandedIds={new Set([row.project_id])}
      onToggleExpand={() => undefined}
      onFreezeClick={() => undefined}
      canWrite={canWrite}
    />,
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
    // P33-T15 (ADR 0048): read-only — no drag handle and no Edit timing at any width.
    expect(screen.queryByTestId('step-drag-handle')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit timing/ })).not.toBeInTheDocument();
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

describe('P33-T15 (ADR 0048): read-only step rows with the served gap chip', () => {
  it.each([1440, 390])('at %i px: no drag overlay, handle, Edit timing or edited marker, with GANTT write', (width) => {
    setViewport(width);
    renderChart(project({}, [step({ gap_weeks: -2 }), step({ step_id: 'PDD-G', sequence_order: 7, gap_weeks: 3 })]), true);
    expect(screen.queryByTestId('step-drag-overlay')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-drag-body')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-drag-handle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-timing-edited')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit timing|Reset timing/ })).not.toBeInTheDocument();
  });

  it('1440: negative gap = "parallel N wk", positive = "wait N wk", zero and skipped = no chip; axe clean', async () => {
    setViewport(1440);
    const { container } = renderChart(
      project({}, [
        step({ gap_weeks: -2 }),
        step({ step_id: 'PDD-G', sequence_order: 7, gap_weeks: 3 }),
        step({ step_id: 'PDD-H', sequence_order: 8, gap_weeks: 0 }),
        { ...SKIPPED_LAB, gap_weeks: -1 },
      ]),
    );
    const chips = screen.getAllByTestId('step-gap-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent(/^parallel 2 wk/);
    expect(chips[0]).toHaveAttribute('title', expect.stringMatching(/in parallel .*2 wk overlap/));
    expect(chips[1]).toHaveTextContent(/^wait 3 wk/);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('the bar hover text names the template gap and an own-effort duration', () => {
    const title = stepBarTitle(step({ gap_weeks: 3, own_effort: true, effort_weeks: 4 }), { startWeek: 10, endWeek: 13 }, null);
    expect(title).toContain('template gap: wait 3 wk');
    expect(title).toContain('4 wks of work (client effort)');
    expect(stepBarTitle(step(), { startWeek: 10, endWeek: 13 }, null)).not.toMatch(/gap|client effort/);
  });
});

describe('span_fte absent from an older server', () => {
  it('is treated as not served (null), so no label reads "undefined FTE"', () => {
    const legacy = { ...step() } as Partial<GanttStepRow>;
    delete legacy.span_fte;
    const title = stepBarTitle(legacy as GanttStepRow, { startWeek: 10, endWeek: 13 }, null);
    expect(title).toContain('4 wks of work');
    expect(title).not.toMatch(/undefined/);
  });
});

describe('QA-P19-3: focus returns to the Details button when the dialog closes', () => {
  it.each(['click', 'keyboard'])('opened by %s, closed with Escape', async (how) => {
    setViewport(390);
    const user = userEvent.setup();
    renderChart(project({ frozen: true }));
    const details = screen.getByTestId('gantt-row-details');
    if (how === 'click') {
      await user.click(details);
    } else {
      details.focus();
      await user.keyboard('{Enter}');
    }
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(details).toHaveFocus();
  });

  it('closed with the Close button', async () => {
    setViewport(390);
    const user = userEvent.setup();
    renderChart();
    const details = screen.getByTestId('gantt-row-details');
    await user.click(details);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(details).toHaveFocus();
  });
});
