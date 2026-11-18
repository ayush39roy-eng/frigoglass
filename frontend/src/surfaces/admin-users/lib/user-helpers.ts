import type { MeResponse } from '@/lib/api/session';
import { isSuperAdminRoles } from '@/lib/auth/super-admin';

import type { UserRead } from '../api/types';

/** Admin may not touch an Admin / Super Admin account (ADR 0010 §1). The
 *  server enforces this (403); the UI only disables the control. */
export function callerCanManage(callerIsSuperAdmin: boolean, user: UserRead): boolean {
  if (callerIsSuperAdmin) return true;
  return !user.roles.some((r) => r === 'Admin' || r === 'Super Admin');
}

/** Display label for a user's hub scope — an id→name join, never a rule. */
export function hubScopeLabel(user: UserRead, hubNameById: ReadonlyMap<string, string>): string {
  if (user.hub_scope_all) return 'All hubs';
  if (user.hub_ids.length === 0) return 'No hubs';
  return user.hub_ids.map((id) => hubNameById.get(id) ?? id).join(', ');
}


/**
 * P46 (ADR 0058 D1.4): revoking a project access grant through Admin rights is
 * Super Admin only; the ADR 0012 manager delegation is unchanged. A Super
 * Admin may revoke any grant. A caller without the Admin role reaches the tab
 * only as a manager delegate, and the server lists only their reports' grants.
 * P46 security M-1: a caller holding the global Admin role (and not Super
 * Admin) never revokes, even as the grantee's direct manager. The server stays
 * the authority (403 `SUPER_ADMIN_ONLY`).
 */
export function canRevokeGrant(caller: Pick<MeResponse, 'roles'> | null): boolean {
  if (!caller) return false;
  if (isSuperAdminRoles(caller.roles)) return true;
  return !caller.roles.includes('Admin');
}
