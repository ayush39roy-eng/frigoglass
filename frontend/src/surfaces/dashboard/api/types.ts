// PLACEHOLDER — mirror of backend/schemas/dashboard.py + the ScheduleRunSummary
// slice of backend/schemas/schedule_run.py. Hand-authored because P3's OpenAPI
// schema is not generated into this repo yet (see src/types/README.md and the
// P4-T01 docs/MEMORY.md carry-forward note). P3-T07's contract test must catch
// drift between these shapes and the real schema.

import type {
  ProjectCategory,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
  HubName,
  LabRegion,
  SolverType,
  ScheduleRunStatus,
} from '@/types/enums';
import type { TrackingStatus } from '@/components/shared/tracking-status-meta';
import type { Id, WeekNumber } from '@/types/common';

/** GET /dashboard/pipeline-totals — portfolio *composition* (carry_over vs new),
 *  NOT the scheduling SPILLOVER flag. See the backend PipelineTotals docstring. */
export interface PipelineTotals {
  spillover_count: number;
  new_count: number;
  /** Not carry_over and no registration year (ADR 0030). */
  unregistered_count: number;
  /** Every project, Commercialized included; = spillover + new + unregistered. */
  total_count: number;
  /** Server-computed count / total_count x 100, 2 dp, 0 on a zero total (I19). */
  spillover_share_pct: number;
  new_share_pct: number;
  unregistered_share_pct: number;
}

/** GET /dashboard/status-overview */
export interface StatusOverview {
  in_buyoff: number;
  under_industrialization: number;
  in_development: number;
  in_queue: number;
  other_counts: Record<string, number>;
  /** P17 (ADR 0030): the two new card counts; every figure below is served, never derived here (I19). */
  commercialized_count: number;
  /** PROJECT status On Hold (ADR 0017) - not the stage-level On Hold outcome. */
  on_hold_count: number;
  /** Every project in scope/filter; equals PipelineTotals.total_count. */
  total_count: number;
  /** Card share of total, 2 dp; also the progress-bar width. */
  in_development_share_pct: number;
  under_industrialization_share_pct: number;
  in_queue_share_pct: number;
  commercialized_share_pct: number;
  on_hold_share_pct: number;
  /** Remainder (In Buyoff + Draft + Cancelled) so five cards + other == total_count. */
  other_statuses_count: number;
  other_statuses_counts: Record<string, number>;
  other_statuses_share_pct: number;
}

/** GET /dashboard/hub-type-pipeline — one row per (hub, type) with a project count. */
export interface HubTypePipelineRow {
  hub: HubName;
  type: ProjectType | null;
  count: number;
}

/** One project's outcome in the active schedule run (I9 source rows). */
export interface CompletingWithinYearRow {
  project_id: Id;
  project_name: string;
  hub: HubName;
  category: ProjectCategory | null;
  priority: ProjectPriority | null;
  within_year: boolean;
  spillover: boolean;
  left_out: boolean;
  /** P9-F02: `ScheduleRunProjectOutcome.blocked` — a Blocked stage held the
   *  project at its frontier. Surfaced here so a row's `blocked_count`
   *  membership is visible on the row itself, not just in the aggregate. */
  blocked: boolean;
  cat_not_allowed: boolean;
  last_step_end_week: WeekNumber | null;
  /** P13-T10 (API_CONTRACT_P13 §5): the project's type; null if unmapped. */
  type: ProjectType | null;
}

/** GET /dashboard/completing-within-year — the Invariant I9 endpoint. Every
 *  headline count on the Dashboard traces to a field on THIS response. */
export interface CompletingWithinYear {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  within_year_count: number;
  spillover_count: number;
  left_out_count: number;
  /** P9-F02: a project whose outcome has `blocked=true` is counted here,
   *  exclusively — never also in `within_year_count`/`spillover_count`/
   *  `left_out_count`, even if one of those raw outcome flags happens to
   *  also be set on the same row. Blocked wins outright so the four counts
   *  partition the schedulable, non-excluded portfolio without overlap. */
  blocked_count: number;
  rows: CompletingWithinYearRow[];
}

/** One row of GET /dashboard/projects (the "analytics breakdown with filters"). */
export interface ProjectFilterRow {
  project_id: Id;
  project_name: string;
  hub: HubName;
  category: ProjectCategory | null;
  status: ProjectStatus;
  priority: ProjectPriority | null;
  // P12 contract §5: `/dashboard/projects` rows extended for the Projects cards (schemas/dashboard.py).
  /** Pinned as VIP (ADR 0022). */
  is_vip: boolean;
  /** Served tracking status (ADR 0021 §4). */
  tracking_status: TrackingStatus;
  // P13 (API_CONTRACT_P13 §3): register fields, always sent. No financial fields.
  external_code: string | null;
  type: ProjectType | null;
  /** The hub's served `lab_region` (the country, ADR 0025). */
  region: LabRegion;
  /** GDPR (OQ #8): null unless the leader is the caller — never resolved client-side. */
  leader_name: string | null;
  leader_engineer_id: Id | null;
  /** First workflow step not Completed/Skipped; null when all are done. */
  current_step_code: string | null;
  current_step_name: string | null;
  /** Active schedule run finish week; null if no run or not scheduled. */
  end_week: WeekNumber | null;
  outcome: ProjectRunOutcome | null;
  reg_year: number | null;
  carry_over: boolean;
  /** Rank by score within the filtered set, 1-based; null when unscored. */
  priority_rank: number | null;
}

/** The active run's outcome for a project (P13 contract §3). */
export type ProjectRunOutcome = 'WITHIN_YEAR' | 'SPILLOVER' | 'LEFT_OUT' | 'BLOCKED';

export interface ProjectFilterResult {
  total_count: number;
  rows: ProjectFilterRow[];
}

export interface ProjectFilterParams {
  hub_id?: Id | undefined;
  category?: ProjectCategory | undefined;
  status_?: ProjectStatus | undefined;
  priority?: ProjectPriority | undefined;
  // P13 (API_CONTRACT_P13 §3) — every filter is applied server-side.
  region?: LabRegion | undefined;
  /** Case-insensitive substring of name or external_code, ≤ 100 chars. */
  q?: string | undefined;
  type?: ProjectType | undefined;
  leader_engineer_id?: Id | undefined;
  /** Step code, e.g. `PDD-E`. */
  current_step?: string | undefined;
  sort?: 'name' | 'priority' | undefined;
}

/** GET /dashboard/projects/facets — leaders and current steps present in the
 *  caller's scoped, hub/country-filtered set (API_CONTRACT_P13 §3). */
export interface ProjectFacets {
  /** GDPR (OQ #8): `name` is null unless the leader is the caller. */
  leaders: { id: Id; name: string | null }[];
  steps: { code: string; name: string }[];
}

/** One country row of GET /dashboard/region-summary (API_CONTRACT_P13 §2).
 *  Every count and share is served; the browser never sums rows. */
export interface RegionSummaryRow {
  region: LabRegion;
  total_count: number;
  /** Of the response's `total_count`, 2 dp. */
  share_pct: number;
  spillover_count: number;
  newly_registered_count: number;
  /** Not carry_over and no registration year (ADR 0030). */
  unregistered_count: number;
  /** This region's count over the portfolio's count for the same bucket, 2 dp
   *  (server-side; the three regions of one card sum to about 100). */
  spillover_share_pct: number;
  newly_registered_share_pct: number;
  unregistered_share_pct: number;
  /** Every ProjectStatus wire value, 0 if none. All counts here cover every
   *  project, Commercialized included (ADR 0030): `total_count` =
   *  spillover + newly registered + unregistered = sum of `status_counts`. */
  status_counts: Partial<Record<ProjectStatus, number>>;
  /** Share of that status's portfolio count held by this region. */
  status_share_pct: Partial<Record<ProjectStatus, number>>;
}

export interface RegionSummary {
  total_count: number;
  /** Always Greece, India, Romania in that order (zero rows included). */
  regions: RegionSummaryRow[];
}

/** A `GET /dashboard/analytics` bucket key for project type: every
 *  `ProjectType`, plus `Unmapped` when some project has no type. */
export type AnalyticsTypeKey = ProjectType | 'Unmapped';

/** One served bucket (count + share of the pipeline-totals basis, 2 dp).
 *  Keys may be the sentinels "Unmapped" (type) / "Unknown" (reg year). */
export interface AnalyticsBucket<K extends string = string> {
  key: K;
  count: number;
  share_pct: number;
}

/** One served Hub × Type cell of the completing-within-year cross-tab. */
export interface CompletingHubTypeCell {
  hub: HubName;
  /** null for untyped projects (shown under "Unmapped"). */
  type: ProjectType | null;
  pipeline_count: number;
  completing_count: number;
  /** completing / pipeline × 100, 2 dp, server-side. */
  completing_pct: number;
}

/** One served per-type pipeline-vs-completing row (the cross-tab's Total row). */
export interface CompletingByTypeRow {
  key: AnalyticsTypeKey;
  pipeline_count: number;
  completing_count: number;
  completing_pct: number;
}

/** The cross-tab's per-hub Total column (served sum of that hub's cells). */
export interface CompletingByHubRow {
  key: HubName;
  pipeline_count: number;
  completing_count: number;
  completing_pct: number;
}

/** GET /dashboard/analytics (API_CONTRACT_P13 §5, P13-T10). Pipeline-totals
 *  basis; "completing" = the active run's WITHIN_YEAR outcome. Every figure is
 *  served — the browser only lays them out (I9). */
export interface DashboardAnalytics {
  by_type: AnalyticsBucket<AnalyticsTypeKey>[];
  /** Category key; the contract does not name a bucket for a null category. */
  by_category: AnalyticsBucket[];
  by_hub: AnalyticsBucket[];
  /** Year as a string, plus `Unknown` for a null `reg_year`. */
  by_reg_year: AnalyticsBucket[];
  /** Empty without an active schedule run. */
  completing_hub_type: CompletingHubTypeCell[];
  /** Empty without an active schedule run. */
  completing_by_type: CompletingByTypeRow[];
  /** Hubs with pipeline > 0, by hub. Empty without an active schedule run. */
  completing_by_hub: CompletingByHubRow[];
  has_active_schedule_run: boolean;
}

/** GET /schedule-runs/active — used only to enrich the provenance caption
 *  (solver type, when it was computed). The headline numbers do NOT come from
 *  here; they come from CompletingWithinYear. 404 when nothing has been run. */
export interface ScheduleRunSummary {
  id: Id;
  version: number;
  solver_type: SolverType;
  status: ScheduleRunStatus;
  is_active: boolean;
  horizon_weeks: number;
  current_week: number;
  trigger_reason: string | null;
  /** P9-R02 (ruling 6): the solver's verdict, "OPTIMAL" / "FEASIBLE" for CP-SAT;
   *  null for greedy runs and older runs. Always present in the payload. */
  solver_status: string | null;
  created_at: string;
}
