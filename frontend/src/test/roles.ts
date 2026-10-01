import type { SurfacePermission } from '@/lib/api/session';
import type { RoleName, SurfaceKey } from '@/types/enums';

import { permissionsFrom } from './session';

/**
 * The seven roles' resolved permission tables, transcribed from
 * `docs/PROJECT_AND_STACK.md` §5 / `backend/core/rbac.py::PERMISSIONS`
 * (action level only — row-level hub scoping is server-side). Used by the
 * gating tests to prove nav filtering and write-control gating PER ROLE.
 */
export const ROLE_MATRIX: Record<RoleName, Record<SurfaceKey, SurfacePermission>> = {
  'Portfolio Manager': permissionsFrom({
    dashboard: 'r',
    capacity: 'r',
    matrix: 'rw',
    gantt: 'r',
    project_workspace: 'rw',
    project_registration: 'rw',
    capacity_planning: 'r',
  }),
  'Hub Planner': permissionsFrom({
    dashboard: 'r',
    capacity: 'rw',
    matrix: 'r',
    gantt: 'rw',
    project_workspace: 'rw',
    project_registration: 'rw',
    capacity_planning: 'rw',
  }),
  Engineer: permissionsFrom({ gantt: 'r', project_workspace: 'r' }),
  'Executive Viewer': permissionsFrom({
    dashboard: 'r',
    capacity: 'r',
    matrix: 'r',
    gantt: 'r',
    project_workspace: 'r',
  }),
  Auditor: permissionsFrom({ audit_log: 'r' }),
  Admin: permissionsFrom({
    dashboard: 'rw',
    capacity: 'rw',
    matrix: 'rw',
    gantt: 'rw',
    project_workspace: 'rw',
    project_registration: 'rw',
    capacity_planning: 'rw',
    workflow_settings: 'r',
    audit_log: 'r',
    user_role_admin: 'rw',
  }),
  'Super Admin': permissionsFrom({
    dashboard: 'rw',
    capacity: 'rw',
    matrix: 'rw',
    gantt: 'rw',
    project_workspace: 'rw',
    project_registration: 'rw',
    capacity_planning: 'rw',
    workflow_settings: 'rw',
    audit_log: 'r',
    user_role_admin: 'rw',
  }),
};
