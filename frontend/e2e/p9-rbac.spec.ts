import { test, expect } from './fixtures';
import { actAs, apiGet, type DevRole } from './dev-session';

/**
 * P9-T05 (qa-inspector) — RBAC as each of the seven roles via the dev-user
 * header (ADR 0010): `/me` permissions equal docs/PROJECT_AND_STACK.md §5,
 * the sidebar lists exactly the readable surfaces, unreadable routes render
 * the 403 page, and write controls are replaced by the read-only notice where
 * the role has read but not write.
 */

type Perm = '-' | 'R' | 'RW';
const SURFACE_KEYS = [
  'dashboard',
  'capacity',
  'matrix',
  'gantt',
  'project_workspace',
  'project_registration',
  'capacity_planning',
  'workflow_settings',
  'audit_log',
  'user_role_admin',
] as const;
type SurfaceKey = (typeof SURFACE_KEYS)[number];

// Transcribed from docs/PROJECT_AND_STACK.md §5 (2026-09-27), column order above.
const MATRIX: Record<DevRole, Perm[]> = {
  portfolioManager: ['R', 'R', 'RW', 'R', 'RW', 'RW', 'R', '-', '-', '-'],
  hubPlanner: ['R', 'RW', 'R', 'RW', 'RW', 'RW', 'RW', '-', '-', '-'],
  engineer: ['-', '-', '-', 'R', 'R', '-', '-', '-', '-', '-'],
  executiveViewer: ['R', 'R', 'R', 'R', 'R', '-', '-', '-', '-', '-'],
  auditor: ['-', '-', '-', '-', '-', '-', '-', '-', 'R', '-'],
  admin: ['RW', 'RW', 'RW', 'RW', 'RW', 'RW', 'RW', 'R', 'R', 'RW'],
  superAdmin: ['RW', 'RW', 'RW', 'RW', 'RW', 'RW', 'RW', 'RW', 'R', 'RW'],
};

const perm = (role: DevRole, s: SurfaceKey): Perm => MATRIX[role][SURFACE_KEYS.indexOf(s)];

// Sidebar entries (frontend/src/app/nav.ts). Project Workspace has no nav item.
const NAV: { surface: SurfaceKey; label: string; path: string }[] = [
  { surface: 'dashboard', label: 'Dashboard', path: '/' },
  { surface: 'capacity', label: 'Capacity', path: '/capacity' },
  { surface: 'matrix', label: 'Prioritization', path: '/matrix' },
  { surface: 'gantt', label: 'Timeline', path: '/timeline' },
  { surface: 'project_registration', label: 'Register', path: '/register' },
  { surface: 'capacity_planning', label: 'Planning', path: '/planning' },
  { surface: 'workflow_settings', label: 'Workflow', path: '/settings/workflow' },
  { surface: 'user_role_admin', label: 'Users & roles', path: '/admin/users' },
  { surface: 'audit_log', label: 'Audit Log', path: '/audit-log' },
];

// Surfaces whose page renders `<ReadOnlyNotice>` when read && !write.
const NOTICE_SURFACES: SurfaceKey[] = [
  'matrix',
  'gantt',
  'project_registration',
  'capacity_planning',
  'workflow_settings',
  'user_role_admin',
];

interface Me {
  roles: string[];
  permissions: Record<string, { read: boolean; write: boolean }>;
  is_delegate_manager: boolean;
}

/**
 * P10-F03: `bob.hub` (`hubPlanner`) is a genuine ADR 0012 delegate manager in
 * this dev seed — Hub Planner scoped to a real hub gets Admin-level
 * `effective_project_access` on every project in that hub (resolver rule 3),
 * and `carol.eng`'s `manager_id` is wired to bob (P10-T01, on purpose, to
 * exercise delegation in dev/tests). `GET /me` therefore reports
 * `is_delegate_manager: true` for bob even though `user_role_admin` itself
 * is unreadable — so `/admin/users` legitimately does NOT 403 for this one
 * role, per the `<AdminUsersRoute>` OR guard (`src/app/routes.tsx`). Every
 * other route stays gated purely on the surface permission table.
 */
const DELEGATE_MANAGER_EXEMPT_ROUTES: Partial<Record<DevRole, string[]>> = {
  hubPlanner: ['/admin/users'],
};

let workspaceProjectId = '';

test.beforeAll(async ({ request }) => {
  const projects = await apiGet<{ id: string }[]>(request, 'superAdmin', '/projects?limit=1');
  workspaceProjectId = projects[0]?.id ?? '';
});

for (const role of Object.keys(MATRIX) as DevRole[]) {
  test.describe(`RBAC as ${role}`, () => {
    test('/me permissions equal PROJECT_AND_STACK §5', async ({ request }) => {
      const me = await apiGet<Me>(request, role, '/me');
      const got = Object.fromEntries(
        SURFACE_KEYS.map((s) => {
          const p = me.permissions[s];
          return [s, p.write ? 'RW' : p.read ? 'R' : '-'];
        }),
      );
      const want = Object.fromEntries(SURFACE_KEYS.map((s) => [s, perm(role, s)]));
      expect(got).toEqual(want);
      // P10-F03: `is_delegate_manager` is true only for the one seeded
      // account with both a real direct report and Admin-level project
      // access (`bob.hub`, see `DELEGATE_MANAGER_EXEMPT_ROUTES` above).
      expect(me.is_delegate_manager).toBe(role in DELEGATE_MANAGER_EXEMPT_ROUTES);
    });

    test('sidebar lists exactly the readable surfaces; unreadable routes 403', async ({
      page,
    }) => {
      await actAs(page, role);
      await page.goto(role === 'auditor' || role === 'engineer' ? NAV.find((n) => perm(role, n.surface) !== '-')!.path : '/');
      const nav = page.getByRole('navigation', { name: 'Surfaces' });
      await expect(nav).toBeVisible();
      const expected = NAV.filter((n) => perm(role, n.surface) !== '-').map((n) => n.label);
      await expect(nav.getByRole('link')).toHaveText(expected);

      const exempt = DELEGATE_MANAGER_EXEMPT_ROUTES[role] ?? [];
      for (const n of NAV.filter((x) => perm(role, x.surface) === '-')) {
        if (exempt.includes(n.path)) continue;
        await page.goto(n.path);
        await expect(page.getByTestId('forbidden-page'), `${role} -> ${n.path}`).toBeVisible();
      }

      // P10-F02/F03: an exempt route must actually be reachable (not merely
      // "not 403") and, for the one delegation surface this dev seed
      // exercises, must show a manager-delegate's manageable projects in the
      // Project Access picker — not just an empty/broken page.
      for (const path of exempt) {
        await page.goto(path);
        await expect(page.getByTestId('forbidden-page')).toHaveCount(0);
        if (path === '/admin/users') {
          await page.getByRole('tab', { name: 'Project Access' }).click();
          // `getByLabel` alone is ambiguous: the app shell's own (unbuilt,
          // disabled) global search box shares this label text. The
          // Project Access tab's picker is the `combobox` role one
          // (`search-picker.tsx`).
          const search = page.getByRole('combobox', { name: 'Search projects' });
          await expect(search).toBeVisible();
          await expect(search).toBeEnabled();
          await search.fill('a');
          await expect(page.getByRole('option').first()).toBeVisible();
        }
      }
    });

    test('write controls follow write permission (read-only notice)', async ({ page }) => {
      await actAs(page, role);
      for (const s of NOTICE_SURFACES.filter((x) => perm(role, x) !== '-')) {
        const n = NAV.find((x) => x.surface === s)!;
        await page.goto(n.path);
        await expect(page.getByRole('navigation', { name: 'Surfaces' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        const notice = page.getByTestId('read-only-notice');
        if (perm(role, s) === 'R') await expect(notice, `${role} ${s}`).toBeVisible();
        else await expect(notice, `${role} ${s}`).toHaveCount(0);
      }
      if (perm(role, 'project_workspace') !== '-' && role !== 'engineer') {
        await page.goto(`/projects/${workspaceProjectId}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const recalc = page.getByRole('button', { name: 'Recalculate schedule' });
        if (perm(role, 'project_workspace') === 'R') {
          await expect(page.getByTestId('read-only-notice')).toBeVisible();
          await expect(recalc).toHaveCount(0);
        } else {
          await expect(page.getByTestId('read-only-notice')).toHaveCount(0);
          await expect(recalc.first()).toBeVisible();
        }
      }
    });
  });
}
