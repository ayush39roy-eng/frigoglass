/** Segments of the plan-import stacked bars (P32-R05): served bucket fields, token colours. */
export const STACK_SEGMENTS = [
  { key: 'within_year', label: 'Within the plan year', fill: 'hsl(var(--color-success))' },
  { key: 'spillover', label: 'Spills over', fill: 'hsl(var(--color-warning))' },
  { key: 'not_placed', label: 'Not placed', fill: 'hsl(var(--color-danger) / 0.7)' },
] as const;

/** Served bucket key → label ("unknown" is the backend's key for a missing value). */
export function bucketLabel(key: string): string {
  return key === 'unknown' ? 'Unknown' : key;
}
