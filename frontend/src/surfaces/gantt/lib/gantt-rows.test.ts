import { describe, expect, it } from 'vitest';

import { buildVisualRows, visualRowHeight } from './gantt-rows';
import { PROJECT_ROW_HEIGHT, STEP_ROW_HEIGHT } from './gantt-coordinates';
import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { P13_GANTT_ROW_DEFAULTS } from '../test-fixtures';

function step(seq: number, start: number, end: number): GanttStepRow {
  return {
    step_id: `PDD-${String.fromCharCode(64 + seq)}`,
    step_name: `Step ${String(seq)}`,
    kind: seq % 2 === 0 ? 'lab' : 'design',
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
    duration_override_weeks: null,
    start_not_before_week: null,
    timing_editable: 'none',
    span_fte: null,
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
