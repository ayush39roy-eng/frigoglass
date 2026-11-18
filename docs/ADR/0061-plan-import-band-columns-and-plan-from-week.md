# ADR 0061 — Plan import: priority from the band columns, and a "Plan from" week

**Date:** 2026-11-19 · **Status:** Accepted with amendments (workflow-auditor ruling R49-1..R49-14, I54, I55; full text in `docs/MEMORY.md` "[2026-11-19] R49 — workflow-auditor ruling") · **Source:** owner, for the client's `2027 RPD Capacity Planning-Updated-1.xlsx`

## Context

Frigoglass will hand over lists of ongoing and upcoming projects and wants the What-if planner to
schedule **only those projects**, from today or from a chosen start date. Their 2027 file marks
priority mostly with a "Must Do" Yes column (34 rows) and ranks only 12 rows; the parser ignored
"Must Do", so 28 must-do rows fell to P3. There was no way to start the simulation later than the
current week.

## Decision

1. **Band columns set the priority** (R49-1..R49-6). "Must Do" / "Must Do (P1)" Yes → P1, "Good to
   Have (P2)" → P2, "In Queue (P3)" → P3, "Not Approved, on HOLD, NO Priority (P4)" → P4. The most
   urgent Yes wins (`PRIORITY_BAND_CONFLICT`). Precedence: band columns → "Running" → rank → matched
   plan band → P3. A rank under a band is kept as the order within the band. Status is applied first
   (On Hold / Cancelled / Commercialized stay not mapped). `priority_source = "band"`.
2. **`plan_from_week` f** on the import simulate request (R49-7..R49-13): default = calendar week
   `cw`, allowed `cw ≤ f ≤ plan_year_end_week`, else 422. Applies to **file rows only** (both modes):
   their current In Progress step is anchored at f, every Not Started step starts ≥ f; live plan
   projects are untouched; the run's input week stays `cw`; horizon stays `plan_year_end_week + 26`.
   Saved scenarios store the resolved f; re-run uses `max(f, cw)`.
3. **Closed year** (R49-14): from 4 Jan 2027 `cw` reads 52 until P37-F01; the default/min f stays 52.
4. Doc fix: ranked import rows are ordered by rank **within equal status and category** (matches the code).

## Invariants

- **I54** plan-from floor; with f = cw the response is byte-identical to before.
- **I55** import band derivation; a file with no band Yes parses exactly as before.

## Amendment 2026-11-19 — "Plan until" week (R49-15..R49-21, I56)

Owner: "normally use our logic, but as we are choosing a start date also add an end date." Optional
`plan_until_week` u, default the plan-year preset; `f ≤ u ≤ 104`. u replaces the plan-year end as the
"within" cut-off in both runs; horizon `u + 26`; capacity clipped to u. Stored with saved scenarios.
