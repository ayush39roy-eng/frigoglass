/**
 * P19-T06: hub FAMILY for display grouping on the Capacity page (owner ruling
 * 2026-10-21). The family is read from the hub name prefix through this ONE
 * mapping; nothing else on the page knows the prefixes.
 *
 *   "R&D-"  -> R&D                       (R&D-Greece, R&D-India)
 *   "PD-"   -> PD (Product Development)  (PD-India, PD-Romania)
 *   "OEM-"  -> OEM                       (OEM-HCK, OEM-Seltek)
 *
 * A hub with an unknown prefix falls into "Other hubs", shown last, so a new
 * hub is never hidden. Grouping is selection only: no figure is added up here
 * (I9/I19). No family aggregate is served by the API, so the page shows none.
 */
export type HubFamilyKey = 'rd' | 'pd' | 'oem' | 'other';

export interface HubFamily {
  key: HubFamilyKey;
  /** Visible family name, e.g. "PD (Product Development)". */
  label: string;
  /** Short name for tight places and accessible names, e.g. "PD". */
  short: string;
}

const FAMILIES: readonly (HubFamily & { prefix: string })[] = [
  { key: 'rd', label: 'R&D', short: 'R&D', prefix: 'R&D-' },
  { key: 'pd', label: 'PD (Product Development)', short: 'PD', prefix: 'PD-' },
  { key: 'oem', label: 'OEM', short: 'OEM', prefix: 'OEM-' },
];

const OTHER: HubFamily = { key: 'other', label: 'Other hubs', short: 'Other' };

/** Display order of the families. */
export const FAMILY_ORDER: readonly HubFamilyKey[] = ['rd', 'pd', 'oem', 'other'];

/** The family of a hub, from its name prefix. */
export function hubFamily(hub: string): HubFamily {
  const hit = FAMILIES.find((f) => hub.startsWith(f.prefix));
  return hit ? { key: hit.key, label: hit.label, short: hit.short } : OTHER;
}

export interface FamilyGroup<T> {
  family: HubFamily;
  rows: T[];
}

/**
 * The served rows grouped by family, families in `FAMILY_ORDER`, rows in their
 * served order inside a family. Families with no served row are omitted, so a
 * hub-scoped user never sees an empty group.
 */
export function groupByHubFamily<T extends { hub: string }>(rows: readonly T[]): FamilyGroup<T>[] {
  const groups = new Map<HubFamilyKey, FamilyGroup<T>>();
  for (const row of rows) {
    const family = hubFamily(row.hub);
    const hit = groups.get(family.key);
    if (hit) hit.rows.push(row);
    else groups.set(family.key, { family, rows: [row] });
  }
  return FAMILY_ORDER.flatMap((k) => {
    const g = groups.get(k);
    return g ? [g] : [];
  });
}

/**
 * For rows in DISPLAY order: the hub on which each lab region's figures are
 * shown (its first row). Lab figures are region-level (I7, ADR 0016), so later
 * rows of the same region point back to this hub instead of repeating them.
 */
export function firstHubPerLabRegion<T extends { hub: string; lab_region: string }>(
  rowsInDisplayOrder: readonly T[],
): Map<string, string> {
  const first = new Map<string, string>();
  for (const row of rowsInDisplayOrder) {
    if (!first.has(row.lab_region)) first.set(row.lab_region, row.hub);
  }
  return first;
}
