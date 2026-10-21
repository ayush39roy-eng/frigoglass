# ADR 0033: A prioritization dimension may be scored 0

## Status

Accepted (2026-10-21). Part of P21. **Supersedes the 1..5 score range** of ADR 0029 ("score 1 gives
weight/5 ... score 5 gives the full weight") and of `docs/DOMAIN_RULES.md` "Prioritization scoring".
The points formula, the total weight, the scaling to 100 and the bands are unchanged. Does not
change scheduling: the scheduler never reads the weighted score (P16-T01 finding, ADR 0029 §5).

## Context

Owner ruling, 2026-10-21: each of the 13 dimension scores may be 0..5 instead of 1..5. A dimension
that does not apply to a project (for example New Customer on an internal cost-down) had to be
scored at least 1, which gave it weight/5 points it had not earned.

## Decision

1. **Range.** Every dimension score is an integer 0..5. The API (`PUT /priorities/{project_id}`,
   and the scenario-apply score changes) validates 0..5 and returns 422 outside it. The 13
   `priority_scores` CHECK constraints become `BETWEEN 0 AND 5` (migration
   `p21a_currencies_score_zero`).
2. **Points are unchanged:** `points = score / 5 × weight`. A score of 0 earns 0 points; 1 earns
   weight/5; 5 earns the full weight. `raw = Σ points` (out of `TOTAL_WEIGHT`, derived, 295),
   `normalised_pct = round(raw / TOTAL_WEIGHT × 100)`, scaled to 100 for display. A project scored
   0 everywhere is 0 %, band P4.
3. **Bands unchanged** (≥ 70 P1, ≥ 55 P2, ≥ 40 P3, else P4). Hard gates unchanged.
4. **No rescore and no recalculation.** Every stored score is 1..5 and its points do not change, so
   `weighted_score`, `normalized_pct` and `suggested_band` stay valid. The migration only relaxes the
   constraints. Nothing is marked `schedule_stale`.
5. **Seed unchanged.** The seed's derived-dims search still starts every dimension at 1
   (`domain_constants.SEED_DIMENSION_SCORE_FLOOR`), so a reseed produces the same scores as before.

## Worked example

Scores (positional order) `5, 0, 3, 0, 1, 5, 0, 2, 4, 0, 5, 0, 3`, weights
`25, 25, 25, 25, 25, 25, 25, 25, 25, 15, 25, 15, 15`:
points `25 + 0 + 15 + 0 + 5 + 25 + 0 + 10 + 20 + 0 + 25 + 0 + 9 = 134`;
`round(134 / 295 × 100) = round(45.42) = 45` → P3. (Golden in `backend/tests/test_p21_matrix.py`.)

## Consequences

- The minimum normalised score falls from 20 % (all 1s) to 0 %.
- The Matrix edit dialog, the Workspace scoring section and scenario-apply inputs must accept 0.
- Downgrading the migration fails if a 0 has been stored (by design: it would violate the old
  constraint).
