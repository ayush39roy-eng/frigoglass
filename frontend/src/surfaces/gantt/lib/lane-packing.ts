/**
 * Greedy interval lane packing for the "broken" project bar (ADR 0043, A4). Weeks are inclusive:
 * an item ending in week 5 and one starting in week 5 overlap and take two lanes. Pure layout — no
 * schedule number is derived here.
 */
export function packLanes<T extends { start: number; end: number }>(
  items: readonly T[],
): { item: T; lane: number }[] {
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.start - b.item.start || a.item.end - b.item.end || a.index - b.index);
  const laneEnds: number[] = [];
  const out: { item: T; lane: number }[] = [];
  for (const { item } of ordered) {
    let lane = laneEnds.findIndex((end) => end < item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    out.push({ item, lane });
  }
  return out;
}

/** Number of lanes used by a packing (at least 1, so an empty row keeps its height). */
export function laneCount(packed: readonly { lane: number }[]): number {
  let max = 0;
  for (const p of packed) max = Math.max(max, p.lane + 1);
  return Math.max(1, max);
}
