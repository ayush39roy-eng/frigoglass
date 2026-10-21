import { describe, expect, it } from 'vitest';

import {
  ALL_PROJECT_STATUSES,
  PROJECT_STATUSES,
  SCHEDULABLE_STATUSES,
  UI_HIDDEN_PROJECT_STATUSES,
  UI_PROJECT_STATUSES,
  UI_SCHEDULABLE_STATUSES,
} from './enums';

describe('project status lists (P23-T01)', () => {
  it('the UI list excludes In Buyoff and Draft and keeps every other wire status', () => {
    expect(UI_PROJECT_STATUSES).not.toContain('In Buyoff');
    expect(UI_PROJECT_STATUSES).not.toContain('Draft');
    expect([...UI_PROJECT_STATUSES, ...UI_HIDDEN_PROJECT_STATUSES].sort()).toEqual([...ALL_PROJECT_STATUSES].sort());
  });

  it('PROJECT_STATUSES (used by the Matrix chips) is the UI list', () => {
    expect(PROJECT_STATUSES).toBe(UI_PROJECT_STATUSES);
  });

  it('the wire enum and the scheduler order are unchanged', () => {
    expect(ALL_PROJECT_STATUSES).toContain('In Buyoff');
    expect(ALL_PROJECT_STATUSES).toContain('Draft');
    expect(SCHEDULABLE_STATUSES).toEqual(['In Buyoff', 'Under Industrialization', 'In Development', 'In Queue']);
    expect(UI_SCHEDULABLE_STATUSES).toEqual(['Under Industrialization', 'In Development', 'In Queue']);
  });
});
