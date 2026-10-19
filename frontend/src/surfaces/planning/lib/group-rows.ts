/**
 * Display-only grouping for Capacity Planning (P13-T17): engineers by hub,
 * chambers by lab region. Rows keep their served order inside a group; groups
 * follow a canonical order (unknown keys last, alphabetically). No figure is
 * derived here.
 */
export interface RowGroup<T> {
  key: string;
  rows: T[];
}

export function groupRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  order: readonly string[] = [],
): RowGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const rank = (key: string): number => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, list]) => ({ key, rows: list }));
}
