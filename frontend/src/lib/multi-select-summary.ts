/**
 * The trigger text of `<MultiSelectDropdown>` (owner ask 2026-11-13): "All
 * statuses" when nothing is selected, the one label for one pick, else
 * "N <noun>" ("3 statuses"). Labels only; no figure is computed here.
 */
export function summarizeSelection(
  selected: readonly { label: string }[],
  allLabel: string,
  pluralNoun?: string,
): string {
  if (selected.length === 0) return allLabel;
  if (selected.length === 1) return selected[0]?.label ?? allLabel;
  const noun = pluralNoun ?? allLabel.replace(/^all\s+/i, '');
  return `${String(selected.length)} ${noun}`;
}
