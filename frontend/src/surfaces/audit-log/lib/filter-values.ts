/** Server cap per repeated param (multi-select contract §1). */
const MAX_VALUES = 50;

/**
 * Multi-select (owner ask 2026-11-13): the free-text Entity type / Actor /
 * Action filters take several values separated by commas, each sent as one
 * repeated param (ORed by the server). There is no served list of actions,
 * entity types or actors to pick from, so these stay typed; the Hub filter is
 * a multi-select dropdown. Blank pieces and duplicates are dropped.
 */
export function splitFilterValues(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    const v = piece.trim();
    if (v !== '' && !out.includes(v)) out.push(v);
  }
  return out.slice(0, MAX_VALUES);
}
