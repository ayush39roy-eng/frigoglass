import * as React from 'react';
import type { RouteObject } from 'react-router-dom';

import { AppShell } from '@/components/layout/app-shell';
import { SurfaceFallback } from '@/components/layout/surface-fallback';
import { RequireRead } from '@/components/session/require-read';
import { NotFound, RouteErrorBoundary } from '@/pages/not-found';
import { PlaceholderPage } from '@/pages/placeholder-page';
import { useSessionStore } from '@/stores/session';

import {
  AdminUsersPage,
  AuditLogPage,
  CapacityPage,
  DashboardPage,
  DesignSystemPage,
  ProfilePage,
  GanttPage,
  LoginPage,
  MatrixPage,
  PlanningPage,
  ProjectWorkspacePage,
  RegistrationPage,
  WorkflowSettingsPage,
} from './lazy-surfaces';
import { SURFACES } from './nav';

/**
 * Route table. One route per surface. Built surfaces (P4-T02..T07) are lazy
 * `import()`ed as their own Vite chunk (frontend-builder SKILL — this is what
 * keeps the 400 KB initial budget); unbuilt ones still render <PlaceholderPage>.
 * The path and nav entry never change when a surface is built.
 */

function lazyElement(node: React.ReactNode): React.ReactNode {
  return <React.Suspense fallback={<SurfaceFallback />}>{node}</React.Suspense>;
}

/**
 * `/admin/users`'s route guard (ADR 0012, P10-F03): `user_role_admin` read
 * OR `me.is_delegate_manager` — a manager delegate (Hub Planner, Portfolio
 * Manager, or any role holding no `user_role_admin` permission at all) with
 * >=1 direct report and >=1 manageable project still needs to reach the
 * Project Access tab. `<RequireRead>`'s `alsoAllow` prop is the shared OR
 * escape hatch (not a route-specific reimplementation of the guard) — this
 * wrapper only supplies the session-store boolean, evaluated inside a
 * component (not at module scope, where the store has not rendered yet).
 */
function AdminUsersRoute({
  surface,
  title,
  children,
}: {
  surface: Parameters<typeof RequireRead>[0]['surface'];
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const isDelegateManager = useSessionStore((s) => s.me?.is_delegate_manager ?? false);
  return (
    <RequireRead surface={surface} title={title} alsoAllow={isDelegateManager}>
      {children}
    </RequireRead>
  );
}

const SURFACE_ELEMENTS: Partial<Record<string, React.ReactNode>> = {
  '/': lazyElement(<DashboardPage />),
  '/capacity': lazyElement(<CapacityPage />),
  '/matrix': lazyElement(<MatrixPage />),
  '/timeline': lazyElement(<GanttPage />),
  '/register': lazyElement(<RegistrationPage />),
  '/planning': lazyElement(<PlanningPage />),
  '/audit-log': lazyElement(<AuditLogPage />),
  '/settings/workflow': lazyElement(<WorkflowSettingsPage />),
  '/admin/users': lazyElement(<AdminUsersPage />),
};

/**
 * Every surface route is wrapped in `<RequireRead>` (ADR 0010): a direct URL
 * hit on a surface the session cannot read renders the 403 page, never a
 * blank — and the lazy chunk is not fetched.
 *
 * `/admin/users` uses `<AdminUsersRoute>` instead of the bare `<RequireRead>`
 * (ADR 0012, P10-F02/F03 — restored after P10-T03 removed the guard
 * outright, which broke `e2e/p9-rbac.spec.ts`'s "unreadable routes show 403"
 * check): `user_role_admin` read OR `me.is_delegate_manager`. A manager
 * delegate (Hub Planner, Portfolio Manager, or any role with no
 * `user_role_admin` permission at all) who has >=1 direct report and >=1
 * manageable project (`GET /users/me/manageable-projects` non-empty) can
 * still reach the page's Project Access tab — the server's `GET/POST/DELETE
 * /projects/{id}/access` already scopes correctly for them — while a caller
 * with neither signal still 403s, same as every other route. This is
 * convenience routing, not a security decision (ADR 0010 §2) — every
 * endpoint behind the page still enforces its own check, and the page's own
 * per-tab handling (Users tab's `AccessNotice`; Project Access tab's own 403
 * empty-state) still runs for whichever tab the caller cannot use. The
 * sidebar link itself is unchanged (`app-sidebar.tsx` still hides it without
 * `user_role_admin.read`) — a delegate-only manager must open this page by
 * URL, exactly as before.
 */
const surfaceRoutes: RouteObject[] = SURFACES.map((surface) => {
  const inner = SURFACE_ELEMENTS[surface.path] ?? <PlaceholderPage surface={surface} />;
  const path = surface.path.replace(/^\//, '');
  const Guard = surface.path === '/admin/users' ? AdminUsersRoute : RequireRead;
  const element = (
    <Guard surface={surface.surface} title={surface.title}>
      {inner}
    </Guard>
  );
  return surface.path === '/' ? { index: true, element } : { path, element };
});

export const routeObjects: RouteObject[] = [
  // ADR 0013: rendered by the router BEFORE `<AppShell>`'s `<SessionGate>`
  // ever attempts `GET /me` — a sibling route, not a child of the shell, so
  // landing with no session never renders (even briefly) anything that
  // assumed an identity.
  { path: '/login', element: lazyElement(<LoginPage />) },
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorBoundary />,
    children: [
      ...surfaceRoutes,
      // Project Workspace (Surface #7) — reached by click-through from the
      // Dashboard, Matrix and Gantt rows, not from the sidebar. Gated on the
      // `project_workspace` surface (P9 contract §7).
      {
        path: 'projects/:projectId',
        element: (
          <RequireRead surface="project_workspace" title="the Project Workspace">
            {lazyElement(<ProjectWorkspacePage />)}
          </RequireRead>
        ),
      },
      // Developer route, deliberately absent from SURFACES (and therefore from the
      // sidebar): every primitive in both density zones. See pages/design-system.tsx.
      { path: 'design-system', element: lazyElement(<DesignSystemPage />) },
      // Profile & settings (2026-10-01): every signed-in user, no surface permission needed.
      { path: 'profile', element: lazyElement(<ProfilePage />) },
      { path: '*', element: <NotFound /> },
    ],
  },
];
