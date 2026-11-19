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
  ScheduleOutcome,
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
  /** Remainder (every status without a card; served keys only) so five cards + other == total_count. */
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
  /** P17-R03: the project's status (wire value). */
  status: ProjectStatus;
  /** P17-R03: In Queue AND no stage has progress (server-derived). */
  not_started: boolean;
  /** P42 (API_CONTRACT_P42 §8): the stored flag (R42-4); false for a queued
   *  P3 and a P4 / Q in a schedulable status. */
  counts_toward_year: boolean;
  /** P42: a non-frozen P4 / Q, never planned (R42-3). */
  not_scheduled_priority: boolean;
  /** P42: the row's served exclusive bucket — the top-level counts partition
   *  by it. null = in no bucket (On Hold / Cancelled / Draft / data error). */
  outcome: ProjectRunOutcome | null;
  /** P42 (R42-1): the band label; null with no band. */
  priority_label: string | null;
  /** P42: the stored projected finish week (for the queued copy). */
  projected_end_week: WeekNumber | null;
}

/** P17-R03: one priority band of "Delivery by priority", counted server-side
 *  (I19). total == in_flight_total + not_started_total + delivered_total +
 *  other_total; within_year == the three *_within_year parts. Shares are
 *  2 dp percentages, 0.0 on a zero denominator. */
export interface PriorityDeliveryBand {
  priority: ProjectPriority;
  total: number;
  within_year: number;
  in_flight_total: number;
  in_flight_within_year: number;
  not_started_total: number;
  not_started_within_year: number;
  delivered_total: number;
  delivered_within_year: number;
  other_total: number;
  within_year_share_pct: number;
  in_flight_within_year_share_pct: number;
  not_started_within_year_share_pct: number;
  in_flight_share_pct: number;
  not_started_share_pct: number;
  delivered_share_pct: number;
  other_share_pct: number;
  /** P42 (API_CONTRACT_P42 §8): the band label. */
  priority_label: string;
  /** P42: projects of the band whose active-run bucket is QUEUED. */
  queued_total: number;
  /** P42: … NOT_SCHEDULED_PRIORITY. */
  not_scheduled_priority_total: number;
  /** P42: `total − queued_total − not_scheduled_priority_total`; the
   *  denominator of `within_year_share_pct` (meaning change, I53). */
  counting_total: number;
  /** P42: counting projects of `in_flight_total`. */
  in_flight_counting_total: number;
  /** P42: counting projects of `not_started_total`. */
  not_started_counting_total: number;
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
  /** P42 (API_CONTRACT_P42 §8): rows in bucket QUEUED (a P3 in queue). */
  queued_count: number;
  /** P42: rows in bucket NOT_SCHEDULED_PRIORITY (a P4 / Q, never planned). */
  not_scheduled_priority_count: number;
  /** P42: rows in no bucket (On Hold / Cancelled / Draft / data error). */
  excluded_count: number;
  /** P42 (I53): within + spillover + left out + blocked — THE denominator of
   *  every within-year share. Served; the browser never sums it. */
  counting_outcome_count: number;
  /** P42: `within_year_count / counting_outcome_count × 100`, 2 dp, 0 on 0. */
  within_year_share_pct: number;
  /** P17-R03: always P1, P2, P3, P4, Q in that order. */
  priority_delivery: PriorityDeliveryBand[];
  /** Owner ask 2026-11-16: the four outcome counts per country. Always three
   *  rows ordered Greece, India, Romania (zero rows included); OEM hubs are
   *  counted in Greece (ADR 0025). For each bucket the rows sum to the
   *  top-level count. Served, never recounted from `rows` (I9). */
  regions: DeliveryRegionRow[];
  rows: CompletingWithinYearRow[];
}

/** One country row of `CompletingWithinYear.regions` (owner ask 2026-11-16). */
export interface DeliveryRegionRow {
  region: LabRegion;
  within_year_count: number;
  spillover_count: number;
  left_out_count: number;
  blocked_count: number;
  /** P42: the region's QUEUED / NOT_SCHEDULED_PRIORITY rows. */
  queued_count: number;
  not_scheduled_priority_count: number;
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
  /** ADR 0035: the client workbook's charter fields, as written (read-only). */
  plant: string | null;
  requesting_department: string | null;
  product_type: string | null;
  /** Rank by score within the filtered set, 1-based; null when unscored. */
  priority_rank: number | null;
  /** P54 (ADR 0064 R1): read-only position in the FULL priority band (all
   *  hubs), the Priority board's `band_rank`; null when not a band member
   *  (shown "—"). Always served on `/dashboard/projects`. */
  band_rank: number | null;
  /** P54: the number of ranked projects in that band; null with no rank. */
  band_size: number | null;
  // P35-T01: the register's editable fields (Projects page Edit mode, P35-T02).
  actual_start_week: WeekNumber | null;
  actual_end_week: WeekNumber | null;
  /** The client's typed design / lab time figures (ADR 0041), 2 dp; null = none. */
  design_effort_weeks: number | null;
  lab_effort_weeks: number | null;
  /** D35-1: Σ effective weeks of the kind with the project's own figure
   *  ignored — what "↺ reset" returns to. Served; never summed in the browser. */
  design_weeks_calculated: number;
  lab_weeks_calculated: number;
  // P35-T08b (OQ #84 assumption): display warning only, never a scheduler input.
  /** The status the current step implies (served by the backend); null for
   *  On Hold / Cancelled / In Buyoff / Draft, or an unmapped step. */
  expected_status: ProjectStatus | null;
  /** Served: `status` differs from `expected_status`. */
  status_mismatch: boolean;
  /** P42 (API_CONTRACT_P42 §8): the band label; null with no band. */
  priority_label: string | null;
  /** P42: the stored flags; null with no outcome row in the active run. */
  counts_toward_year: boolean | null;
  not_scheduled_priority: boolean | null;
}

/** The active run's outcome for a project (P13 contract §3); P42 adds
 *  QUEUED and NOT_SCHEDULED_PRIORITY (API_CONTRACT_P42 §0). */
export type ProjectRunOutcome = ScheduleOutcome;

export interface ProjectFilterResult {
  total_count: number;
  rows: ProjectFilterRow[];
}

export interface ProjectFilterParams {
  /** Multi-select contract (2026-11-13): every list is a REPEATED param, ORed
   *  within, ANDed across; omitted or empty = not filtered. `hub_id` and
   *  `region` are UNIONED by the server. */
  hub_id?: readonly Id[] | undefined;
  /** P31: repeated `category` params, ORed by the server; omitted = all.
   *  `Unmapped` = no category (Dashboard endpoints only). */
  category?: readonly (ProjectCategory | 'Unmapped')[] | undefined;
  status_?: readonly ProjectStatus[] | undefined;
  priority?: readonly ProjectPriority[] | undefined;
  // P13 (API_CONTRACT_P13 §3) — every filter is applied server-side.
  region?: readonly LabRegion[] | undefined;
  /** Case-insensitive substring of name or external_code, ≤ 100 chars. */
  q?: string | undefined;
  /** P31: repeated `type` params, ORed. `Unmapped` = projects with no type
   *  (`type IS NULL`), served since P17-R09. Omitted = all. */
  type?: readonly (ProjectType | 'Unmapped')[] | undefined;
  leader_engineer_id?: readonly Id[] | undefined;
  /** Step codes, e.g. `PDD-E`. */
  current_step?: readonly string[] | undefined;
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
  /** P42: `pipeline_count` minus the cell's queued and not-scheduled projects. */
  counting_count: number;
  /** completing / counting × 100, 2 dp, server-side (P42 meaning change). */
  completing_pct: number;
}

/** One served per-type pipeline-vs-completing row (the cross-tab's Total row). */
export interface CompletingByTypeRow {
  key: AnalyticsTypeKey;
  pipeline_count: number;
  completing_count: number;
  /** P42: see `CompletingHubTypeCell.counting_count`. */
  counting_count: number;
  completing_pct: number;
}

/** The cross-tab's per-hub Total column (served sum of that hub's cells). */
export interface CompletingByHubRow {
  key: HubName;
  pipeline_count: number;
  completing_count: number;
  /** P42: see `CompletingHubTypeCell.counting_count`. */
  counting_count: number;
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
