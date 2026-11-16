import { describe, expect, it } from 'vitest';

import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { P13_GANTT_ROW_DEFAULTS, P40_GANTT_STEP_PIN_DEFAULTS } from '../test-fixtures';
import {
  draftsToItems,
  pinDraftProblem,
  pinRunState,
  sameAsLive,
  shownPair,
  typeEnd,
  typeStart,
  type StepPinDraft,
} from './step-pin-drafts';

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
    planned_start_week: 40,
    planned_end_week: 43,
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
    current_length_weeks: 4,
    pin_editable: true,
    pin_block_reason: null,
    ...over,
  };
}

function project(over: Partial<GanttProjectRow> = {}): GanttProjectRow {
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
    steps: [],
    ...over,
  };
}

describe('typing rules (R40-2)', () => {
  it('typing a Start sets End = Start + served current length − 1', () => {
    expect(typeStart({ start: '', end: '' }, '44', 4)).toEqual({ start: '44', end: '47' });
    // A one-week step: start = end.
    expect(typeStart({ start: '', end: '' }, '44', 1)).toEqual({ start: '44', end: '44' });
  });

  it('a Start that is not a whole week yet leaves the End alone', () => {
    expect(typeStart({ start: '44', end: '47' }, '', 4)).toEqual({ start: '', end: '47' });
    expect(typeStart({ start: '44', end: '47' }, '4.5', 4)).toEqual({ start: '4.5', end: '47' });
  });

  it('typing an End keeps the Start; with none typed, the bar’s served planned start', () => {
    expect(typeEnd({ start: '44', end: '47' }, '45', 40)).toEqual({ start: '44', end: '45' });
    expect(typeEnd({ start: '', end: '' }, '50', 40)).toEqual({ start: '40', end: '50' });
    expect(typeEnd({ start: '', end: '' }, '50', null)).toEqual({ start: '', end: '50' });
  });
});

describe('pinDraftProblem (red state)', () => {
  it('both empty is a Clear: valid', () => {
    expect(pinDraftProblem({ start: '', end: '' }, 31, 52)).toBeNull();
  });

  it('End < Start is red on the End', () => {
    expect(pinDraftProblem({ start: '45', end: '44' }, 31, 52)).toEqual({
      message: 'The end week is before the start week.',
      start: false,
      end: true,
    });
  });

  it('a one-week pin (start = end) is valid; weeks are inclusive', () => {
    expect(pinDraftProblem({ start: '44', end: '44' }, 31, 52)).toBeNull();
  });

  it('anything outside current week..52 is red, naming the allowed weeks', () => {
    expect(pinDraftProblem({ start: '30', end: '33' }, 31, 52)).toEqual({
      message: 'Pick weeks between W31 and W52.',
      start: true,
      end: false,
    });
    expect(pinDraftProblem({ start: '50', end: '53' }, 31, 52)?.end).toBe(true);
    expect(pinDraftProblem({ start: '31', end: '52' }, 31, 52)).toBeNull();
  });

  it('a partial pair or a non-whole week is red', () => {
    expect(pinDraftProblem({ start: '44', end: '' }, 31, 52)?.end).toBe(true);
    expect(pinDraftProblem({ start: 'x', end: '45' }, 31, 52)?.start).toBe(true);
  });
});

describe('drafts and the batch body', () => {
  it('shows the draft, else the LIVE pin, else nothing', () => {
    const pinned = step({ manual_start_week: 44, manual_end_week: 46 });
    expect(shownPair(pinned, undefined)).toEqual({ start: '44', end: '46' });
    expect(shownPair(step(), undefined)).toEqual({ start: '', end: '' });
    const d: StepPinDraft = { projectId: 'p1', stepId: 'PDD-E', projectName: 'A', stepName: 'B', start: '1', end: '2' };
    expect(shownPair(pinned, d)).toEqual({ start: '1', end: '2' });
    expect(sameAsLive({ start: '44', end: '46' }, pinned)).toBe(true);
    expect(sameAsLive({ start: '', end: '' }, step())).toBe(true);
  });

  it('empty pairs are sent as nulls (Clear); numbers otherwise, in draft order', () => {
    const drafts: StepPinDraft[] = [
      { projectId: 'p2', stepId: 'PDD-F', projectName: 'B', stepName: 'F', start: '40', end: '43' },
      { projectId: 'p1', stepId: 'PDD-E', projectName: 'A', stepName: 'E', start: '', end: '' },
    ];
    expect(draftsToItems(drafts)).toEqual([
      { project_id: 'p2', step_template_id: 'PDD-F', manual_start_week: 40, manual_end_week: 43 },
      { project_id: 'p1', step_template_id: 'PDD-E', manual_start_week: null, manual_end_week: null },
    ]);
  });
});

describe('pinRunState (R40-13)', () => {
  it('applied when the run row sits on the live pin', () => {
    expect(pinRunState(step({ pinned: true, manual_start_week: 40, manual_end_week: 43 }), project())).toBe('applied');
  });

  it('pending while the saved pin differs from the bar, or a cleared pin is still on the bar', () => {
    expect(pinRunState(step({ manual_start_week: 44, manual_end_week: 46 }), project())).toBe('pending');
    expect(pinRunState(step({ pinned: true }), project())).toBe('pending');
  });

  it('lapsed when the served pin_lapsed placed the pinned row after its passed start', () => {
    const s = step({ pinned: true, manual_start_week: 30, manual_end_week: 33, planned_start_week: 31, planned_end_week: 34 });
    expect(pinRunState(s, project({ pin_lapsed: true }))).toBe('lapsed');
    expect(pinRunState(s, project())).toBe('pending');
  });

  it('nothing for an unpinned step, or an inert pin on a skipped step', () => {
    expect(pinRunState(step(), project())).toBeNull();
    expect(pinRunState(step({ skipped: true, manual_start_week: 44, manual_end_week: 46 }), project())).toBeNull();
  });
});
