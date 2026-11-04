// Hand-authored mirror of docs/API_CONTRACT_P32.md Part B (B2 `POST /whatif/import/parse`,
// B3 `POST /whatif/import/simulate`, ADR 0044). The runtime shape is checked by the zod
// schemas in `import-schema.ts`; these types are what the rest of the import view reads.
// Every figure shown on the import view is one of these fields, as served (I9 / I19).

import type { ProjectCategory, ProjectPriority, WorkflowStepKind, WorkflowStepStatus } from '@/types/enums';

import type { WhatIfHub, WhatIfOutcome } from '../../api/whatif-types';

export type ImportWorkflow = 'PDD' | 'OEM';
export type ImportSeverity = 'info' | 'warning' | 'error';
export type ImportMode = 'merge' | 'file_only';
export type PlanYearEndWeek = 52 | 104;
export type PrioritySource = 'rank' | 'matched' | 'default';
export type StepEditable = 'move_resize' | 'resize' | 'none';

// --- B2: parse ---------------------------------------------------------------------------

export interface ImportLeadTime {
  workflow: ImportWorkflow;
  label: string;
  weeks: Record<string, number>;
}

export interface ImportStepMeta {
  workflow: ImportWorkflow;
  step_id: string;
  name: string;
  kind: WorkflowStepKind;
  sequence_order: number;
  predecessor_ids: string[];
}

export interface ImportRosterEntry {
  engineer_id: string;
  name: string;
  hub: string;
  capacity_hub: string;
  fte: number;
}

export type ImportLeader =
  { kind: 'existing'; engineer_id: string; name: string } | { kind: 'new'; name: string } | { kind: 'auto' };

/** One file row, as `/parse` returns it and as `/simulate` takes it back (possibly edited). */
export interface ImportRow {
  key: string;
  file_row: number;
  sn: string | null;
  code: string | null;
  plant: string | null;
  name: string;
  hub: WhatIfHub;
  hub_raw: string | null;
  category: ProjectCategory;
  category_raw: string | null;
  lead_time_label: string;
  status: string;
  status_raw: string | null;
  stage_step_id: string | null;
  stage_raw: string | null;
  rank: number | null;
  priority: ProjectPriority;
  priority_source: PrioritySource;
  engineer_raw: string | null;
  leader: ImportLeader;
  matched_project_id: string | null;
  matched_project_name: string | null;
  match_by: 'name' | 'code' | null;
  num_projects: number | null;
  must_do: boolean | null;
  spillover_from_previous: boolean | null;
  complexity: string | null;
  est_duration_months: string | null;
  certification_testing_required: boolean;
  step_weeks: Record<string, number>;
  include: boolean;
}

export interface ImportParseIssue {
  row_key: string | null;
  file_row: number | null;
  field: string | null;
  severity: ImportSeverity;
  code: string;
  message: string;
}

export interface ImportParseCounts {
  rows: number;
  schedulable: number;
  not_scheduled: number;
  matched: number;
  new: number;
  auto_assign: number;
  new_designers: number;
}

export interface ImportParseResponse {
  file_name: string;
  projects_sheet: string;
  steps_sheet: string | null;
  base_year: number;
  current_week: number;
  lead_times: ImportLeadTime[];
  steps_meta: ImportStepMeta[];
  roster: ImportRosterEntry[];
  rows: ImportRow[];
  issues: ImportParseIssue[];
  counts: ImportParseCounts;
}

// --- B3: simulate ------------------------------------------------------------------------

export interface ImportStepEdit {
  project_ref: string;
  step_id: string;
  duration_weeks: number | null;
  start_not_before_week: number | null;
  overlap_weeks: number | null;
}

export interface ImportSimulateRequest {
  mode: ImportMode;
  plan_year_end_week: PlanYearEndWeek;
  expand_multi: boolean;
  rows: ImportRow[];
  edits: ImportStepEdit[];
}

export interface ImportKpis {
  projects_total: number;
  file_projects: number;
  plan_projects: number;
  within_plan_year: number;
  spillover: number;
  left_out: number;
  blocked: number;
  excluded: number;
  data_error: number;
  file_within_plan_year: number;
  file_scheduled: number;
  before_within_plan_year: number | null;
  after_within_plan_year_existing: number | null;
  newly_slipping: number;
  recovered: number;
}

export interface ImportResultStep {
  step_id: string;
  kind: WorkflowStepKind;
  sequence_order: number;
  start_week: number | null;
  end_week: number | null;
  duration_weeks: number | null;
  span_weeks: number | null;
  skipped: boolean;
  done_before_import: boolean;
  status: WorkflowStepStatus;
  engineer_name: string | null;
  chamber_code: string | null;
  duration_override_weeks: number | null;
  start_not_before_week: number | null;
  overlap_weeks: number | null;
  editable: StepEditable;
}

export interface ImportResultProject {
  ref: string;
  source: 'file' | 'plan';
  file_row: number | null;
  replaces_project_id: string | null;
  name: string;
  hub: string;
  capacity_hub: string;
  category: string;
  priority: string;
  status: string;
  leader_name: string | null;
  leader_ref: string | null;
  leader_auto_assigned: boolean;
  outcome: WhatIfOutcome;
  start_week: number | null;
  end_week: number | null;
  finish_week: number | null;
  unconstrained_end_week: number | null;
  before_outcome: WhatIfOutcome | null;
  before_finish_week: number | null;
  eng_conflict: boolean;
  cat_not_allowed: boolean;
  no_chamber_step_id: string | null;
  data_error: string | null;
  /** Engine deltas (2026-11-04): served flags, shown as is. */
  within_plan_year?: boolean | undefined;
  lab_overlap?: boolean | undefined;
  no_leader?: boolean | undefined;
  steps: ImportResultStep[];
}

export interface CapacityWindowDef {
  key: string;
  label: string;
  from_week: number;
  to_week: number;
}

export interface CapacityWindowFigure {
  key: string;
  load_weeks: number;
  capacity_weeks: number;
  booked_pct: number | null;
  status: string;
}

export interface CapacityHubRow {
  hub: string;
  fte: number;
  windows: CapacityWindowFigure[];
}

export interface CapacityLabRow {
  region: string;
  chambers: number;
  windows: CapacityWindowFigure[];
}

export interface WeeklySeries {
  load: number[];
  capacity: number[];
}

export interface DesignerWindowFigure {
  key: string;
  /** Effort weeks booked in the window. */
  booked_weeks: number;
  /** Calendar weeks the designer is booked in the window (engine delta, 2026-11-04). */
  booked_span_weeks?: number | undefined;
  available_weeks: number;
  booked_pct: number | null;
  status: string;
}

export interface DesignerRow {
  ref: string;
  name: string;
  hub: string;
  fte: number;
  is_new: boolean;
  windows: DesignerWindowFigure[];
}

export interface ImportCapacity {
  windows: CapacityWindowDef[];
  hubs: CapacityHubRow[];
  lab_regions: CapacityLabRow[];
  weekly: {
    weeks: number[];
    hubs: Record<string, WeeklySeries>;
    lab_regions: Record<string, WeeklySeries>;
  };
  designers: DesignerRow[];
}

export interface ImportChange {
  ref: string;
  name: string;
  hub: string;
  before_finish_week: number | null;
  after_finish_week: number | null;
}

export interface ImportResultIssue {
  ref: string | null;
  severity: ImportSeverity;
  code: string;
  message: string;
}

export interface ImportSimulateResponse {
  base_year: number;
  current_week: number;
  plan_year_end_week: number;
  horizon_weeks: number;
  mode: ImportMode;
  kpis: ImportKpis;
  steps_meta: ImportStepMeta[];
  projects: ImportResultProject[];
  capacity: ImportCapacity;
  changes: {
    newly_slipping: ImportChange[];
    recovered: ImportChange[];
    moved: ImportChange[];
  };
  issues: ImportResultIssue[];
  workings: string[];
}
