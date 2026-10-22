import type { Hub } from '@/lib/api/reference';
import type { LabRegion } from '@/types/enums';

/**
 * P29 (ADR 0042, API_CONTRACT_P29 §1.1): hub picker labels.
 *
 * A hub whose served `capacity_hub_name` is set (OEM-HCK, OEM-Seitek) is a
 * MEMBER hub: its design work is done by its capacity hub's engineers and is
 * counted in that hub's capacity row. Pickers label it with the capacity hub's
 * country, e.g. "OEM-HCK (Greece)". The mapping is never hard-coded: the
 * country is the served `lab_region` of the capacity hub found by the served
 * `capacity_hub_id` (falling back to the hub's own served `lab_region` while
 * the capacity hub is not in the list, e.g. for a scoped caller).
 *
 * An older API without the P29 fields (`capacity_hub_name` absent) gives the
 * plain name.
 */
type HubLike = Pick<Hub, 'id' | 'name' | 'lab_region'> & Partial<Pick<Hub, 'capacity_hub_id' | 'capacity_hub_name'>>;

/** True when the hub is a member of another hub's capacity (served field). */
export function isMemberHub(hub: Partial<Pick<Hub, 'capacity_hub_name'>>): boolean {
  return hub.capacity_hub_name !== undefined && hub.capacity_hub_name !== null;
}

/** The country a member hub's capacity sits in, or null for a capacity hub. */
export function capacityCountryOf(hub: HubLike, hubs?: readonly HubLike[]): LabRegion | null {
  if (!isMemberHub(hub)) return null;
  const capacityHub = hubs?.find((h) => h.id === hub.capacity_hub_id);
  return capacityHub?.lab_region ?? hub.lab_region;
}

/** "OEM-HCK (Greece)" for a member hub, the plain name otherwise. */
export function hubPickerLabel(hub: HubLike, hubs?: readonly HubLike[]): string {
  const country = capacityCountryOf(hub, hubs);
  return country === null ? hub.name : `${hub.name} (${country})`;
}

/** The hubs an ENGINEER may be placed on (API_CONTRACT_P29 §5.2): capacity hubs
 *  only (`capacity_hub_id == null`); a member hub is a 422 `HUB_NOT_CAPACITY_HUB`. */
export function capacityHubsOnly<T extends Partial<Pick<Hub, 'capacity_hub_id'>>>(hubs: readonly T[]): T[] {
  return hubs.filter((h) => h.capacity_hub_id === undefined || h.capacity_hub_id === null);
}

/** Member hub names grouped by their served capacity hub, e.g.
 *  `[{ capacityHub: "R&D-Greece", members: ["OEM-HCK", "OEM-Seitek"] }]`. */
export function memberHubsByCapacityHub(
  hubs: readonly HubLike[],
): { capacityHub: string; members: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const h of hubs) {
    if (!isMemberHub(h)) continue;
    const key = h.capacity_hub_name ?? '';
    const list = groups.get(key);
    if (list) list.push(h.name);
    else groups.set(key, [h.name]);
  }
  return [...groups.entries()].map(([capacityHub, members]) => ({ capacityHub, members }));
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}
