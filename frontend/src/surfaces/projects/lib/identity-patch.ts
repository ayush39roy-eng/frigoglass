/**
 * Register popup (owner 2026-11-17): the identity part of the one Save. Of
 * the registration form's body, only the fields that changed are sent through
 * `PATCH /projects/{id}` (a key present is an explicit set server-side). The
 * register fields the popup saves in the `POST /projects/register-edits`
 * batch are never in it, so one Save is one recalculation for them.
 *
 * Commercially sensitive values (customer, TCOGS, selling price, gross
 * margin) may be in the body: nothing here logs or prints them.
 */

import type { ProjectCreateRequest, ProjectRead, ProjectUpdateRequest } from '@/surfaces/registration/api/types';

/** Saved in the register batch by the popup, never in its PATCH. */
export const REGISTER_BATCH_KEYS = [
  'hub_id',
  'leader_engineer_id',
  'actual_start_week',
  'certification_testing_required',
  'design_effort_weeks',
  'lab_effort_weeks',
] as const;

const SKIP = new Set<string>(REGISTER_BATCH_KEYS);

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  // A textarea turns CRLF into LF; empty and unset are the same "unset".
  const norm = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const t = v.replace(/\r\n/g, '\n');
      return t === '' ? null : t;
    }
    return v ?? null;
  };
  return norm(a) === norm(b);
}

export function identityChanges(body: Partial<ProjectCreateRequest>, project: ProjectRead): ProjectUpdateRequest {
  const out: Record<string, unknown> = {};
  const served = project as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (SKIP.has(key) || value === undefined) continue;
    if (!same(value, served[key])) out[key] = value;
  }
  return out as ProjectUpdateRequest;
}
