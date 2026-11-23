/** P35-T08: the register's optional columns a user may hide, in display order
 *  (ids of `components/projects-table.tsx`). The charter columns keep their
 *  own toggle (P24-T02). */
export const HIDEABLE_COLUMNS: readonly { id: string; label: string }[] = [
  { id: 'hub', label: 'Hub' },
  { id: 'category', label: 'Category' },
  { id: 'type', label: 'Type' },
  { id: 'status', label: 'Status' },
  { id: 'leader', label: 'Leader (design resource)' },
  { id: 'actual-start', label: 'Actual start' },
  { id: 'actual-end', label: 'Actual end' },
  { id: 'design-time', label: 'Design time' },
  { id: 'lab-time', label: 'Lab time' },
  { id: 'end-week', label: 'End week' },
  { id: 'current-step', label: 'Current step' },
  { id: 'steps', label: 'Steps (click to exclude)' },
  { id: 'priority', label: 'Priority' },
  // P54 (ADR 0064 R2): served band + rank, sortable, editable like the board.
  { id: 'rank', label: 'Rank' },
];

/** P58-B: the charter column ids of the table (`charter-${key}`), in display order. */
export const CHARTER_COLUMN_IDS = ['charter-plant', 'charter-requesting_department', 'charter-product_type'] as const;

/**
 * P58-B: the `columns` of `GET /exports/dashboard?view=register` — the optional
 * column ids currently visible on the table, in its order, so the "Projects
 * list" download is exactly the screen (and re-uploads into the What-if import).
 */
export function visibleExportColumns(hidden: readonly string[], showCharter: boolean): string[] {
  const shown = HIDEABLE_COLUMNS.map((c) => c.id).filter((id) => !hidden.includes(id));
  return showCharter ? [...shown, ...CHARTER_COLUMN_IDS] : shown;
}
