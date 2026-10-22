import type {
  DimensionScore,
  PriorityMatrixRow,
  ScoringDimensionTable,
  ScoringRubric,
  ScoringRubricDimension,
} from './api/types';

/** P13-T14 (API_CONTRACT_P13 §7) fields for test row builders (+ P25, P26 defaults). */
export const P13_MATRIX_ROW_DEFAULTS: Pick<
  PriorityMatrixRow,
  | 'status'
  | 'leader_name'
  | 'leader_engineer_id'
  | 'rank'
  | 'dimension_scores'
  | 'score_band'
  | 'capacity_fill'
  | 'capacity_fill_reason'
  | 'missing_dimension_keys'
  | 'rubric_version'
  | 'scoring_tags'
  | 'tag_dimension_keys'
  | 'is_vip'
> = {
  status: 'In Development',
  leader_name: null,
  leader_engineer_id: null,
  rank: null,
  // P21 §3: required on the wire (P26: one entry per active dimension).
  dimension_scores: [],
  // P25 (ADR 0036): no capacity fill unless a test says so.
  score_band: null,
  capacity_fill: false,
  capacity_fill_reason: null,
  // P26 (ADR 0037): complete, rubric version 1.
  missing_dimension_keys: [],
  rubric_version: 1,
  // P27 (ADR 0038): no Registration tags unless a test says so.
  scoring_tags: [],
  tag_dimension_keys: [],
  // ADR 0040: not VIP unless a test says so.
  is_vip: false,
};

/** P25 fields of a compare item, for test builders (+ P26 defaults). */
export const P25_FILL_DEFAULTS = {
  score_band: null,
  capacity_fill: false,
  capacity_fill_reason: null,
  missing_dimension_keys: [] as string[],
  rubric_version: 1,
} as const;

export interface TestDimension {
  key: string;
  label: string;
  pillar: string;
  weight: number;
}

/** TEST DATA: the initial rubric (version 1, ADR 0029 / 0037) in display order. */
export const INITIAL_TEST_DIMENSIONS: readonly TestDimension[] = [
  { key: 'strategic_project', label: 'Strategic Project', pillar: 'Strategic Alignment', weight: 25 },
  { key: 'new_customer', label: 'New Customer', pillar: 'Strategic Alignment', weight: 25 },
  { key: 'new_options', label: 'New Options', pillar: 'Strategic Alignment', weight: 25 },
  { key: 'regulatory_compliance', label: 'Regulatory Compliance', pillar: 'Regulatory & Quality', weight: 25 },
  { key: 'quality_improvements', label: 'Quality Improvements', pillar: 'Regulatory & Quality', weight: 25 },
  { key: 'rm_savings', label: 'RM Savings', pillar: 'Financial Return', weight: 25 },
  { key: 'total_rm_savings', label: 'Total RM Savings', pillar: 'Financial Return', weight: 25 },
  { key: 'gross_margins', label: 'Gross Profitability', pillar: 'Financial Return', weight: 25 },
  { key: 'profitability', label: 'ROI', pillar: 'Investment & Feasibility', weight: 25 },
  { key: 'annual_volume', label: 'Annual Volume', pillar: 'Market & Volume', weight: 15 },
  { key: 'three_year_volume', label: '3-Year Volume', pillar: 'Market & Volume', weight: 25 },
  { key: 'new_models', label: 'New Models', pillar: 'Market & Volume', weight: 15 },
  { key: 'capex_investment', label: 'CAPEX Investment (inverted)', pillar: 'Investment & Feasibility', weight: 15 },
];

/** TEST DATA: the initial 13 plus an added dimension in a new pillar (14 dimensions, 6 pillars). */
export const FOURTEEN_TEST_DIMENSIONS: readonly TestDimension[] = [
  ...INITIAL_TEST_DIMENSIONS,
  { key: 'sustainability_esg', label: 'Sustainability & ESG', pillar: 'Sustainability', weight: 30 },
];

/** Served-looking `dimension_scores` (points = score / 5 × weight, as the server serves them). */
export function testDimensionScores(
  scores: Readonly<Record<string, number | null>>,
  dims: readonly TestDimension[] = INITIAL_TEST_DIMENSIONS,
): DimensionScore[] {
  return dims.map((d) => {
    const score = scores[d.key] ?? null;
    return {
      key: d.key,
      label: d.label,
      pillar: d.pillar,
      score,
      weight: d.weight,
      points: score === null ? null : (score / 5) * d.weight,
      max_points: d.weight,
    };
  });
}

/** Every dimension at the same score. */
export function uniformScores(score: number | null, dims: readonly TestDimension[] = INITIAL_TEST_DIMENSIONS): Record<string, number | null> {
  return Object.fromEntries(dims.map((d) => [d.key, score]));
}

/** A served `GET /priorities/dimensions` table for the given dimensions. */
export function testDimensionTable(dims: readonly TestDimension[] = INITIAL_TEST_DIMENSIONS, rubricVersion = 1): ScoringDimensionTable {
  const total = dims.reduce((s, d) => s + d.weight, 0);
  return {
    total_weight: total,
    rubric_version: rubricVersion,
    dimensions: dims.map((d) => ({ ...d, scaled_weight: Math.round((d.weight * 10000) / total) / 100 })),
  };
}

/** A served `GET /scoring-rubric` for the given dimensions (all active unless listed in `inactive`). */
export function testRubric(
  overrides: Partial<ScoringRubric> = {},
  dims: readonly TestDimension[] = INITIAL_TEST_DIMENSIONS,
  inactive: readonly string[] = [],
): ScoringRubric {
  const total = dims.filter((d) => !inactive.includes(d.key)).reduce((s, d) => s + d.weight, 0);
  const dimensions: ScoringRubricDimension[] = dims.map((d, i) => ({
    id: `id-${d.key}`,
    key: d.key,
    label: d.label,
    pillar: d.pillar,
    weight: d.weight,
    scaled_weight: inactive.includes(d.key) ? null : Math.round((d.weight * 10000) / total) / 100,
    inverted: d.key === 'capex_investment',
    active: !inactive.includes(d.key),
    display_order: i + 1,
  }));
  return {
    version: 1,
    total_weight: total,
    changed_at: '2026-10-22T07:00:00Z',
    changed_by_user_id: null,
    changed_by_name: null,
    reason: 'Initial rubric',
    dimensions,
    pillars: [...new Set(dims.map((d) => d.pillar))],
    can_edit: false,
    ...overrides,
  };
}
