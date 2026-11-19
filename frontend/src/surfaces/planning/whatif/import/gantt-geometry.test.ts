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
  it('the axis runs from the served current week to the served horizon (P51, ADR 0062)', () => {
    // horizon_weeks 130 (plan_until 104 + 26) = W26 2028.
    expect(scale).toEqual({ originWeek: 42, horizonWeeks: 89, weekWidthPx: 16, totalWidthPx: 89 * 16 });
    // Served end weeks no longer shorten or stretch the axis.
    const early = { ...SIMULATE_RESPONSE, projects: [] };
    expect(importScale(early).horizonWeeks).toBe(130 - 42 + 1);
    expect(importScale({ ...SIMULATE_RESPONSE, horizon_weeks: 98 }).horizonWeeks).toBe(98 - 42 + 1);
    // A horizon before today still draws one week.
    expect(importScale({ ...SIMULATE_RESPONSE, horizon_weeks: 30 }).horizonWeeks).toBe(1);
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
