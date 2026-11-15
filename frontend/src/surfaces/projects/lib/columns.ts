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
  { id: 'priority', label: 'Priority' },
];
