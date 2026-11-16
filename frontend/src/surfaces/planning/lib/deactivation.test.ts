import { describe, expect, it } from 'vitest';

import type { DeactivationOpenProject } from '../api/types';
import {
  blockedFrozenRows,
  buildDeactivateRequest,
  emptyRows,
  fillEmptyRows,
  keepValidChoices,
  needsSecondSentence,
  noLeaderWarning,
  oneForAllOptions,
} from './deactivation';

function row(id: string, over: Partial<DeactivationOpenProject> = {}): DeactivationOpenProject {
  return {
    project_id: id,
    name: `Project ${id}`,
    hub: 'R&D-Greece',
    status: 'In Development',
    priority: 'P1',
    category: 'A',
    schedulable: true,
    frozen: false,
    progress_tracked: false,
    done_stages: 0,
    in_flight_lab: false,
    candidates: [
      { engineer_id: 'x', name: 'Xena', fte: 1, load_weeks: 3 },
      { engineer_id: 'y', name: 'Yorgos', fte: 0.5, load_weeks: 9 },
    ],
    ...over,
  };
}

describe('P38-T06 deactivation helpers', () => {
  it('the contract warning copy is verbatim', () => {
    expect(noLeaderWarning(2)).toBe(
      'These 2 projects will have no leader. They will not be scheduled (Left out: no leader) until someone sets a leader.',
    );
  });

  it('"one leader for all" fills only empty rows, and only where the engineer is a served candidate', () => {
    const rows = [row('a'), row('b'), row('c', { candidates: [{ engineer_id: 'y', name: 'Yorgos', fte: 0.5, load_weeks: 9 }] })];
    const next = fillEmptyRows(rows, { b: 'y' }, 'x');
    expect(next).toEqual({ a: 'x', b: 'y' });
  });

  it('one-for-all options are the served candidates once, in served order', () => {
    const rows = [row('a', { candidates: [{ engineer_id: 'y', name: 'Yorgos', fte: 0.5, load_weeks: 9 }] }), row('b')];
    expect(oneForAllOptions(rows).map((o) => o.engineer_id)).toEqual(['y', 'x']);
  });

  it('empty and blocked-frozen rows; the second sentence follows progress_tracked / in_flight_lab', () => {
    const rows = [row('a'), row('b', { frozen: true }), row('c', { in_flight_lab: true })];
    expect(emptyRows(rows, { a: 'x' }).map((r) => r.project_id)).toEqual(['b', 'c']);
    expect(blockedFrozenRows(rows, { a: 'x' }).map((r) => r.project_id)).toEqual(['b']);
    expect(needsSecondSentence([row('a')])).toBe(false);
    expect(needsSecondSentence([row('a', { progress_tracked: true })])).toBe(true);
    expect(needsSecondSentence([row('a', { in_flight_lab: true })])).toBe(true);
  });

  it('after a refresh keeps choices only for listed projects whose chosen engineer is still a candidate', () => {
    const rows = [row('a'), row('b', { candidates: [] })];
    expect(keepValidChoices(rows, { a: 'x', b: 'x', gone: 'y' })).toEqual({ a: 'x' });
  });

  it('builds one row per listed project; empty means null', () => {
    const rows = [row('a'), row('b')];
    expect(buildDeactivateRequest(rows, { a: 'y' }, 'left_company', 'tok')).toEqual({
      reason: 'left_company',
      led_projects_token: 'tok',
      reassignments: [
        { project_id: 'a', leader_engineer_id: 'y' },
        { project_id: 'b', leader_engineer_id: null },
      ],
    });
  });
});
