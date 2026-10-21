/** Pillar order of the header bands and compare table (DOMAIN_RULES
 *  "Prioritization scoring"). A pillar not listed keeps its first-appearance
 *  order after these. Display ordering only. */
export const PILLAR_ORDER = [
  'Strategic Alignment',
  'Regulatory & Quality',
  'Financial Return',
  'Market & Volume',
  'Investment & Feasibility',
] as const;

export function sortByPillar<T extends { pillar: string }>(items: readonly T[]): T[] {
  const seen = [...new Set(items.map((d) => d.pillar))];
  const rank = (p: string) => {
    const i = (PILLAR_ORDER as readonly string[]).indexOf(p);
    return i === -1 ? PILLAR_ORDER.length + seen.indexOf(p) : i;
  };
  return items
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d.pillar) - rank(b.d.pillar) || a.i - b.i)
    .map(({ d }) => d);
}
