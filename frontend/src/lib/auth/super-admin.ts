import { ApiError } from '@/lib/api/client';
import { API_ERROR_MESSAGES } from '@/lib/api/error-messages';
import { useSessionStore } from '@/stores/session';
import type { ProjectStatus, RoleName } from '@/types/enums';

/**
 * P46 (ADR 0058 D1): the destructive actions only a Super Admin may take —
 * cancel a project, remove / retire a category or step, delete a chamber,
 * deactivate an engineer, deactivate a user or remove a role, revoke access
 * through Admin rights, cancel a schedule run, delete someone else's saved
 * import scenario, reset the import format.
 *
 * The browser only hides or disables those controls (with
 * {@link SUPER_ADMIN_ONLY_HINT}); the server is the authority and answers any
 * other role with 403 `SUPER_ADMIN_ONLY` ({@link SUPER_ADMIN_ONLY_MESSAGE}).
 */
export const SUPER_ADMIN_ONLY_CODE = 'SUPER_ADMIN_ONLY';
export const SUPER_ADMIN_ONLY_HINT = 'Super Admin only';
export const SUPER_ADMIN_ONLY_MESSAGE: string =
  API_ERROR_MESSAGES[SUPER_ADMIN_ONLY_CODE] ?? 'Only a Super Admin can do this.';

export function isSuperAdminRoles(roles: readonly RoleName[] | null | undefined): boolean {
  return roles?.includes('Super Admin') ?? false;
}

/** The signed-in principal holds Super Admin (session store, `GET /me`). */
export function useIsSuperAdmin(): boolean {
  return useSessionStore((s) => isSuperAdminRoles(s.me?.roles));
}

export function isSuperAdminOnlyError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && err.code === SUPER_ADMIN_ONLY_CODE;
}

/** The project status only a Super Admin may set (ADR 0058 D1.1). */
export const SUPER_ADMIN_ONLY_STATUS: ProjectStatus = 'Cancelled';

/**
 * Whether the status option `option` is locked for this user. Leaving
 * Cancelled is an ordinary edit, so a project that is already Cancelled keeps
 * the option selectable as itself.
 */
export function isStatusOptionLocked(option: ProjectStatus, isSuperAdmin: boolean, current?: ProjectStatus | null): boolean {
  return option === SUPER_ADMIN_ONLY_STATUS && !isSuperAdmin && current !== SUPER_ADMIN_ONLY_STATUS;
}

/** The visible label of a status option: a locked one names the rule. */
export function statusOptionLabel(option: ProjectStatus, locked: boolean): string {
  return locked ? `${option} (${SUPER_ADMIN_ONLY_HINT})` : option;
}
