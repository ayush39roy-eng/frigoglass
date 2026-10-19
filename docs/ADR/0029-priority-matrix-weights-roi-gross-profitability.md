# ADR 0029: Prioritization matrix — Gross Profitability, ROI, new weights, points scaled to 100

## Status

Accepted (2026-10-19). Part of P16. Amends DOMAIN_RULES "Prioritization scoring". Changes
scheduling inputs (the weighted score orders projects within a priority band).

## Context

The client asked (relayed 2026-10-19):
- rename the **Gross Margins** dimension to **Gross Profitability**;
- rename **Profitability** to **ROI** and put it under **Investment & Feasibility**;
- **CAPEX Investment** weight 15, **3-Year Volume** weight 25;
- a weight is a *total*: score 1 gives weight/5 (for weight 25: 5) and score 5 gives the full weight
  (25), not score × weight; the total "will come to 300" internally and be **shrunk to 100** for
  display.

## Decision

1. **Labels and pillar only.** The two renamed dimensions keep their DB columns and API keys
   (`gross_margins`, `profitability`). Only the labels change. ROI moves to the Investment &
   Feasibility pillar. The positional order of the 13 scores does not change.
2. **Weights:** 3-Year Volume 25, CAPEX Investment 15. All others unchanged. The sum is **295**,
   not 300. `TOTAL_WEIGHT` is derived from the table, so a later correction is one number. OQ #41
   asks the client which weight is missing (or whether 295 is acceptable).
3. **Scoring:** `points = score / 5 × weight`, `raw = Σ points`, `normalised_pct = round(raw /
   TOTAL_WEIGHT × 100)`. Bands are unchanged (≥ 70 P1, ≥ 55 P2, ≥ 40 P3, else P4).
4. **Displayed scale.** The UI shows each dimension's weight and points scaled to 100:
   `weight × 100 / TOTAL_WEIGHT`. The server serves these figures (I9). The browser does not
   compute them.
5. **Stored scores are recomputed** with the new weights (data migration `p16a`). Nothing is marked
   `schedule_stale` and no recalculation is needed. P16-T01 verified that the scheduler's order key
   is `(frozen, priority, status, category, project_id)` and never reads the weighted score, so the
   score does not change any schedule. It is read only by the Matrix rank and the board card.
   *(Amended 2026-10-19: the first draft wrongly said the score is a scheduling tiebreak and
   marked projects stale; P16-R01 reverts that.)*
6. Hard gates are unchanged.

## Consequences

- Normalised percentages change (85 of 253 on the live dev data). **No suggested band changed**
  (26 P1 / 6 P2 / 95 P3 / 126 P4 before and after). Applied priorities are not rewritten.
- The old comment "280" is gone from the code and tests.
