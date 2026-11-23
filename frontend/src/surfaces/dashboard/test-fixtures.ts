import { PRIORITY_LABELS } from '@/types/enums';

import type {
  CompletingWithinYear,
  CompletingWithinYearRow,
  DeliveryRegionRow,
  PriorityDeliveryBand,
  ProjectFilterRow,
  ProjectRunOutcome,
} from './api/types';

/** P13 (API_CONTRACT_P13 §3): the register fields every `/dashboard/projects`
 *  row now carries, with neutral values, for test row builders. */
export const P13_ROW_DEFAULTS: Pick<
  ProjectFilterRow,
  | 'external_code'
  | 'type'
  | 'region'
  | 'leader_name'
  | 'leader_engineer_id'
  | 'current_step_code'
  | 'current_step_name'
  | 'end_week'
  | 'outcome'
  | 'reg_year'
  | 'carry_over'
  | 'priority_rank'
  | 'plant'
  | 'requesting_department'
  | 'product_type'
  | 'actual_start_week'
  | 'actual_end_week'
  | 'design_effort_weeks'
  | 'lab_effort_weeks'
  | 'design_weeks_calculated'
  | 'lab_weeks_calculated'
  | 'expected_status'
  | 'status_mismatch'
  | 'priority_label'
  | 'counts_toward_year'
  | 'not_scheduled_priority'
  | 'band_rank'
  | 'band_size'
  | 'hub_rank'
  | 'hub_band_size'
> = {
  external_code: null,
  type: null,
  region: 'Greece',
  leader_name: null,
  leader_engineer_id: null,
  current_step_code: null,
  current_step_name: null,
  end_week: null,
  outcome: null,
  reg_year: 2026,
  carry_over: false,
  priority_rank: null,
  plant: null,
  requesting_department: null,
  product_type: null,
  // P35-T01
  actual_start_week: null,
  actual_end_week: null,
  design_effort_weeks: null,
  lab_effort_weeks: null,
  design_weeks_calculated: 0,
  lab_weeks_calculated: 0,
  // P35-T08b
  expected_status: null,
  status_mismatch: false,
  // P42 (API_CONTRACT_P42 §8): no outcome row → null flags.
  priority_label: null,
  counts_toward_year: null,
  not_scheduled_priority: null,
  // P54 (ADR 0064 R1): not a band member.
  band_rank: null,
  band_size: null,
  // P60 (ADR 0068)
  hub_rank: null,
  hub_band_size: null,
};

/* ------------------------------------------------------------------------- */
/* P42 (API_CONTRACT_P42 §8): served-shape builders for test fixtures.        */
/* ------------------------------------------------------------------------- */

type P42RowKeys = 'outcome' | 'counts_toward_year' | 'not_scheduled_priority' | 'priority_label' | 'projected_end_week';

/**
 * A `CompletingWithinYearRow` as the backend serves it: the P42 fields filled
 * from the fixture's flags the way the SERVER buckets them (precedence
 * NOT_SCHEDULED_PRIORITY > QUEUED > BLOCKED > WITHIN_YEAR > SPILLOVER >
 * LEFT_OUT). Test-only: the app reads `outcome`, it never derives it.
 */
export function servedRow(
  r: Omit<CompletingWithinYearRow, P42RowKeys> & Partial<Pick<CompletingWithinYearRow, P42RowKeys>>,
): CompletingWithinYearRow {
  const counts = r.counts_toward_year ?? true;
  const nsp = r.not_scheduled_priority ?? false;
  const outcome: ProjectRunOutcome | null = nsp
    ? 'NOT_SCHEDULED_PRIORITY'
    : !counts
      ? 'QUEUED'
      : r.blocked
        ? 'BLOCKED'
        : r.within_year
          ? 'WITHIN_YEAR'
          : r.spillover
            ? 'SPILLOVER'
            : r.left_out
              ? 'LEFT_OUT'
              : null;
  return {
    ...r,
    counts_toward_year: counts,
    not_scheduled_priority: nsp,
    outcome: r.outcome !== undefined ? r.outcome : outcome,
    priority_label: r.priority_label !== undefined ? r.priority_label : r.priority ? PRIORITY_LABELS[r.priority] : null,
    projected_end_week: r.projected_end_week !== undefined ? r.projected_end_week : r.last_step_end_week,
  };
}

type P42TotalsKeys =
  | 'queued_count'
  | 'not_scheduled_priority_count'
  | 'excluded_count'
  | 'counting_outcome_count'
  | 'within_year_share_pct';

/** A served `DeliveryRegionRow` (P42 counts default 0). */
export function servedRegion(
  r: Omit<DeliveryRegionRow, 'queued_count' | 'not_scheduled_priority_count'> &
    Partial<Pick<DeliveryRegionRow, 'queued_count' | 'not_scheduled_priority_count'>>,
): DeliveryRegionRow {
  return { queued_count: 0, not_scheduled_priority_count: 0, ...r };
}

/** A served `PriorityDeliveryBand`: the P42 fields default to "everything counts". */
export function servedBand(
  b: Omit<
    PriorityDeliveryBand,
    | 'priority_label'
    | 'queued_total'
    | 'not_scheduled_priority_total'
    | 'counting_total'
    | 'in_flight_counting_total'
    | 'not_started_counting_total'
  > &
    Partial<PriorityDeliveryBand>,
): PriorityDeliveryBand {
  return {
    priority_label: PRIORITY_LABELS[b.priority],
    queued_total: 0,
    not_scheduled_priority_total: 0,
    counting_total: b.total,
    in_flight_counting_total: b.in_flight_total,
    not_started_counting_total: b.not_started_total,
    ...b,
  };
}

/**
 * A served `CompletingWithinYear`: the P42 totals as the server computes them
 * from the four counting buckets (`counting_outcome_count` = their sum,
 * `within_year_share_pct` to 2 dp), unless the fixture sets them. Rows,
 * regions and bands go through the builders above.
 */
export function servedCompleting(
  d: Omit<CompletingWithinYear, P42TotalsKeys | 'rows' | 'regions' | 'priority_delivery'> &
    Partial<Pick<CompletingWithinYear, P42TotalsKeys>> & {
      rows: Parameters<typeof servedRow>[0][];
      regions: Parameters<typeof servedRegion>[0][];
      priority_delivery: Parameters<typeof servedBand>[0][];
    },
): CompletingWithinYear {
  const counting = d.counting_outcome_count ?? d.within_year_count + d.spillover_count + d.left_out_count + d.blocked_count;
  return {
    queued_count: 0,
    not_scheduled_priority_count: 0,
    excluded_count: 0,
    ...d,
    rows: d.rows.map((r) => servedRow(r)),
    regions: d.regions.map((r) => servedRegion(r)),
    priority_delivery: d.priority_delivery.map((b) => servedBand(b)),
    counting_outcome_count: counting,
    within_year_share_pct:
      d.within_year_share_pct ?? (counting === 0 ? 0 : Math.round((d.within_year_count / counting) * 10000) / 100),
  };
}
