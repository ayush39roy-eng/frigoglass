import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { makeWeekScale, plannedSpan } from '../lib/gantt-coordinates';
import { actualSlots } from '../lib/step-colors';
import { P13_GANTT_ROW_DEFAULTS, P40_GANTT_STEP_PIN_DEFAULTS } from '../test-fixtures';
import { GanttBarGroup, GanttHatchDefs } from './gantt-bars';
import { GanttProjectLine } from './gantt-project-line';

/** P40-T01: the per-step colours on the project line and on the step bars. */

const scale = makeWeekScale(16);

function step(letter: string, seq: number, start: number, end: number, over: Partial<GanttStepRow> = {}): GanttStepRow {
  return {
    step_id: `PDD-${letter}`,
    step_name: `Step ${letter}`,
    kind: 'design',
    sequence_order: seq,
    skipped: false,
    status: 'Not Started',
    percent_complete: 0,
    duration_weeks: end - start + 1,
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
    ...over,
  };
}

function project(steps: GanttStepRow[], over: Partial<GanttProjectRow> = {}): GanttProjectRow {
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
    steps,
    ...over,
  };
}

function draw(p: GanttProjectRow, compact = false, delayedEndWeek: number | null = null) {
  const planned = plannedSpan(p.steps);
  return render(
    <svg>
      <GanttHatchDefs slots={actualSlots(p.steps)} />
      <GanttProjectLine
        project={p}
        scale={scale}
        rowHeight={58}
        compact={compact}
        planned={planned}
        plannedEndWeek={planned?.endWeek ?? null}
        delayedEndWeek={delayedEndWeek}
        title="Cooler Alpha"
      />
    </svg>,
  );
}

describe('GanttProjectLine (P40-T01)', () => {
  it('draws one segment per non-skipped step at its served weeks, in its step colour, with the step letter in the step ink', () => {
    const p = project([
      step('A', 1, 1, 2),
      step('B', 2, 3, 6),
      step('C', 3, 7, 7, { skipped: true }),
      step('E', 5, 5, 9), // parallel with B: overlaps, drawn on top
    ]);
    const { container } = draw(p);
    const segs = [...container.querySelectorAll('rect[data-bar="planned"]')];
    expect(segs.map((r) => r.getAttribute('data-step'))).toEqual(['PDD-A', 'PDD-B', 'PDD-E']);
    expect(segs.map((r) => r.getAttribute('fill'))).toEqual([
      'hsl(var(--step-1))',
      'hsl(var(--step-2))',
      'hsl(var(--step-5))',
    ]);
    const b = segs[1];
    expect(b).toHaveAttribute('x', String(2 * 16));
    expect(b).toHaveAttribute('width', String(4 * 16));
    // Overlap stays visible: a thin surface edge on every solid segment.
    expect(b).toHaveAttribute('stroke', 'hsl(var(--color-surface))');
    const letters = [...container.querySelectorAll('[data-testid="gantt-step-letter"]')];
    expect(letters.map((t) => t.textContent)).toEqual(['A', 'B', 'E']);
    expect(letters[0]).toHaveAttribute('fill', 'hsl(var(--step-ink-1))');
    expect(letters[1]).toHaveAttribute('fill', 'hsl(var(--step-ink-2))');
    // Each segment names its step on hover.
    expect(container.querySelectorAll('title')[1]?.textContent).toMatch(/^A · Step A · planned/);
  });

  it('elapsed = step tint with a step-colour outline; actual = the step hatch; frozen = dashed outline; delay = red connector', () => {
    const p = project(
      [
        step('A', 1, 1, 2, { kind: 'elapsed' }),
        step('D', 4, 3, 6, { actual_start_week: 4, actual_end_week: 8 }),
      ],
      { frozen: true },
    );
    const { container, getByTestId } = draw(p, false, 9);
    const elapsed = container.querySelector('rect[data-bar="elapsed"]');
    expect(elapsed).toHaveAttribute('fill', 'hsl(var(--step-1) / 0.18)');
    expect(elapsed).toHaveAttribute('stroke', 'hsl(var(--step-1))');
    const actual = container.querySelector('rect[data-bar="actual"]');
    expect(actual).toHaveAttribute('fill', 'url(#gantt-hatch-step-4)');
    expect(actual).toHaveAttribute('stroke', 'hsl(var(--step-4))');
    expect(container.querySelector('pattern#gantt-hatch-step-4')).toBeTruthy();
    expect(getByTestId('gantt-frozen-outline')).toHaveAttribute('stroke-dasharray', '3 2');
    expect(getByTestId('gantt-delay-connector')).toBeTruthy();
  });

  it('compact (Forest view): a thin line, no letters', () => {
    const { container } = draw(project([step('A', 1, 1, 4), step('B', 2, 5, 9)]), true);
    const seg = container.querySelector('rect[data-bar="planned"]');
    expect(seg).toHaveAttribute('height', '8');
    expect(container.querySelector('[data-testid="gantt-step-letter"]')).toBeNull();
  });

  it('a project with no placed step draws nothing', () => {
    const { container } = draw(project([step('A', 1, 1, 2, { planned_start_week: null, planned_end_week: null })]));
    expect(container.querySelector('[data-testid="gantt-project-line"]')).toBeNull();
  });
});

describe('GanttBarGroup with a step colour (P40-T01 step rows)', () => {
  it('plan solid in the step colour, actual hatched in it; without a colour the old palette stays', () => {
    const color = { slot: 9, fill: 'hsl(var(--step-9))', ink: 'hsl(var(--step-ink-9))', letter: 'I' as const };
    const { container } = render(
      <svg>
        <GanttBarGroup
          scale={scale}
          y={0}
          rowHeight={28}
          planned={{ startWeek: 2, endWeek: 4 }}
          actual={{ startWeek: 3, endWeek: 6 }}
          plannedEndWeek={4}
          delayedEndWeek={6}
          frozen={false}
          title="t"
          compact
          color={color}
        />
      </svg>,
    );
    expect(container.querySelector('rect[data-bar="planned"]')).toHaveAttribute('fill', 'hsl(var(--step-9))');
    expect(container.querySelector('rect[data-bar="planned"]')).toHaveAttribute('data-step-slot', '9');
    expect(container.querySelector('rect[data-bar="actual"]')).toHaveAttribute('fill', 'url(#gantt-hatch-step-9)');
  });
});
