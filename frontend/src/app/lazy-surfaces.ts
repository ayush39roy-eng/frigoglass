import * as React from 'react';

/**
 * Lazy `import()` handles for the built surfaces — one Vite chunk each
 * (frontend-builder SKILL: route-split at the surface boundary is what keeps the
 * 400 KB initial budget). Kept in a dedicated module so `routes.tsx` stays a
 * plain route table.
 *
 * As each surface (P4-T03..T07) is built, add its lazy handle here.
 */

export const DashboardPage = React.lazy(() => import('@/surfaces/dashboard/DashboardPage'));
export const CapacityPage = React.lazy(() => import('@/surfaces/capacity/CapacityPage'));
export const MatrixPage = React.lazy(() => import('@/surfaces/matrix/MatrixPage'));
export const GanttPage = React.lazy(() => import('@/surfaces/gantt/GanttPage'));
export const RegistrationPage = React.lazy(() => import('@/surfaces/registration/RegistrationPage'));
export const PlanningPage = React.lazy(() => import('@/surfaces/planning/PlanningPage'));
export const AuditLogPage = React.lazy(() => import('@/surfaces/audit-log/AuditLogPage'));

/**
 * Not a surface — the design-system gallery (/design-system). Lazy like everything
 * else so it costs the production bundle nothing; reachable by URL only.
 */
export const DesignSystemPage = React.lazy(() => import('@/pages/design-system'));
