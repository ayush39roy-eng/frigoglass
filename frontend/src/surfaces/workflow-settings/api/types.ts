// PLACEHOLDER (P9 contract §3) — hand-authored mirror of `GET /workflow-settings`
// and its four `PUT`s (ADRs 0007 / 0008 / 0009). Built concurrently with the
// backend (P9-T03); reconciled against the regenerated OpenAPI in the P9 gate
// (P3-T07 contract test). Same convention as every per-surface `api/types.ts`.

import type { Category } from '@/lib/category-catalog';
import type { RecalcStatus } from '@/lib/api/priority-move';
import type {
  HubName,
  LabRegion,
  ProjectCategory,
  ProjectStatus,
  WorkflowId,
  WorkflowStepKind,
  WorkflowStepStatus,
} from '@/types/enums';
import type { Id } from '@/types/common';

export interface WorkflowStepSetting {
  step_id: string;
  code: string;
  name: string;
  kind: WorkflowStepKind;
  /** Display / walk order — NOT a dependency (ADR 0009). */
  sequence_order: number;
  /** Steps of the same workflow this step starts after. Empty only on the first. */
  predecessor_ids: string[];
}

export interface WorkflowSetting {
  id: WorkflowId;
  name: string;
  steps: WorkflowStepSetting[];
}

/** One category-template row (`docs/CLIENT_FORMULAS.md` §1). `weeks` may be 0 = skipped.
 *  Read-only on the wire since P33: edits go through the apply (contract E). */
export interface LeadTimeSetting {
  workflow_id: WorkflowId;
  category: ProjectCategory;
  step_id: string;
  /** The category length, 0..104. */
  weeks: number;
  /** P33 C1: the signed template gap, −104..104 (negative = overlap, positive = wait). */
  gap_weeks: number;
  /** P33 C1: the immutable R2 split weight — read-only, never sent. */
  effort_weight_weeks: number;
}

export interface HubCalendarSetting {
  hub_id: Id;
  hub: HubName;
  weekdays_per_week: number;
  national_holiday_days: number;
  medical_leave_days: number;
  casual_leave_days: number;
  annual_leave_days: number;
  weeks_in_year: number;
  /** Derived server-side (ADR 0008) — read-only here. */
  working_weeks_per_engineer: number;
}

export interface ChamberSetting {
  chamber_id: Id;
  code: string;
  lab_region: LabRegion;
  platforms: number;
  efficiency: number;
  maintenance_weeks: number;
  breakdown_weeks: number;
  calibration_weeks: number;
  /** Derived server-side (ADR 0008) — read-only here. */
  working_weeks_per_chamber: number;
  /** Derived server-side (ADR 0008) — read-only here. */
  efficient_lab_weeks: number;
}

/** `GET /workflow-settings` — also the body every successful `PUT` returns. */
/** P33 C1: one `GET /workflow-settings` `categories` entry — the B1 object plus
 *  the category template's optimistic-lock version (ADR 0045 §6). */
export interface WorkflowSettingsCategory extends Category {
  template_version: number;
}

export interface WorkflowSettings {
  workflows: WorkflowSetting[];
  lead_times: LeadTimeSetting[];
  /** P33 C1: every category in rank order (the B1 list with `template_version`). */
  categories: WorkflowSettingsCategory[];
  hub_calendars: HubCalendarSetting[];
  chambers: ChamberSetting[];
  current_week: number;
  horizon_weeks: number;
  within_year_week: number;
  updated_at: string;
  updated_by: string | null;
}

/** `PUT /workflow-settings/steps/{workflow_id}` — all 14 steps. */
export interface StepsUpdateRequest {
  steps: { step_id: string; kind: WorkflowStepKind; predecessor_ids: string[] }[];
}

/** `PUT /workflow-settings/hub-calendars/{hub_id}` — the five editable fields. */
export interface HubCalendarUpdateRequest {
  weekdays_per_week: number;
  national_holiday_days: number;
  medical_leave_days: number;
  casual_leave_days: number;
  annual_leave_days: number;
}

/** `PUT /workflow-settings/chambers/{chamber_id}` — any subset. */
export interface ChamberSettingUpdateRequest {
  platforms?: number;
  efficiency?: number;
  maintenance_weeks?: number;
  breakdown_weeks?: number;
  calibration_weeks?: number;
}

/** A successful PUT: the full `GET` payload plus the `X-Schedule-Stale-Count` header. */
export interface WorkflowSettingsSaveResult {
  settings: WorkflowSettings;
  /** Projects now marked `schedule_stale` — from the response header, verbatim. */
  staleCount: number;
}

/** The 422 codes the steps endpoint can return (`{code, detail}` envelope). */
export const STEP_VALIDATION_CODES = ['CYCLE', 'SELF_REFERENCE', 'BAD_PREDECESSOR', 'EMPTY_PREDECESSORS'] as const;

// --- P13-T16 (API_CONTRACT_P13 §5): served previews. Every figure is computed
// server-side from the lead-time table and the precedence DAG (earliest start,
// no capacity, no per-project overrides); the browser only draws them.

/** One step of a category's preview timeline. */
export interface TimelineStep {
  /** Step id, e.g. `PDD-E` (the contract's step "code"). */
  code: string;
  name: string;
  resource_kind: WorkflowStepKind;
  /** Earliest start week from the DAG walk, 0-based (week 0 = project start). */
  start_week: number;
  /** 0 = skipped for this category. */
  duration_weeks: number;
  /** P33 C2: the template's signed gap (requested): < 0 overlap, > 0 wait. */
  gap_weeks: number;
  /** P33 C2: the gap the walk produced (`start_week − release`; 0 on a skipped step). */
  effective_gap_weeks: number;
  /** P33 C2: notes the server raises for this step. */
  flags: TemplateFlag[];
  /** P33 C2: the DAG in force. Empty only on a workflow's first step. */
  predecessor_ids: string[];
}

/** P33 C2 / F3 step flags (`scheduling.template_timeline`). */
export type TemplateFlag = 'same_leader_serialised' | 'anchor_clamped' | 'gap_ignored_zero_length';

/** `GET /workflow-settings/category-timelines?workflow=` — one per category. */
export interface CategoryTimeline {
  category: ProjectCategory;
  /** P33 C2: the served label, workflow, rank and template version. */
  label: string;
  workflow_id: WorkflowId;
  rank: number;
  template_version: number;
  /** P33 C2: always shown with a template timeline (DOMAIN_RULES §D). */
  note: string;
  total_weeks: number;
  design_weeks: number;
  lab_weeks: number;
  steps: TimelineStep[];
}

// --- P33 (API_CONTRACT_P33 Parts B2, D, E; ADR 0045–0047). Every week and count
// below is computed server-side; the browser only sends edits and draws replies.

/** One overridden step: its length and / or signed gap (contract D / E1). */
export interface TemplateStepOverride {
  step_id: string;
  weeks?: number | null;
  gap_weeks?: number | null;
}

/** `POST /workflow-templates/timeline-preview` (contract D). */
export interface TimelinePreviewRequest {
  workflow_id: WorkflowId;
  category: ProjectCategory;
  steps: TemplateStepOverride[];
}

/** One C2 category object computed with the overrides, plus the changed step ids. */
export interface TimelinePreviewResponse extends CategoryTimeline {
  changed_step_ids: string[];
}

/** One (workflow, category) of a change set (contract E1). */
export interface TemplateChangeEntry {
  workflow_id: WorkflowId;
  category: ProjectCategory;
  /** The `template_version` the editor read (409 `TEMPLATE_CHANGED` otherwise). */
  base_version: number;
  steps: TemplateStepOverride[];
}

/** `POST /workflow-templates/apply-preview` body (contract E1 / E2). */
export interface TemplateChangeSet {
  changes: TemplateChangeEntry[];
}

export type ApplySelectionMode = 'all_not_reached' | 'selected' | 'none';

/** Which choosable projects receive the change (contract E3). */
export interface ApplySelection {
  mode: ApplySelectionMode;
  project_ids: string[];
}

/** `POST /workflow-templates/apply` body (contract E3). */
export interface TemplateApplyRequest extends TemplateChangeSet {
  selection: ApplySelection;
  reason?: string | null;
}

/** R33-11 step flags on an apply preview row. */
export type ApplyStepFlag =
  | 'revived'
  | 'skipped_now'
  | 'gap_ignored_skipped'
  | 'cert_off_no_effect'
  | 'own_effort_length_not_applied';

/** One changed step of one project: served `eff` and gap, before and after. */
export interface ApplyPreviewStep {
  step_id: string;
  eff_before: number;
  eff_after: number;
  gap_before: number;
  gap_after: number;
  flags: ApplyStepFlag[];
}

/** A project in the `automatic` list. */
export interface ApplyPreviewProject {
  project_id: string;
  name: string;
  hub: HubName;
  status: ProjectStatus;
  steps: ApplyPreviewStep[];
}

export interface CurrentStage {
  step_id: string;
  name: string;
  status: WorkflowStepStatus;
}

/** A project in the `choosable` list (started, but not at the changed steps). */
export interface ApplyPreviewChoosableProject extends ApplyPreviewProject {
  current_stage: CurrentStage | null;
}

/** A project whose only changes are lengths of a kind it has its own effort figure for. */
export interface ApplyPreviewOwnEffortProject {
  project_id: string;
  name: string;
  hub: HubName;
  status: ProjectStatus;
  step_ids: string[];
  kinds: ('design' | 'lab')[];
  reason: 'own_effort_length_not_applied';
}

export type ApplyNeverReason = 'frozen' | 'cancelled' | 'commercialized' | 'reached_stage';

/** A project (or some of its changed steps) that never receives the change. */
export interface ApplyPreviewNeverProject {
  project_id: string;
  name: string;
  hub: HubName;
  reason: ApplyNeverReason;
  step_ids: string[];
}

export interface ApplyPreviewCategory {
  workflow_id: WorkflowId;
  category: ProjectCategory;
  timeline: CategoryTimeline;
}

export interface ApplyPreviewCounts {
  automatic: number;
  choosable: number;
  own_effort: number;
  never: number;
}

/** `POST /workflow-templates/apply-preview` (contract E2). No writes. */
export interface ApplyPreviewResponse {
  categories: ApplyPreviewCategory[];
  counts: ApplyPreviewCounts;
  automatic: ApplyPreviewProject[];
  choosable: ApplyPreviewChoosableProject[];
  own_effort: ApplyPreviewOwnEffortProject[];
  never: ApplyPreviewNeverProject[];
}

export interface TemplateVersion {
  workflow_id: WorkflowId;
  category: ProjectCategory;
  template_version: number;
}

export interface AppliedCounts {
  automatic: number;
  selected: number;
  own_effort_not_applied: number;
}

export interface NotApplied {
  project_id: string;
  reason: 'reached_stage' | 'not_choosable';
}

/** `POST /workflow-templates/apply` (contract E3). */
export interface TemplateApplyResponse {
  template_change_id: string;
  versions: TemplateVersion[];
  applied: AppliedCounts;
  not_applied: NotApplied[];
  recalc_status: RecalcStatus;
  schedule_run_id: string | null;
  task_id: string | null;
}

/** `POST /workflow-templates/categories` (contract B2). */
export interface CategoryCreateRequest {
  code: string;
  label?: string | null;
  workflow_id: WorkflowId;
  copy_from: ProjectCategory;
  /** An existing code (any workflow), or null for first place. */
  insert_after: ProjectCategory | null;
}

/** 201 body of `POST /workflow-templates/categories`. */
export interface CategoryCreateResponse {
  category: Category;
  /** The full list in rank order, after the insert. */
  categories: Category[];
  template_rows: number;
  engineers_extended: number;
}

/** `GET /workflow-settings/b-equivalent?workflow=` — one row per category.
 *  Ratios are relative to B (PDD) or B-OEM (OEM), 2 dp; null when the
 *  reference column is 0 weeks (rendered "—"). */
export interface BEquivalentRow {
  category: ProjectCategory;
  design_weeks: number;
  lab_weeks: number;
  design_ratio: number | null;
  lab_ratio: number | null;
}
