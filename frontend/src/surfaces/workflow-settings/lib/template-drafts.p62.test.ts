import { describe, expect, it } from 'vitest';

import { setWeeks, matrixTotals } from './effort-matrix';
import {
  canHold,
  changeEntry,
  currentHold,
  draftSummaryLines,
  holdText,
  nudge,
  nudgeHold,
  pruneDrafts,
  type SavedCell,
} from './template-drafts';

/** P62 (ADR 0071, API_CONTRACT_P62 §4.1): room-weeks drafts. */
const SAVED: Record<string, SavedCell> = {
  'PDD-H': { weeks: 6, gap_weeks: 0, lab_hold_weeks: null },
  'PDD-J': { weeks: 3, gap_weeks: 0, lab_hold_weeks: 1 },
};

describe('room-weeks drafts (P62)', () => {
  it('reads the saved value; null = Full', () => {
    expect(currentHold({}, SAVED, 'PDD-H')).toBeNull();
    expect(currentHold({}, SAVED, 'PDD-J')).toBe(1);
    expect(currentHold({ 'PDD-J': { lab_hold_weeks: null } }, SAVED, 'PDD-J')).toBeNull();
  });

  it('from Full, − asks for one week fewer than the length; + and Full have nowhere to go', () => {
    expect(canHold({}, SAVED, 'PDD-H', 1, 6)).toBe(false);
    expect(canHold({}, SAVED, 'PDD-H', 'full', 6)).toBe(false);
    const d = nudgeHold({}, SAVED, 'PDD-H', -1, 6);
    expect(d).toEqual({ 'PDD-H': { lab_hold_weeks: 5 } });
    expect(holdText(currentHold(d, SAVED, 'PDD-H'))).toBe('5w');
  });

  it('ranges 0..length; a value back at the saved one drops out of the drafts', () => {
    let d = nudgeHold({}, SAVED, 'PDD-J', -1, 3);
    expect(d).toEqual({ 'PDD-J': { lab_hold_weeks: 0 } });
    expect(canHold(d, SAVED, 'PDD-J', -1, 3)).toBe(false);
    d = nudgeHold(d, SAVED, 'PDD-J', 1, 3);
    expect(d).toEqual({});
    d = nudgeHold(nudgeHold(d, SAVED, 'PDD-J', 1, 3), SAVED, 'PDD-J', 1, 3);
    expect(currentHold(d, SAVED, 'PDD-J')).toBe(3);
    expect(canHold(d, SAVED, 'PDD-J', 1, 3)).toBe(false);
    d = nudgeHold(d, SAVED, 'PDD-J', 'full', 3);
    expect(d).toEqual({ 'PDD-J': { lab_hold_weeks: null } });
  });

  it('sends "full" for Full and an integer otherwise', () => {
    const entry = changeEntry('PDD', 'B', 2, { 'PDD-J': { lab_hold_weeks: null }, 'PDD-H': { lab_hold_weeks: 2 } });
    expect(entry?.steps).toEqual([
      { step_id: 'PDD-H', lab_hold_weeks: 2 },
      { step_id: 'PDD-J', lab_hold_weeks: 'full' },
    ]);
  });

  it('a shorter length cuts a DRAFTED room value to it; a saved value is left to the server', () => {
    const drafted = { 'PDD-H': { lab_hold_weeks: 5 } };
    expect(nudge(drafted, SAVED, 'PDD-H', 'weeks', -1)).toEqual({ 'PDD-H': { weeks: 5, lab_hold_weeks: 5 } });
    expect(nudge(nudge(drafted, SAVED, 'PDD-H', 'weeks', -1), SAVED, 'PDD-H', 'weeks', -1)).toEqual({
      'PDD-H': { weeks: 4, lab_hold_weeks: 4 },
    });
    expect(setWeeks(drafted, SAVED, 'PDD-H', 2)).toEqual({ 'PDD-H': { weeks: 2, lab_hold_weeks: 2 } });
    // Saved hold 1 on J, length cut to 0: no room draft is made (the server clamps, `room_weeks_clamped`).
    expect(setWeeks({}, SAVED, 'PDD-J', 0)).toEqual({ 'PDD-J': { weeks: 0 } });
  });

  it('prunes a room draft equal to the reloaded template', () => {
    const d = { 'PDD-J': { lab_hold_weeks: 2 } };
    expect(pruneDrafts(d, { ...SAVED, 'PDD-J': { weeks: 3, gap_weeks: 0, lab_hold_weeks: 2 } })).toEqual({});
  });

  it('summarises room changes for the apply dialog', () => {
    expect(draftSummaryLines('B', { 'PDD-J': { lab_hold_weeks: null } }, SAVED)).toEqual(['B · PDD-J room weeks 1w → Full']);
  });

  it('the matrix L total counts room weeks; the lab length is kept apart', () => {
    const kinds: Record<string, 'lab' | 'design'> = { F: 'lab', J: 'lab', E: 'design' };
    const weeks: Record<string, number> = { F: 6, J: 3, E: 4 };
    const holds: Record<string, number | null> = { F: null, J: 1, E: null };
    expect(
      matrixTotals(['F', 'J', 'E'], (id) => weeks[id]!, (id) => kinds[id]!, (id) => holds[id] ?? null),
    ).toEqual({ total: 13, design: 4, lab: 7, labLength: 9 });
  });
});
