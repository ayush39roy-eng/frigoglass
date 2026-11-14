import type { Hub } from '@/lib/api/reference';
import type { MeResponse } from '@/lib/api/session';
import { LAB_REGIONS, type LabRegion } from '@/types/enums';

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
  if (!me || !hubs || !Array.isArray(hubs)) return null;
  if (me.hub_scope_all || !Array.isArray(me.hub_ids) || me.hub_ids.length === 0) return [...hubs];
  const ids = new Set(me.hub_ids);
  return hubs.filter((h) => ids.has(h.id));
}

/** `true` when a persisted `hubId` must reset to "All hubs": it is set and not
 *  among the in-scope options. `null` options (still loading) never reset. */
export function shouldResetHub(hubId: string | null, options: readonly Hub[] | null): boolean {
  if (hubId === null || options === null || !Array.isArray(options)) return false;
  return !options.some((h) => h.id === hubId);
}

/**
 * P13 (ADR 0025, contract §4): the countries the filter offers — each served
 * `lab_region` that holds at least one in-scope hub, always in the fixed
 * Greece / India / Romania order. `null` while the hub list is unknown.
 */
export function regionsInScope(options: readonly Hub[] | null): LabRegion[] | null {
  if (options === null || !Array.isArray(options)) return null;
  const present = new Set(options.map((h) => h.lab_region));
  return LAB_REGIONS.filter((r) => present.has(r));
}

/** `true` when a persisted `region` must reset to "All hubs": it is set and no
 *  in-scope hub lies in it. `null` options (still loading) never reset. */
export function shouldResetRegion(region: LabRegion | null, regions: readonly LabRegion[] | null): boolean {
  if (region === null || regions === null || !Array.isArray(regions)) return false;
  return !regions.includes(region);
}

/**
 * Multi-select (contract §3): the persisted selection with every hub / country
 * that is no longer in scope dropped. Returns `null` when nothing needs to change
 * (or the scope is still loading), so callers write the store only on a real change.
 */
export function pruneHubSelection(
  hubIds: readonly string[],
  regions: readonly LabRegion[],
  options: readonly Hub[] | null,
  scopedRegions: readonly LabRegion[] | null,
): { hubIds: string[]; regions: LabRegion[] } | null {
  if (options === null || scopedRegions === null || !Array.isArray(options)) return null;
  const keepHubs = hubIds.filter((id) => !shouldResetHub(id, options));
  const keepRegions = regions.filter((r) => !shouldResetRegion(r, scopedRegions));
  if (keepHubs.length === hubIds.length && keepRegions.length === regions.length) return null;
  return { hubIds: keepHubs, regions: keepRegions };
}

/**
 * The header chip / trigger text for a hub selection: names joined with " + "
 * for up to two picks ("India + R&D-Greece"), otherwise a count ("3 hubs",
 * "2 countries", "2 countries + 1 hub"). `hubName` resolves a hub id.
 */
export function summarizeHubSelection(
  hubIds: readonly string[],
  regions: readonly LabRegion[],
  hubName: (id: string) => string,
): string {
  const n = hubIds.length + regions.length;
  if (n === 0) return 'All hubs';
  if (n <= 2) return [...regions, ...hubIds.map(hubName)].join(' + ');
  const plural = (k: number, one: string, many: string): string => `${String(k)} ${k === 1 ? one : many}`;
  if (regions.length === 0) return plural(hubIds.length, 'hub', 'hubs');
  if (hubIds.length === 0) return plural(regions.length, 'country', 'countries');
  return `${plural(regions.length, 'country', 'countries')} + ${plural(hubIds.length, 'hub', 'hubs')}`;
}
