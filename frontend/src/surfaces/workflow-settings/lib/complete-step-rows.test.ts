import { describe, expect, it } from 'vitest';

import { stage } from '@/surfaces/project-workspace/test-fixtures';
import { P13_GANTT_ROW_DEFAULTS } from '@/surfaces/gantt/test-fixtures';
import type { GanttProjectRow } from '@/surfaces/gantt/api/types';

import { completeStepRows, stageAsStepRow } from './complete-step-rows';

describe('completeStepRows (P33-T15: read-only, template copy carried verbatim)', () => {
  it('a missing stage becomes an unplaced row with the served gap / plan / own-effort fields', () => {
    const row = stageAsStepRow(stage(4, { gap_weeks: -2, plan_weeks: 5, own_effort: true, planned_start_week: 40 }));
    expect(row).toMatchObject({ step_id: 'PDD-E', gap_weeks: -2, plan_weeks: 5, own_effort: true });
    expect(row.planned_start_week).toBeNull();
    expect('timing_editable' in row).toBe(false);
  });

  it('adds only the missing steps, in sequence order', () => {
    const base = { steps: [stageAsStepRow(stage(1))] } as unknown as GanttProjectRow;
    const project = { ...P13_GANTT_ROW_DEFAULTS, ...base };
    const out = completeStepRows(project, [stage(0), stage(1), stage(2)]);
    expect(out.addedStepIds).toEqual(['PDD-A', 'PDD-C']);
    expect(out.row.steps.map((s) => s.step_id)).toEqual(['PDD-A', 'PDD-B', 'PDD-C']);
    expect(completeStepRows(project, null).addedStepIds).toEqual([]);
  });
});
