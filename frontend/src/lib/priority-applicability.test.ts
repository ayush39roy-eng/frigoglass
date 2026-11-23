import { describe, expect, it } from 'vitest';

import {
  effectivePriority,
  isPriorityNotApplicable,
  NOT_APPLICABLE_FILTER_VALUE,
  NOT_APPLICABLE_LABEL,
  PRIORITY_FILTER_VALUES,
  PRIORITY_NOT_APPLICABLE_STATUSES,
  priorityDisplayText,
  priorityFilterKey,
  rowEffectivePriority,
  rowPriorityNotApplicable,
} from './priority-applicability';

describe('P57 (ADR 0067) priority applicability', () => {
  it('Commercialized and Cancelled are the only not-applicable statuses', () => {
    expect([...PRIORITY_NOT_APPLICABLE_STATUSES]).toEqual(['Commercialized', 'Cancelled']);
    expect(NOT_APPLICABLE_LABEL).toBe('Not applicable');
    for (const s of ['Commercialized', 'Cancelled']) expect(isPriorityNotApplicable(s)).toBe(true);
    for (const s of ['In Queue', 'In Development', 'Under Industrialization', 'On Hold', 'Draft', 'In Buyoff', null, undefined]) {
      expect(isPriorityNotApplicable(s)).toBe(false);
    }
  });

  it('effective priority is null for Commercialized / Cancelled, else the served priority', () => {
    expect(effectivePriority('Commercialized', 'P4')).toBeNull();
    expect(effectivePriority('Cancelled', 'P1')).toBeNull();
    expect(effectivePriority('Commercialized', 'Q')).toBeNull();
    expect(effectivePriority('In Queue', 'P4')).toBe('P4');
    expect(effectivePriority('On Hold', 'P2')).toBe('P2');
    expect(effectivePriority('In Queue', null)).toBeNull();
    expect(effectivePriority('In Queue', undefined)).toBeNull();
  });

  it('a served priority_applicable wins over the status', () => {
    expect(effectivePriority('In Queue', 'P3', false)).toBeNull();
    expect(effectivePriority('Commercialized', 'P3', true)).toBe('P3');
    expect(rowEffectivePriority({ status: undefined, priority: 'P4', priority_applicable: false })).toBeNull();
    expect(rowEffectivePriority({ status: 'Cancelled', priority: 'P4' })).toBeNull();
    expect(rowPriorityNotApplicable({ status: 'Cancelled', priority: 'P4' })).toBe(true);
    expect(rowPriorityNotApplicable({ status: 'In Queue', priority: 'P4' })).toBe(false);
  });

  it('filter keys and text never put a Commercialized P4 under P4', () => {
    expect(priorityFilterKey('Commercialized', 'P4')).toBe(NOT_APPLICABLE_FILTER_VALUE);
    expect(priorityFilterKey('In Queue', 'P4')).toBe('P4');
    expect(priorityFilterKey('In Queue', null)).toBeNull();
    expect(priorityDisplayText('Cancelled', 'P4')).toBe('Not applicable');
    expect(priorityDisplayText('In Queue', 'P4')).toBe('P4');
    expect(priorityDisplayText('In Queue', null, '—')).toBe('—');
  });

  it('the server-side priority filters offer not_applicable (served `priority=not_applicable`)', () => {
    expect(NOT_APPLICABLE_FILTER_VALUE).toBe('not_applicable');
    expect([...PRIORITY_FILTER_VALUES]).toEqual(['P1', 'P2', 'P3', 'P4', 'Q', 'not_applicable']);
  });
});
