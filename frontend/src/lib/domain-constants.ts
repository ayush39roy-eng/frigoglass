/*
 * P53 (ADR 0063, R53-1 / R53-8, I40): there is NO week or year constant here
 * any more. `WITHIN_YEAR_WEEK`, `DISPLAY_HORIZON_WEEKS` and
 * `SCHEDULER_HORIZON_WEEKS` were removed: weeks are absolute from the served
 * `/me.week_base_year` W1, the plan-year window (`plan_year_start_week`,
 * `plan_year_end_week`) and the search limit (`horizon_weeks`) are served, and
 * a run carries its own `within_year_week` / `horizon_weeks`. Read them through
 * `@/lib/plan-clock` and the week-line mirror `@/lib/week-line`.
 */

/**
 * Prioritization scoring anchors (P9 contract §8; deck slide 4 "Scoring Logic").
 * STATIC display copy: what a 1 and a 5 mean, for the dimensions the deck
 * describes, looked up by the served dimension key (`scoringAnchor`). It is
 * NOT the rubric: since P26 (ADR 0037) the dimensions, labels, pillars and
 * weights are served by `GET /scoring-rubric` and an Admin may add new ones,
 * which simply have no anchor copy. Nothing here is used in a calculation, and
 * no surface derives its dimension list from these keys.
 */
export interface ScoringAnchor {
  /** What a score of 1 means. */
  low: string;
  /** What a score of 5 means. */
  high: string;
}

const SCORING_ANCHORS: Readonly<Record<string, ScoringAnchor>> = {
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
};

/** The deck's 1 / 5 anchor copy for a served dimension key; undefined for a
 *  dimension the deck does not describe (e.g. one an Admin added). */
export function scoringAnchor(key: string): ScoringAnchor | undefined {
  return Object.prototype.hasOwnProperty.call(SCORING_ANCHORS, key) ? SCORING_ANCHORS[key] : undefined;
}

/** The 0..5 scale every dimension is scored on (0 since ADR 0033). */
export const SCORING_SCALE: readonly { score: 0 | 1 | 2 | 3 | 4 | 5; label: string }[] = [
  { score: 5, label: 'Exceptional / Must-do' },
  { score: 4, label: 'Strong case' },
  { score: 3, label: 'Moderate / Average' },
  { score: 2, label: 'Weak case' },
  { score: 1, label: 'Negligible' },
  { score: 0, label: 'Does not apply (no points)' },
] as const;
