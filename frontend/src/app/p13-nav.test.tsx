import { describe, expect, it } from 'vitest';

import { ROLE_MATRIX } from '@/test/roles';
import { makeMe } from '@/test/session';
import type { RoleName } from '@/types/enums';

import { SURFACES } from './nav';
import { visibleNavGroups } from './nav-visibility';

function dataPathsFor(role: RoleName): string[] {
  const groups = visibleNavGroups(makeMe({ roles: [role], permissions: ROLE_MATRIX[role] }));
  return (groups.find(([g]) => g === 'Data')?.[1] ?? []).map((i) => i.path);
}

describe('P13-T15 nav entries (API_CONTRACT_P13 §7)', () => {
  it('adds Versions & History and Downloads to the Data group, after the Audit Log', () => {
    const byPath = Object.fromEntries(SURFACES.map((s) => [s.path, s]));
    expect(byPath['/history']).toMatchObject({ label: 'Versions & History', group: 'Data', surface: 'matrix' });
    expect(byPath['/downloads']).toMatchObject({ label: 'Downloads', group: 'Data', surface: null });
    const paths = SURFACES.map((s) => s.path);
    expect(paths.indexOf('/history')).toBeGreaterThan(paths.indexOf('/audit-log'));
    expect(paths.indexOf('/downloads')).toBe(paths.indexOf('/history') + 1);
  });

  it('gates History on matrix read; shows Downloads to every signed-in role', () => {
    for (const role of ['Portfolio Manager', 'Hub Planner', 'Executive Viewer', 'Admin', 'Super Admin'] as const) {
      expect(dataPathsFor(role)).toEqual(expect.arrayContaining(['/history', '/downloads']));
    }
    for (const role of ['Engineer', 'Auditor'] as const) {
      expect(dataPathsFor(role)).not.toContain('/history');
      expect(dataPathsFor(role)).toContain('/downloads');
    }
  });

  it('shows nothing without a session', () => {
    expect(visibleNavGroups(null)).toEqual([]);
  });
});
