import { z } from 'zod';

import {
  HUB_NAMES,
  PROJECT_CATEGORIES,
  PROJECT_PRIORITIES,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_STEP_STATUSES,
} from '@/types/enums';

import type { ImportParseResponse, ImportRow, ImportSimulateResponse } from './import-types';

/**
 * Runtime checks of the two plan-import responses (docs/API_CONTRACT_P32.md B2 / B3).
 *
 * The objects are NOT strict: a field the server adds later is dropped, never an error, so
 * the rows the browser sends back to `/simulate` (a strict body) carry exactly the contract's
 * fields. Enums are checked where the view branches on them; free labels (status chips of the
 * capacity windows, project status) stay strings and are shown as served.
 */

const int = z.number().int();
const nint = int.nullable();
const nstr = z.string().nullable();
const severity = z.enum(['info', 'warning', 'error']);
const workflow = z.enum(['PDD', 'OEM']);
const outcome = z.enum(['within_year', 'spillover', 'left_out', 'blocked', 'excluded', 'data_error']);

export const leaderSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('existing'),
    engineer_id: z.string(),
    name: z.string(),
  }),
  z.object({ kind: z.literal('new'), name: z.string() }),
  z.object({ kind: z.literal('auto') }),
]);

export const importRowSchema: z.ZodType<ImportRow> = z.object({
  key: z.string(),
  file_row: int,
  sn: nstr,
  code: nstr,
  plant: nstr,
  name: z.string(),
  hub: z.enum(HUB_NAMES),
  hub_raw: nstr,
  category: z.enum(PROJECT_CATEGORIES),
  category_raw: nstr,
  lead_time_label: z.string(),
  status: z.string(),
  status_raw: nstr,
  stage_step_id: nstr,
  stage_raw: nstr,
  rank: nint,
  priority: z.enum(PROJECT_PRIORITIES),
  priority_source: z.enum(['rank', 'running', 'matched', 'default']),
  engineer_raw: nstr,
  leader: leaderSchema,
  matched_project_id: nstr,
  matched_project_name: nstr,
  match_by: z.enum(['name', 'code']).nullable(),
  num_projects: nint,
  must_do: z.boolean().nullable(),
  spillover_from_previous: z.boolean().nullable(),
  complexity: nstr,
  est_duration_months: nstr,
  certification_testing_required: z.boolean(),
  step_weeks: z.record(z.string(), int),
  include: z.boolean(),
});

const stepMetaSchema = z.object({
  workflow,
  step_id: z.string(),
  name: z.string(),
  kind: z.enum(WORKFLOW_STEP_KINDS),
  sequence_order: int,
  predecessor_ids: z.array(z.string()),
});

export const importParseResponseSchema: z.ZodType<ImportParseResponse> = z.object({
  file_name: z.string(),
  projects_sheet: z.string(),
  steps_sheet: nstr,
  base_year: int,
  current_week: int,
  lead_times: z.array(
    z.object({
      workflow,
      label: z.string(),
      weeks: z.record(z.string(), int),
    }),
  ),
  steps_meta: z.array(stepMetaSchema),
  roster: z.array(
    z.object({
      engineer_id: z.string(),
      name: z.string(),
      hub: z.string(),
      capacity_hub: z.string(),
      fte: z.number(),
    }),
  ),
  rows: z.array(importRowSchema),
  issues: z.array(
    z.object({
      row_key: nstr,
      file_row: nint,
      field: nstr,
      severity,
      code: z.string(),
      message: z.string(),
    }),
  ),
  counts: z.object({
    rows: int,
    schedulable: int,
    not_scheduled: int,
    matched: int,
    new: int,
    auto_assign: int,
    new_designers: int,
    projects_after_expansion: int.optional(),
    derived_status: int,
    not_a_project: int,
  }),
});

const windowFigure = z.object({
  key: z.string(),
  load_weeks: z.number(),
  capacity_weeks: z.number(),
  booked_pct: z.number().nullable(),
  status: z.string(),
});
const weekly = z.object({
  load: z.array(z.number()),
  capacity: z.array(z.number()),
});
const change = z.object({
  ref: z.string(),
  name: z.string(),
  hub: z.string(),
  before_finish_week: nint,
  after_finish_week: nint,
});

const bucket = z.object({
  key: z.string(),
  total: int,
  within_year: int,
  spillover: int,
  not_placed: int,
});

const breakdown = z.object({
  total: int,
  file: int,
  plan: int,
  outcomes: z.object({
    within_year: int,
    spillover: int,
    left_out: int,
    blocked: int,
    data_error: int,
    excluded: int,
  }),
  by_category: z.array(bucket),
  by_hub: z.array(bucket),
  by_priority: z.array(bucket),
  by_status: z.array(bucket),
  by_source: z.array(bucket),
  by_finish_quarter: z.array(z.object({ key: z.string(), label: z.string(), count: int })),
});

/** C1 (P32-R05): optional, a server without it still validates. */
const breakdowns = z.object({
  years: z.array(z.object({ key: z.string(), label: z.string() })),
  by_year: z.record(z.string(), breakdown),
});

export const importSimulateResponseSchema: z.ZodType<ImportSimulateResponse> = z.object({
  base_year: int,
  current_week: int,
  plan_year_end_week: int,
  horizon_weeks: int,
  mode: z.enum(['merge', 'file_only']),
  kpis: z.object({
    projects_total: int,
    file_projects: int,
    plan_projects: int,
    within_plan_year: int,
    spillover: int,
    left_out: int,
    blocked: int,
    excluded: int,
    data_error: int,
    file_within_plan_year: int,
    file_scheduled: int,
    before_within_plan_year: nint,
    after_within_plan_year_existing: nint,
    newly_slipping: int,
    recovered: int,
  }),
  steps_meta: z.array(stepMetaSchema),
  projects: z.array(
    z.object({
      ref: z.string(),
      source: z.enum(['file', 'plan']),
      file_row: nint,
      replaces_project_id: nstr,
      name: z.string(),
      hub: z.string(),
      capacity_hub: z.string(),
      category: z.string(),
      priority: z.string(),
      status: z.string(),
      leader_name: nstr,
      leader_ref: nstr,
      leader_auto_assigned: z.boolean(),
      outcome,
      start_week: nint,
      end_week: nint,
      finish_week: nint,
      unconstrained_end_week: nint,
      before_outcome: outcome.nullable(),
      before_finish_week: nint,
      eng_conflict: z.boolean(),
      cat_not_allowed: z.boolean(),
      no_chamber_step_id: nstr,
      data_error: nstr,
      within_plan_year: z.boolean().optional(),
      lab_overlap: z.boolean().optional(),
      no_leader: z.boolean().optional(),
      steps: z.array(
        z.object({
          step_id: z.string(),
          kind: z.enum(WORKFLOW_STEP_KINDS),
          sequence_order: int,
          start_week: nint,
          end_week: nint,
          duration_weeks: nint,
          span_weeks: nint,
          skipped: z.boolean(),
          done_before_import: z.boolean(),
          status: z.enum(WORKFLOW_STEP_STATUSES),
          engineer_name: nstr,
          chamber_code: nstr,
          duration_override_weeks: nint,
          start_not_before_week: nint,
          overlap_weeks: nint,
          editable: z.enum(['move_resize', 'resize', 'none']),
        }),
      ),
    }),
  ),
  capacity: z.object({
    windows: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        from_week: int,
        to_week: int,
      }),
    ),
    hubs: z.array(
      z.object({
        hub: z.string(),
        fte: z.number(),
        windows: z.array(windowFigure),
      }),
    ),
    lab_regions: z.array(
      z.object({
        region: z.string(),
        chambers: int,
        windows: z.array(windowFigure),
      }),
    ),
    weekly: z.object({
      weeks: z.array(int),
      hubs: z.record(z.string(), weekly),
      lab_regions: z.record(z.string(), weekly),
    }),
    designers: z.array(
      z.object({
        ref: z.string(),
        name: z.string(),
        hub: z.string(),
        fte: z.number(),
        is_new: z.boolean(),
        windows: z.array(
          z.object({
            key: z.string(),
            booked_weeks: z.number(),
            booked_span_weeks: z.number().optional(),
            available_weeks: z.number(),
            booked_pct: z.number().nullable(),
            status: z.string(),
          }),
        ),
      }),
    ),
  }),
  changes: z.object({
    newly_slipping: z.array(change),
    recovered: z.array(change),
    moved: z.array(change),
  }),
  issues: z.array(z.object({ ref: nstr, severity, code: z.string(), message: z.string() })),
  workings: z.array(z.string()),
  breakdowns: breakdowns.optional(),
});

// --- client-side checks before a request is sent ------------------------------------------

/** Mirrors ADR 0044 §11 / B2: the server stays the authority (413 / 422 still handled). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** ≤ 600 projects per simulate (after expansion, which only the server does). */
export const MAX_IMPORT_PROJECTS = 600;
export const MAX_DESIGNER_NAME = 100;

export function checkImportFile(file: { name: string; size: number }): string | null {
  if (!/\.xlsx$/i.test(file.name.trim())) return 'Choose an Excel workbook (.xlsx).';
  if (file.size > MAX_FILE_BYTES) return 'The file is larger than 5 MB. Remove unused sheets or rows and try again.';
  if (file.size === 0) return 'The file is empty.';
  return null;
}

const newDesignerName = z
  .string()
  .trim()
  .min(1, 'Type the new designer’s name.')
  .max(MAX_DESIGNER_NAME, `At most ${String(MAX_DESIGNER_NAME)} characters.`);

/** Per-row form errors (key → message) for the rows the planner has edited. */
export function rowErrors(rows: readonly ImportRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.include) continue;
    if (r.leader.kind === 'new') {
      const res = newDesignerName.safeParse(r.leader.name);
      if (!res.success) out[r.key] = res.error.issues[0]?.message ?? 'Invalid name.';
    }
  }
  return out;
}

/** Why "Compute plan" is off, or null when the rows may be sent. */
export function computeBlockedReason(rows: readonly ImportRow[]): string | null {
  const included = rows.filter((r) => r.include).length;
  if (included === 0) return 'Include at least one row to compute the plan.';
  if (included > MAX_IMPORT_PROJECTS)
    return `At most ${String(MAX_IMPORT_PROJECTS)} projects can be imported at once (${String(included)} included).`;
  const errs = Object.keys(rowErrors(rows)).length;
  if (errs > 0) return `Fix the highlighted engineer name${errs === 1 ? '' : 's'} first.`;
  return null;
}
