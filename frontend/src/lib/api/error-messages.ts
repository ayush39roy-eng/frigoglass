import { ApiError } from './client';

/**
 * Readable text for the machine-readable `code` on the P9 error envelope
 * (`{"detail", "code"?}` — backend `api/errors.py`). Surfaces branch on the
 * code, never on `detail` wording. Unknown codes fall back to the server's
 * `detail` (flattened when it is a FastAPI field-error list), then to the
 * caller's fallback.
 */
/** 429 copy without a usable `Retry-After` (also used for a 429 with no known code). */
export const RATE_LIMITED_MESSAGE = "You're commenting too fast. Try again in a minute.";

/** 429 copy (P9-R02): "Try again in N s", N from the `Retry-After` header. */
export function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
  return retryAfterSeconds === undefined
    ? RATE_LIMITED_MESSAGE
    : `You're commenting too fast. Try again in ${String(Math.max(1, retryAfterSeconds))} s.`;
}

export const API_ERROR_MESSAGES: Record<string, string> = {
  // Session / users (ADR 0010)
  LAST_SUPER_ADMIN: 'This change would leave no active Super Admin. Promote another user to Super Admin first.',
  ADMIN_ACCOUNT_REQUIRES_SUPER_ADMIN: 'Only a Super Admin can change an Admin or Super Admin account or grant those roles.',
  // Manager delegation (ADR 0012, P10-T02 `PATCH /users/{id}`'s `manager_id`)
  MANAGER_SELF_CYCLE: 'A user cannot be their own manager.',
  UNKNOWN_MANAGER: "That manager account could not be found. Refresh the page and try again.",
  MANAGER_CYCLE: 'This manager assignment would create a reporting-line cycle — the chosen manager already reports up to this user.',
  // P10-F01 remediation: an Engineer-only account may not be given
  // unrestricted "all hubs" scope (it silently disabled that role's
  // own-assignment row-scoping) — reachable from this form whenever the
  // Roles selection is Engineer-only and "All hubs" is checked.
  ENGINEER_HUB_SCOPE_ALL_NOT_ALLOWED: 'An Engineer-only account cannot have "All hubs" scope. Either add another role or limit this user to specific hubs.',
  // Project access grants (ADR 0012, P10-T02/T03)
  ACTIVE_GRANT_EXISTS: 'This user already has an active grant on this project. Revoke it first, then grant the new role.',
  // Workflow settings (ADRs 0007 / 0009)
  CYCLE: 'These predecessors form a cycle — a step would have to finish before itself.',
  SELF_REFERENCE: 'A step cannot depend on itself.',
  BAD_PREDECESSOR: 'A predecessor is not a step of this workflow.',
  EMPTY_PREDECESSORS: 'Every step except the first must start after at least one other step.',
  BAD_STEP_SET: 'The save must list exactly the 14 steps of this workflow. Reload and try again.',
  KIND_IN_USE: 'This step is still listed as an allowed stage on a chamber. Remove it from those chambers (Capacity Planning) before changing its kind away from Lab.',
  WORKFLOW_CHANGE_WITH_PROGRESS: 'Projects already have progress recorded on this workflow, so this change is refused. Clear or finish that progress first, or leave the step as it is.',
  BAD_CALENDAR: 'The leave and holiday days add up to the whole year. Reduce them so at least some working weeks remain.',
  // Projects (P9 §6)
  CATEGORY_WORKFLOW_MISMATCH: "That category does not belong to this hub's workflow (OEM hubs use A-OEM / B-OEM / C-OEM).",
  // Workspace (P9 §7)
  STAGE_INCONSISTENT: 'These progress values contradict each other.',
  STAGE_SKIPPED: 'This stage is skipped for the project and has no progress of its own.',
  RUN_IN_PROGRESS: 'A recalculation is already running. Wait for it to finish, then try again.',
  FILE_TOO_LARGE: 'Files are limited to 50 MB.',
  UNSUPPORTED_FILE_TYPE: "That file type isn't allowed, or its contents don't match its extension.",
  NOT_AUTHOR: 'Only the author can edit this comment.',
  EDIT_LOCKED: 'The 15-minute edit window has closed — this comment is now locked.',
  // P9-R02 / DOMAIN_RULES remediation ruling 3: stage PATCH on a frozen project.
  PROJECT_FROZEN: 'This project is frozen. Unfreeze on the Gantt to record stage progress.',
  // P9-R02 / security S-02: comment creation is rate-limited per user (429).
  RATE_LIMITED: RATE_LIMITED_MESSAGE, // Retry-After-aware copy: rateLimitedMessage()
};



/** Flatten a `detail` that the client stored as JSON text (a FastAPI
 *  `[{loc, msg, type}]` list) into "field: message; …". */
export function flattenDetail(detail: string | undefined): string | undefined {
  if (!detail?.startsWith('[')) return detail;
  try {
    const items = JSON.parse(detail) as { loc?: unknown[]; msg?: string }[];
    return items
      .map((i) => {
        const field = Array.isArray(i.loc) ? i.loc.filter((p) => p !== 'body').join('.') : '';
        return field ? `${field}: ${i.msg ?? ''}` : (i.msg ?? '');
      })
      .join('; ');
  } catch {
    return detail;
  }
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  // 429 first: its copy depends on Retry-After, not just on the code.
  if (err.status === 429) return rateLimitedMessage(err.retryAfterSeconds);
  const known = err.code ? API_ERROR_MESSAGES[err.code] : undefined;
  const detail = flattenDetail(err.detail);
  if (known) {
    // Field-level detail adds information for the two multi-field codes.
    return (err.code === 'STAGE_INCONSISTENT' || err.code === 'BAD_CALENDAR') && detail ? `${known} ${detail}` : known;
  }
  if (err.isForbidden) return 'Your role cannot make this change.';
  return detail ?? fallback;
}
