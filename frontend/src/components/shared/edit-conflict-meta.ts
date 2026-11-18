/**
 * P47-T03 (ADR 0059 C2): the words of the conflict dialog. Friendly field
 * names and the plain rendering of a served value. Display only: a value is
 * shown as the server sent it (I9), never recomputed.
 */

import { HIDDEN_VALUE, type EditConflict } from '@/lib/api/edit-conflict';

const FIELD_LABELS: Record<string, string> = {
  // Projects (register, PATCH, popup)
  name: 'Name',
  status: 'Status',
  hub_id: 'Hub',
  leader_engineer_id: 'Project leader',
  actual_start_week: 'Actual start',
  actual_end_week: 'Actual end',
  design_effort_weeks: 'Design time',
  lab_effort_weeks: 'Lab time',
  certification_testing_required: 'Needs lab testing',
  current_step_code: 'Current step',
  step_exclusions: 'Excluded steps',
  category: 'Category',
  category_code: 'Category',
  type: 'Type',
  project_type: 'Type',
  description: 'Description',
  objective: 'Objective',
  expected_end_week: 'Expected end',
  expected_completion_week: 'Expected completion',
  target_end_week: 'Target end',
  start_week: 'Start week',
  end_week: 'End week',
  manual_start_week: 'Start week',
  manual_end_week: 'End week',
  frozen: 'Frozen',
  band_rank: 'Rank in band',
  priority: 'Priority',
  priority_band: 'Priority band',
  is_vip: 'VIP',
  scoring_tags: 'Scoring tags',
  // Financial (always hidden in a 409)
  tcogs: 'TCOGS',
  tcogs_eur: 'TCOGS',
  gross_margin: 'Gross margin',
  gross_margin_pct: 'Gross margin',
  selling_price: 'Selling price',
  selling_price_eur: 'Selling price',
  customer_name: 'Customer',
  // Engineers / chambers / users
  full_name: 'Name',
  email: 'Email',
  role: 'Role',
  roles: 'Roles',
  fte: 'FTE',
  skills: 'Skills',
  is_active: 'Active',
  active: 'Active',
  manager_id: 'Manager',
  hub_ids: 'Hubs',
  hub_scope_all: 'All hubs',
  platforms: 'Platforms',
  max_concurrent: 'Platforms',
  efficiency: 'Efficiency',
  maintenance_weeks: 'Maintenance weeks',
  breakdown_weeks: 'Breakdown weeks',
  calibration_weeks: 'Calibration weeks',
  // Stages / check-ins
  step_status: 'Step status',
  progress_pct: 'Progress',
  remaining_weeks: 'Remaining weeks',
  tracking_status: 'Tracking status',
  comment: 'Comment',
  notes: 'Notes',
  // Matrix
  scores: 'Scores',
  band: 'Priority band',
  // VIP
  title: 'Title',
  owner: 'Owner',
  due_date: 'Due date',
  project_ids: 'Projects',
  // Workflow settings
  duration_weeks: 'Duration',
  steps: 'Steps',
  lead_times: 'Lead times',
  // What-if
  label: 'Name',
};

/** "leader_engineer_id" → "Project leader"; an unknown key is humanised. */
function humanise(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  const raw = field.replace(/_id$/, '').replace(/[_.]+/g, ' ').trim();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function conflictFieldLabel(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  const dot = field.indexOf('.');
  if (dot < 0) return humanise(field);
  const head = field.slice(0, dot);
  const tail = field.slice(dot + 1);
  if (head === 'scores' || head === 'score') return humanise(tail);
  if (head === 'step_exclusions') return `Excluded step ${tail}`;
  // `<step_id>.<field>`: a stage's own field.
  return `${head} ${humanise(tail).toLowerCase()}`;
}

/** A served value as plain text. `"<hidden>"` → "hidden"; null → "empty". */
export function formatConflictValue(value: unknown): string {
  if (value === HIDDEN_VALUE) return 'hidden';
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return value
      .map((v) => {
        if (v && typeof v === 'object' && 'step_code' in v) {
          const o = v as { step_code: unknown; step_excluded?: unknown };
          return `${String(o.step_code)}${o.step_excluded === false ? ' (included)' : o.step_excluded === true ? ' (excluded)' : ''}`;
        }
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      })
      .join(', ');
  }
  return JSON.stringify(value);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Changed by Maria Papadopoulou at 14:05" (with the date when not today). */
export function conflictChangedText(conflict: Pick<EditConflict, 'changed_by' | 'changed_at'>, now: Date = new Date()): string {
  const who = conflict.changed_by ?? 'someone else';
  if (!conflict.changed_at) return `Changed by ${who}`;
  const at = new Date(conflict.changed_at);
  if (Number.isNaN(at.getTime())) return `Changed by ${who}`;
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (sameDay(at, now)) return `Changed by ${who} at ${hhmm}`;
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `Changed by ${who} on ${day} at ${hhmm}`;
}
