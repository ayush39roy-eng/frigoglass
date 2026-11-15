import { describe, expect, it } from 'vitest';

import { timelineFixture } from '../test-fixtures';
import {
  canNudge,
  changeEntry,
  draftOverrides,
  gapBadge,
  nudge,
  pruneDrafts,
  resetStep,
  savedCells,
  templateFlagNote,
  type CategoryDrafts,
  type SavedCell,
} from './template-drafts';

const SAVED: Record<string, SavedCell> = {
  'PDD-A': { weeks: 1, gap_weeks: 0 },
  'PDD-E': { weeks: 6, gap_weeks: 0 },
  'PDD-H': { weeks: 104, gap_weeks: -104 },
};

describe('template drafts (P33-T16)', () => {
  it('a ± click drafts the clicked field; returning to the saved value drops the draft', () => {
    let d: CategoryDrafts = {};
    d = nudge(d, SAVED, 'PDD-E', 'weeks', 1);
    expect(d).toEqual({ 'PDD-E': { weeks: 7 } });
    d = nudge(d, SAVED, 'PDD-E', 'gap_weeks', -1);
    d = nudge(d, SAVED, 'PDD-E', 'gap_weeks', -1);
    expect(d).toEqual({ 'PDD-E': { weeks: 7, gap_weeks: -2 } });
    d = nudge(d, SAVED, 'PDD-E', 'weeks', -1);
    expect(d).toEqual({ 'PDD-E': { gap_weeks: -2 } });
    d = nudge(nudge(d, SAVED, 'PDD-E', 'gap_weeks', 1), SAVED, 'PDD-E', 'gap_weeks', 1);
    expect(d).toEqual({});
  });

  it('clamps at the range ends: length 0..104, gap −104..104', () => {
    expect(canNudge({}, SAVED, 'PDD-H', 'weeks', 1)).toBe(false);
    expect(canNudge({}, SAVED, 'PDD-H', 'gap_weeks', -1)).toBe(false);
    expect(nudge({}, SAVED, 'PDD-H', 'weeks', 1)).toEqual({});
    let d: CategoryDrafts = {};
    d = nudge(d, SAVED, 'PDD-A', 'weeks', -1);
    expect(d).toEqual({ 'PDD-A': { weeks: 0 } });
    expect(canNudge(d, SAVED, 'PDD-A', 'weeks', -1)).toBe(false);
    expect(nudge(d, SAVED, 'PDD-A', 'weeks', -1)).toEqual({ 'PDD-A': { weeks: 0 } });
  });

  it('per-row reset, prune after a reload, and the E1 entry in step order', () => {
    const d: CategoryDrafts = { 'PDD-H': { gap_weeks: -2 }, 'PDD-E': { weeks: 7 } };
    expect(resetStep(d, 'PDD-E')).toEqual({ 'PDD-H': { gap_weeks: -2 } });
    expect(pruneDrafts(d, { ...SAVED, 'PDD-E': { weeks: 7, gap_weeks: 0 } })).toEqual({ 'PDD-H': { gap_weeks: -2 } });
    expect(draftOverrides(d)).toEqual([
      { step_id: 'PDD-E', weeks: 7 },
      { step_id: 'PDD-H', gap_weeks: -2 },
    ]);
    expect(changeEntry('PDD', 'A', 3, d)).toEqual({
      workflow_id: 'PDD',
      category: 'A',
      base_version: 3,
      steps: [
        { step_id: 'PDD-E', weeks: 7 },
        { step_id: 'PDD-H', gap_weeks: -2 },
      ],
    });
    expect(changeEntry('PDD', 'A', 3, {})).toBeNull();
  });

  it('reads the saved cells of one category from C1', () => {
    const cells = savedCells(
      [
        { workflow_id: 'PDD', category: 'A', step_id: 'PDD-E', weeks: 6, gap_weeks: -1, effort_weight_weeks: 6 },
        { workflow_id: 'PDD', category: 'B', step_id: 'PDD-E', weeks: 5, gap_weeks: 0, effort_weight_weeks: 5 },
      ],
      'PDD',
      'A',
    );
    expect(cells).toEqual({ 'PDD-E': { weeks: 6, gap_weeks: -1 } });
  });

  it('gap badge: — on the first step, 0w, −Nw overlap, Nw wait', () => {
    expect(gapBadge(0, true).text).toBe('—');
    expect(gapBadge(0, false)).toMatchObject({ text: '0w', tone: 'none' });
    expect(gapBadge(-3, false)).toMatchObject({ text: '−3w', tone: 'overlap' });
    expect(gapBadge(3, false)).toMatchObject({ text: '3w', tone: 'wait' });
  });

  it('flag notes name the anchor from the served predecessors', () => {
    const t = timelineFixture('A+');
    const e = t.steps.find((s) => s.code === 'PDD-E')!;
    expect(templateFlagNote('same_leader_serialised', e, t.steps)).toBe('Overlap — same leader, runs back-to-back');
    expect(templateFlagNote('anchor_clamped', e, t.steps)).toBe('Can’t start before PDD-D starts');
    expect(templateFlagNote('gap_ignored_zero_length', e, t.steps)).toBe('0-week step: gap ignored');
  });
});
