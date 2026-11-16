import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { P13_ROW_DEFAULTS } from '@/surfaces/dashboard/test-fixtures';
import { TEST_PLAN_YEAR as Y } from '@/test/session';

import { columnPrefsKey, readColumnPrefs, sanitizeColumnPrefs, writeColumnPrefs } from './column-prefs';
import { dateInputToPlanWeek, isoWeekOf, planWeekToDateInput } from './plan-week-date';
import {
  buildRegisterEditsBody,
  changedProjectIds,
  endBeforeStart,
  parseEffortInput,
  setDraftBulk,
  setDraftField,
} from './register-edit';

function row(id: string, over: Partial<ProjectFilterRow> = {}): ProjectFilterRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'B',
    status: 'In Development',
    priority: 'P2',
    is_vip: false,
    tracking_status: 'idle',
    ...P13_ROW_DEFAULTS,
    ...over,
  };
}

describe('plan week ↔ date (ADR 0035 §11 rule)', () => {
  it('maps the served plan year (2026) ISO weeks to W1–W52 and shows the Monday', () => {
    expect(planWeekToDateInput(1, Y)).toBe('2025-12-29'); // ISO 2026-W01 starts Mon 29 Dec 2025
    expect(planWeekToDateInput(10, Y)).toBe('2026-03-02');
    expect(dateInputToPlanWeek('2026-03-02', Y)).toBe(10);
    expect(dateInputToPlanWeek('2026-03-08', Y)).toBe(10); // Sunday of the same week
    expect(dateInputToPlanWeek('2025-12-29', Y)).toBe(1);
  });

  it('folds ISO week 53 into W52 and continues 2027 as W53+', () => {
    expect(isoWeekOf(new Date(Date.UTC(2026, 11, 31)))).toEqual({ year: 2026, week: 53 });
    expect(dateInputToPlanWeek('2026-12-31', Y)).toBe(52);
    expect(dateInputToPlanWeek('2027-01-04', Y)).toBe(53); // ISO 2027-W01
    expect(planWeekToDateInput(53, Y)).toBe('2027-01-04');
    expect(dateInputToPlanWeek(planWeekToDateInput(78, Y), Y)).toBe(78);
  });

  it('round-trips every plan week 1..78', () => {
    for (let w = 1; w <= 78; w += 1) expect(dateInputToPlanWeek(planWeekToDateInput(w, Y), Y)).toBe(w);
  });

  it('a date with no plan week is undefined; empty clears', () => {
    expect(dateInputToPlanWeek('2025-12-01', Y)).toBeUndefined();
    expect(dateInputToPlanWeek('2027-12-31', Y)).toBeUndefined();
    expect(dateInputToPlanWeek('2026-02-30', Y)).toBeUndefined();
    expect(dateInputToPlanWeek('', Y)).toBeNull();
    expect(planWeekToDateInput(null, Y)).toBe('');
    expect(planWeekToDateInput(79, Y)).toBe('');
  });
});

describe('register edit session', () => {
  it('keeps only changed fields and drops a field set back to its served value', () => {
    const a = row('a', { design_effort_weeks: 4 });
    let d = setDraftField({}, a, 'status', 'On Hold');
    d = setDraftField(d, a, 'design_effort_weeks', null);
    expect(d).toEqual({ a: { status: 'On Hold', design_effort_weeks: null } });
    d = setDraftField(d, a, 'status', 'In Development');
    expect(d).toEqual({ a: { design_effort_weeks: null } });
    d = setDraftField(d, a, 'design_effort_weeks', 4);
    expect(d).toEqual({});
  });

  it('builds one body with only the changed fields of each changed project', () => {
    const a = row('a');
    const b = row('b', { actual_start_week: 10 });
    const c = row('c');
    let d = setDraftField({}, a, 'leader_engineer_id', 'eng-1');
    d = setDraftField(d, b, 'actual_end_week', 20);
    expect(changedProjectIds(d, [a, b, c])).toEqual(['a', 'b']);
    expect(buildRegisterEditsBody(d, [a, b, c])).toEqual({
      edits: [
        { project_id: 'a', leader_engineer_id: 'eng-1' },
        { project_id: 'b', actual_end_week: 20 },
      ],
    });
  });

  it('a refetch that caught up with a draft leaves nothing to send', () => {
    const a = row('a');
    const d = setDraftField({}, a, 'status', 'On Hold');
    expect(buildRegisterEditsBody(d, [row('a', { status: 'On Hold' })])).toEqual({ edits: [] });
  });

  it('bulk staging skips the status of a Draft row', () => {
    const d = setDraftBulk({}, [row('a'), row('b', { status: 'Draft' })], { status: 'On Hold', lab_effort_weeks: 6 });
    expect(d).toEqual({ a: { status: 'On Hold', lab_effort_weeks: 6 }, b: { lab_effort_weeks: 6 } });
  });

  it('flags end before start and parses typed weeks', () => {
    expect(endBeforeStart({ actual_start_week: 10, actual_end_week: 9 })).toBe(true);
    expect(endBeforeStart({ actual_start_week: 10, actual_end_week: 10 })).toBe(false);
    expect(endBeforeStart({ actual_start_week: null, actual_end_week: 9 })).toBe(false);
    expect(parseEffortInput('')).toBeNull();
    expect(parseEffortInput('4')).toBe(4);
    expect(parseEffortInput('1.25')).toBe(1.25);
    expect(parseEffortInput('1.255')).toBeUndefined();
    expect(parseEffortInput('-1')).toBeUndefined();
    expect(parseEffortInput('abc')).toBeUndefined();
  });
});

describe('column prefs storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('stores per user and reads back', () => {
    expect(writeColumnPrefs('u1', { hidden: ['hub'], widths: { project: 300 } })).toBe(true);
    expect(readColumnPrefs('u1')).toEqual({ hidden: ['hub'], widths: { project: 300 } });
    expect(readColumnPrefs('u2')).toEqual({ hidden: [], widths: {} });
    expect(columnPrefsKey('u1')).not.toBe(columnPrefsKey('u2'));
  });

  it('never throws when storage is unavailable or holds junk', () => {
    window.localStorage.setItem(columnPrefsKey('u1'), '{not json');
    expect(readColumnPrefs('u1')).toEqual({ hidden: [], widths: {} });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(readColumnPrefs('u1')).toEqual({ hidden: [], widths: {} });
    expect(writeColumnPrefs('u1', { hidden: [], widths: {} })).toBe(false);
  });

  it('sanitizes a stored value', () => {
    expect(sanitizeColumnPrefs({ hidden: ['a', 3, 'a'], widths: { x: 9999, y: 'wide', z: 10 } })).toEqual({
      hidden: ['a'],
      widths: { x: 640, z: 48 },
    });
    expect(sanitizeColumnPrefs([1, 2])).toEqual({ hidden: [], widths: {} });
  });
});
