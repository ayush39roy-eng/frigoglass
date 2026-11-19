import type { LeftOutReason } from '@/lib/left-out-reason';

/**
 * P53 (ADR 0063, R53-3; API_CONTRACT_P53 §4.1): the delivery-by-year table,
 * served from the one server function over a run's (or simulation's) stored
 * outcomes, after hub scoping. The browser derives NOTHING from it (I59): every
 * figure on the panel is one of these fields.
 */
export type DeliveryRowKind = 'by_end_of_year' | 'year' | 'not_placed' | 'blocked';

export type LeftOutReasonCounts = Record<LeftOutReason, number>;

export interface DeliveryByYearRow {
  kind: DeliveryRowKind;
  /** null on `not_placed` / `blocked`. */
  year: number | null;
  /** Server label: "By end of 2026", "2027", "Not placed within 5 years", "Blocked". */
  label: string;
  /** `year > Y0 + 1`: shown as "indicative". */
  indicative: boolean;
  p1: number;
  p2: number;
  p3: number;
  /** A counting project with another band (a Commercialized project delivered
   *  in Y0 whose band is P4 / Q / none): `p1 + p2 + p3 + other = total`.
   *  Optional for an older payload. */
  other?: number;
  total: number;
  /** Cumulative columns; null on `not_placed` / `blocked`. */
  cum_p1: number | null;
  cum_p2: number | null;
  cum_p3: number | null;
  cum_other?: number | null;
  cum_total: number | null;
  /** On `not_placed` only: the reason split. */
  left_out_reasons: LeftOutReasonCounts | null;
}

export interface DeliveryByYear {
  /** The run's (or simulation's) input week. */
  run_week: number;
  /** Y0 = year_of(run_week). */
  base_year: number;
  /** year_end(Y0) (live / What-if) or u (import). */
  within_year_week: number;
  horizon_weeks: number;
  /** N; null when not derivable (import with N changed since). */
  horizon_years: number | null;
  rows: DeliveryByYearRow[];
}

/** Why a delivery table is not served. */
export type DeliveryUnavailable = 'pre_p53_run' | 'no_active_run';

/** R53-9: the Dashboard / Executive aggregate (counts only, never names). */
export interface TailWarnings {
  far_finish_count: number;
  leader_overloaded_count: number;
}

/** `GET /dashboard/delivery-by-year/projects` (drill-in). */
export type DeliveryBand = 'P1' | 'P2' | 'P3';

export interface DeliveryDrillRow {
  project_id: string;
  project_name: string;
  hub: string;
  /** The band in the run input; null / another band for an "Other" row. */
  band: string | null;
  completion_week: number | null;
  delivery_year: number | null;
  far_finish: boolean;
  left_out_reason: LeftOutReason | null;
}

export interface DeliveryDrillResponse {
  schedule_run_version: number | null;
  kind: DeliveryRowKind;
  year: number | null;
  band: DeliveryBand | null;
  rows: DeliveryDrillRow[];
  delivery_by_year_unavailable?: DeliveryUnavailable | null;
}

/** P53 (API_CONTRACT_P53 §3): fields every `ScheduleRunSummary` gains. Optional
 *  so pre-P53 fixtures type-check; the server always sends them. */
export interface ScheduleRunP53Fields {
  rules_epoch?: 'p53' | null;
  within_year_week?: number;
  pre_p53?: boolean;
  /** "Computed under the earlier rules (78-week search; queued P3 not counted)"
   *  on pre-P53 runs, else null. Shown wherever the run is shown. */
  rules_label?: string | null;
}
