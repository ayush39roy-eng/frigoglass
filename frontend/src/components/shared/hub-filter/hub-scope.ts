import type { Hub } from '@/lib/api/reference';
import type { MeResponse } from '@/lib/api/session';

/**
 * Which hubs the header's hub select offers (ADR 0020 §1). This narrows a
 * choice; it never decides what the server returns (the server ANDs `hub_id`
 * with the caller's RBAC scope and never widens it).
 *
 * - `hub_scope_all` → all six hubs from `GET /hubs`;
 * - otherwise `/me.hub_ids`, in `GET /hubs` order;
 * - a caller with no hub ids (an Engineer: no hub scope) → all six as narrowing
 *   choices.
 *
 * Returns `null` while either input is still unknown, so a persisted choice is
 * never reset against a half-loaded list.
 */
export function hubsInScope(me: MeResponse | null, hubs: readonly Hub[] | undefined): Hub[] | null {
  if (!me || !hubs) return null;
  if (me.hub_scope_all || me.hub_ids.length === 0) return [...hubs];
  const ids = new Set(me.hub_ids);
  return hubs.filter((h) => ids.has(h.id));
}

/** `true` when a persisted `hubId` must reset to "All hubs": it is set and not
 *  among the in-scope options. `null` options (still loading) never reset. */
export function shouldResetHub(hubId: string | null, options: readonly Hub[] | null): boolean {
  if (hubId === null || options === null) return false;
  return !options.some((h) => h.id === hubId);
}
