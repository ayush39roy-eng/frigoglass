/**
 * Horizon constants from `docs/DOMAIN_RULES.md` ("Horizon constants"). The
 * server's internal 78-week search horizon is deliberately NOT exported here —
 * the UI presents a 52-week year only (see `DISPLAY_HORIZON_WEEKS`).
 *
 * These are the DOMAIN_RULES contract, mirrored verbatim from the backend
 * (`backend/scheduling/domain_constants.py` / `backend/models` week fields) — they
 * are NOT derived and must never be recomputed. A frontend surface may draw a
 * fixed marker line at `WITHIN_YEAR_WEEK` (that is a constant, not a calculation),
 * but any per-project "completing within year" / spillover verdict is the server's
 * flag, never a client comparison (Invariant I9).
 */

/** 1-indexed absolute week number that "now" falls in. Matches the backend's
 *  `CURRENT_WEEK` default (42 since the 2026-10-13 reseed with the client's real
 *  2026 data). */
export const CURRENT_WEEK = 42;

/** A project completes "within the year" iff its last step ends (plus delay) by
 *  this week. The per-project verdict is `row.spillover` / `row.left_out` from the
 *  API — this constant only positions the year-end marker line. */
export const WITHIN_YEAR_WEEK = 52;

/**
 * The planning horizon the UI PRESENTS: one 52-week year, W1–W52 (client ask,
 * 2026-10-13: "keep the 52-week horizon only, show till week 52, and projects
 * not done by then show as spillover"). Every axis, label, tooltip and week
 * input in the app is framed on this. Work past W52 is drawn clipped at W52 and
 * labelled "Spillover → {SPILLOVER_YEAR}"; it is never drawn on W53+ columns.
 *
 * NOT the scheduler's horizon: the server still searches up to its internal
 * 78-week horizon (`HORIZON_WEEKS` in `backend/scheduling/domain_constants.py`,
 * served as `ScheduleRunSummary.horizon_weeks`) so it can tell a spillover
 * project (placed, finishing after W52) from a left-out one (not placed at all).
 * The frontend never displays that 78; it only shows the server's verdicts.
 */
export const DISPLAY_HORIZON_WEEKS = WITHIN_YEAR_WEEK;

/** The calendar year the 52-week plan covers, and the year work past W52 spills
 *  into. Display copy only. */
export const PLAN_YEAR = 2026;
export const SPILLOVER_YEAR = PLAN_YEAR + 1;
/** The year whose unfinished projects are carried over INTO the plan year
 *  (Dashboard pipeline "Spillover" composition card, ADR 0030). Label only. */
export const CARRY_OVER_YEAR = PLAN_YEAR - 1;

/**
 * Prioritization scoring anchors (P9 contract §8; deck slide 4 "Scoring Logic").
 * STATIC display copy: what a 1 and a 5 mean on each of the 13 dimensions, so a
 * scorer reads the rubric where they score. Weights are in
 * `surfaces/matrix/api/types.ts::DIMENSIONS`; the weighted score, normalised
 * percentage and band all come from the API (Invariant I9) — nothing here is
 * used in a calculation.
 */
export interface ScoringAnchor {
  /** What a score of 1 means. */
  low: string;
  /** What a score of 5 means. */
  high: string;
}

export const SCORING_ANCHORS = {
  strategic_project: { low: 'Non-strategic', high: 'Core roadmap' },
  new_customer: { low: 'Existing minor', high: 'Major strategic customer' },
  new_options: { low: 'Minor option', high: 'Breakthrough feature' },
  regulatory_compliance: { low: 'None', high: 'Mandatory < 6 months' },
  quality_improvements: { low: 'Negligible', high: 'Major field-issue reduction' },
  rm_savings: { low: '< €5K', high: '> €100K annually' },
  total_rm_savings: { low: 'Minimal', high: 'Very high 3-year savings' },
  gross_margins: { low: '< 1%', high: '> 15%' },
  profitability: { low: 'Low / negative', high: 'Very high' },
  annual_volume: { low: '< 5K', high: '> 25K units' },
  three_year_volume: { low: 'Low', high: 'Global multi-year scale' },
  new_models: { low: 'Single model', high: 'Global platform' },
  // Inverted: the SMALLER the investment, the HIGHER the score.
  capex_investment: { low: '> €500K', high: '< €10K' },
} as const satisfies Record<string, ScoringAnchor>;

export type ScoringAnchorField = keyof typeof SCORING_ANCHORS;

/** The 1..5 scale every dimension is scored on. */
export const SCORING_SCALE: readonly { score: 1 | 2 | 3 | 4 | 5; label: string }[] = [
  { score: 5, label: 'Exceptional / Must-do' },
  { score: 4, label: 'Strong case' },
  { score: 3, label: 'Moderate / Average' },
  { score: 2, label: 'Weak case' },
  { score: 1, label: 'Negligible / N/A' },
] as const;
