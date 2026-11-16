/**
 * P38-T06 (ADR 0053 §3, API_CONTRACT_P38 §2): the deactivation dialog's copy
 * and its client-side row state. Nothing here decides eligibility, load or
 * supply: candidates, their order and every figure are served by the preview.
 * The browser only holds the Admin's choice per row and builds the request.
 */

import type { DeactivateRequest, DeactivationOpenProject, DeactivationReason } from '../api/types';

/** The served flag; an API before P38 omits it, which means active. */
export function isInactive(engineer: { active?: boolean | undefined }): boolean {
  return engineer.active === false;
}

export const DEACTIVATION_REASONS: readonly { value: DeactivationReason; label: string }[] = [
  { value: 'left_company', label: 'Left the company' },
  { value: 'changed_role', label: 'Changed role' },
  { value: 'long_absence', label: 'Long absence' },
  { value: 'other', label: 'Other' },
];

export function reasonLabel(reason: DeactivationReason | null | undefined): string | null {
  return DEACTIVATION_REASONS.find((r) => r.value === reason)?.label ?? null;
}

/** The register filtered to "No leader" (ADR 0053 §3 "Findable"; the register
 *  reads `?leader=no_leader` once P38-T07 wires the filter option). */
export const NO_LEADER_REGISTER_PATH = '/projects?leader=no_leader';

export const DEACTIVATION_COPY = {
  /** Contract §2, verbatim; N is the number of empty rows. */
  warningSecond:
    'Their recorded stages will not show on the Gantt, and any lab test in progress gives up its chamber in the plan, until someone sets a leader.',
  frozenNeedsLeader: 'Unfreeze this project on the Timeline (Gantt) first.',
  frozenRequired: 'Frozen: a new leader is required.',
  noOpenProjects: 'This engineer leads no open project, so no leader needs to change.',
  changed: 'The projects this engineer leads changed since the list was loaded. The list is refreshed; your choices are kept where the project is still listed. Review and confirm again.',
  busy: 'Another change to this engineer or their projects is being saved. Nothing was changed. Try again in a moment.',
  adminOnly: 'Only an Admin or Super Admin can deactivate or reactivate an engineer.',
  alreadyInactive: 'This engineer is already inactive.',
  alreadyActive: 'This engineer is already active.',
  loginLinked: 'A login is linked to this engineer. Deactivating does not disable it; manage it on the Users page.',
  loginNotLinked: 'No login is linked to this engineer.',
  reactivateBody:
    'They become available as a leader and count in capacity again from now on. They do not get back the projects that were reassigned or left without a leader, and no recalculation runs.',
  notNeeded: 'No recalculation was needed: the plan does not change.',
  deferred: 'The timeline updates automatically after the current recalculation.',
  queuedWithoutRun: 'The recalculation was queued, but no run was reported back. Press Apply logic to update the timeline.',
  failedRun: 'The deactivation is saved. The recalculation did not complete; press Apply logic to try again.',
} as const;

/** Contract §2 first sentence, verbatim. */
export function noLeaderWarning(count: number): string {
  return `These ${String(count)} projects will have no leader. They will not be scheduled (Left out: no leader) until someone sets a leader.`;
}

export function noEligibleCopy(hub: string): string {
  return `No eligible engineer in ${hub}`;
}

/** projectId → chosen leader id, or '' for "no leader". */
export type LeaderChoices = Readonly<Record<string, string>>;

export function emptyRows(rows: readonly DeactivationOpenProject[], choices: LeaderChoices): DeactivationOpenProject[] {
  return rows.filter((r) => !choices[r.project_id]);
}

/** Frozen rows with no choice: the request would be a 422 FROZEN_NEEDS_LEADER. */
export function blockedFrozenRows(rows: readonly DeactivationOpenProject[], choices: LeaderChoices): DeactivationOpenProject[] {
  return emptyRows(rows, choices).filter((r) => r.frozen);
}

/** The second warning sentence applies when an empty row is progress-tracked or has a lab test in flight. */
export function needsSecondSentence(empty: readonly DeactivationOpenProject[]): boolean {
  return empty.some((r) => r.progress_tracked || r.in_flight_lab);
}

/**
 * "Use one leader for all": fills only the EMPTY rows whose served candidate
 * list includes that engineer (a row never gets a leader the server did not
 * offer for it). Rows already chosen are kept.
 */
export function fillEmptyRows(rows: readonly DeactivationOpenProject[], choices: LeaderChoices, engineerId: string): LeaderChoices {
  const next: Record<string, string> = { ...choices };
  for (const r of rows) {
    if (next[r.project_id]) continue;
    if (r.candidates.some((c) => c.engineer_id === engineerId)) next[r.project_id] = engineerId;
  }
  return next;
}

/** Engineers offered by "Use one leader for all": every served candidate of
 *  any row, once, in first-served order (no ranking is computed here). */
export function oneForAllOptions(rows: readonly DeactivationOpenProject[]): { engineer_id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) for (const c of r.candidates) if (!seen.has(c.engineer_id)) seen.set(c.engineer_id, c.name);
  return [...seen.entries()].map(([engineer_id, name]) => ({ engineer_id, name }));
}

/** After a 409 refresh: keep a choice only when its project is still listed and
 *  the chosen engineer is still one of its served candidates. */
export function keepValidChoices(rows: readonly DeactivationOpenProject[], choices: LeaderChoices): LeaderChoices {
  const next: Record<string, string> = {};
  for (const r of rows) {
    const chosen = choices[r.project_id];
    if (chosen && r.candidates.some((c) => c.engineer_id === chosen)) next[r.project_id] = chosen;
  }
  return next;
}

/** The request names exactly the listed open set, one row per project. */
export function buildDeactivateRequest(
  rows: readonly DeactivationOpenProject[],
  choices: LeaderChoices,
  reason: DeactivationReason,
  token: string,
): DeactivateRequest {
  return {
    reason,
    led_projects_token: token,
    reassignments: rows.map((r) => ({ project_id: r.project_id, leader_engineer_id: choices[r.project_id] || null })),
  };
}
