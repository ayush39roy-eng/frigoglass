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

