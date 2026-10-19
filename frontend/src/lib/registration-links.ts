/**
 * Deep link into Project Registration's edit form (P13, ADR 0025 §5). The
 * Dashboard register's "Edit" action links here; `RegistrationPage` opens the
 * edit dialog for `?edit=<projectId>` (see `use-edit-deep-link.ts`). Kept in
 * `lib/` so the Dashboard does not import the Registration surface.
 */
export const REGISTRATION_EDIT_PARAM = 'edit';

export function registrationEditHref(projectId: string): string {
  return `/register?${REGISTRATION_EDIT_PARAM}=${encodeURIComponent(projectId)}`;
}
