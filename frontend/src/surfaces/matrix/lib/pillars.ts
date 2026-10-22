/**
 * P26 (ADR 0037): pillars are data. A dimension's pillar is a served free-text
 * field, an Admin may create a new one, and the order is the served
 * `display_order`. Pillars are therefore grouped in order of FIRST APPEARANCE in
 * the served (display-ordered) list, the same rule as `ScoringRubric.pillars`,
 * and dimensions keep their served order inside a pillar. Display only.
 */

export interface PillarGroup<T> {
  pillar: string;
  items: T[];
}

/** Group a display-ordered list by pillar, pillars in order of first appearance. */
export function groupByPillar<T extends { pillar: string }>(items: readonly T[]): PillarGroup<T>[] {
  const groups: PillarGroup<T>[] = [];
  const byPillar = new Map<string, PillarGroup<T>>();
  for (const item of items) {
    let group = byPillar.get(item.pillar);
    if (!group) {
      group = { pillar: item.pillar, items: [] };
      byPillar.set(item.pillar, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** The same items, flattened pillar by pillar (first appearance), served order within each. */
export function sortByPillar<T extends { pillar: string }>(items: readonly T[]): T[] {
  return groupByPillar(items).flatMap((g) => g.items);
}
