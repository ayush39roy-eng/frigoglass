import { describe, expect, it } from 'vitest';

import { importScale, moveDrop } from './gantt-geometry';
import { SIMULATE_RESPONSE } from './test-fixtures';
import type { OverlapStep } from '@/surfaces/gantt/lib/step-overlap';

const scale = importScale(SIMULATE_RESPONSE);
const project = SIMULATE_RESPONSE.projects[0];
if (!project) throw new Error('fixture');
const siblings: OverlapStep[] = project.steps.map((s) => {
  const m = SIMULATE_RESPONSE.steps_meta.find((x) => x.step_id === s.step_id);
  return {
    stepId: s.step_id,
    startWeek: s.start_week,
    endWeek: s.end_week,
    skipped: s.skipped || s.done_before_import,
    predecessorIds: m?.predecessor_ids ?? [],
    overlapWeeks: s.overlap_weeks,
    name: m?.name ?? s.step_id,
    kind: s.kind,
  };
});
const stepE = project.steps.find((s) => s.step_id === 'PDD-E');
if (!stepE) throw new Error('fixture');

describe('import Gantt geometry', () => {
  it('P53 (R53-6): the axis runs from the year start to the last finish, rounded up to a year end — never to H', () => {
    // Plan until 104 (fixture), cw 42: 2026 W1 .. 2027 W52 at least.
    expect(scale.originWeek).toBe(1);
    expect(scale.horizonWeeks % 52).toBe(0);
    expect(scale.horizonWeeks).toBeGreaterThanOrEqual(104);
    const early = { ...SIMULATE_RESPONSE, projects: [], horizon_weeks: 302 };
    expect(importScale(early).horizonWeeks).toBe(104);
    // A served last finish in 2029 → the axis ends at 2029 W52 (week 208), not at H.
    expect(importScale({ ...early, last_finish_week: 170 }).horizonWeeks).toBe(208);
    // Plan year 2027 (cw 57): the axis starts at 2027 W1.
    expect(importScale({ ...early, current_week: 57, plan_year_end_week: 104, plan_until_week: null }).originWeek).toBe(53);
  });

  it('a later drop is a floor without overlap', () => {
    const r = moveDrop(stepE, siblings, 3 * 16, scale, 42, 2026);
    expect(r.edit).toEqual({ start_not_before_week: 49, overlap_weeks: null });
    expect(r.label).toBe("Earliest start W49 '26");
  });

  it('a drop onto the step above is an overlap, labelled with the same-designer note', () => {
    const r = moveDrop(stepE, siblings, -2 * 16, scale, 42, 2026);
    expect(r.edit).toEqual({ start_not_before_week: 44, overlap_weeks: 2 });
    expect(r.label).toBe('Parallel with Design Freeze · 2 wk overlap · same designer — will start when they are free');
  });

  it('is clamped at the predecessor start; no move sends nothing', () => {
    expect(moveDrop(stepE, siblings, -10 * 16, scale, 42, 2026).edit).toEqual({
      start_not_before_week: 42,
      overlap_weeks: 4,
    });
    expect(moveDrop(stepE, siblings, 0, scale, 42, 2026).edit).toBeNull();
  });
});
