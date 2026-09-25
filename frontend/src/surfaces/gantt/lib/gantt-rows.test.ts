import { describe, expect, it } from 'vitest';

import { buildVisualRows, visualRowHeight, weeklyStepDensity } from './gantt-rows';
import { PROJECT_ROW_HEIGHT, STEP_ROW_HEIGHT } from './gantt-coordinates';
import type { GanttProjectRow, GanttStepRow } from '../api/types';

function step(seq: number, start: number, end: number): GanttStepRow {
  return {
    step_id: `PDD-${String.fromCharCode(64 + seq)}`,
    step_name: `Step ${String(seq)}`,
    kind: seq % 2 === 0 ? 'lab' : 'design',
    sequence_order: seq,
    duration_weeks: end - start + 1,
    planned_start_week: start,
    planned_end_week: end,
    actual_start_week: null,
    actual_end_week: null,
    assigned_engineer_name: null,
    assigned_chamber_code: null,
    eng_conflict: false,
    chamber_overlap: false,
  };
}

function project(id: string, steps: GanttStepRow[]): GanttProjectRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'A',
    priority: 'P2',
    frozen: false,
    delay_weeks: 0,
    left_out: false,
    spillover: false,
    cat_not_allowed: false,
    steps,
  };
}

describe('buildVisualRows', () => {
  const rows = [
    project('a', [step(2, 5, 6), step(1, 1, 3)]),
    project('b', [step(1, 1, 2)]),
  ];

  it('collapsed: one visual row per project', () => {
    const visual = buildVisualRows(rows, new Set());
    expect(visual).toHaveLength(2);
    expect(visual.every((v) => v.kind === 'project')).toBe(true);
  });

  it('expanded: project row followed by its step rows, sorted by sequence_order', () => {
    const visual = buildVisualRows(rows, new Set(['a']));
    expect(visual.map((v) => v.kind)).toEqual(['project', 'step', 'step', 'project']);
    const stepRows = visual.filter((v) => v.kind === 'step');
    expect(stepRows.map((v) => (v.kind === 'step' ? v.step.sequence_order : 0))).toEqual([1, 2]);
  });

  it('row heights are fixed and known ahead of layout', () => {
    const visual = buildVisualRows(rows, new Set(['a']));
    expect(visualRowHeight(visual[0])).toBe(PROJECT_ROW_HEIGHT);
    expect(visualRowHeight(visual[1])).toBe(STEP_ROW_HEIGHT);
  });
});

describe('weeklyStepDensity — view-derived scan aid', () => {
  it('counts step bars intersecting each week across the shown projects', () => {
    const rows = [
      project('a', [step(1, 1, 2), step(2, 2, 3)]),
      project('b', [step(1, 2, 2)]),
    ];
    const density = weeklyStepDensity(rows, 78);
    expect(density[1]).toBe(1); // only a.step1
    expect(density[2]).toBe(3); // a.step1 + a.step2 + b.step1
    expect(density[3]).toBe(1); // a.step2
    expect(density[4]).toBe(0);
    expect(density).toHaveLength(79);
  });

  it('ignores unscheduled steps', () => {
    const s = step(1, 1, 2);
    s.planned_start_week = null;
    const density = weeklyStepDensity([project('a', [s])], 78);
    expect(density.every((c) => c === 0)).toBe(true);
  });
});
