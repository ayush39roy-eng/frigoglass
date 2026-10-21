/**
 * Deep link into a project's registration (P13, ADR 0025 §5; P22-T01). The
 * Dashboard register's "Edit" action links here. Since P22-T01 the
 * registration form is a drawer on the Projects page, which opens it for
 * `?edit=<projectId>` (see `surfaces/registration/hooks/use-edit-deep-link.ts`).
 * The old `/register?edit=` and `/register/:id` URLs redirect to this one.
 * Kept in `lib/` so the Dashboard does not import the Projects surface.
 */
export const REGISTRATION_EDIT_PARAM = 'edit';

export function registrationEditHref(projectId: string): string {
  return `/projects?${REGISTRATION_EDIT_PARAM}=${encodeURIComponent(projectId)}`;
}
