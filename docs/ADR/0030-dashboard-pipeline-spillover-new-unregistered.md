# ADR 0030: Dashboard pipeline row — Spillover + Newly registered + Unregistered date = Total

## Status

Accepted (2026-10-20). Part of P17. Amends ADR 0025 section 4 (the pipeline basis). Reporting only:
no scheduling input or schedule outcome changes, and nothing under `backend/scheduling/` is touched.

## Context

The client's older app shows the Dashboard "Project Pipeline" row as Spillover 76, New 160,
Unregistered 3, Total 239, each with a share of the total and per-country counts with shares. Our
row showed Spillover and New only, and its total excluded `Commercialized` projects. The client's
239 is 8 in development + 22 under industrialization + 199 in queue + 8 commercialized + 2 on hold,
so their total includes Commercialized.

## Decision (owner, 2026-10-20)

1. **Total is every project** in the caller's scope and filter, `Commercialized` included.
2. **Buckets** (mutually exclusive, sum to `total_count`):
   - Spillover: `carry_over` is true (wins even if `reg_year` is null).
   - Newly registered: `carry_over` is false and `reg_year` is not null.
   - Unregistered date: `carry_over` is false and `reg_year` is null.
3. `PipelineTotals` gains `unregistered_count` and 2 dp `spillover_share_pct`, `new_share_pct`,
   `unregistered_share_pct` (count / total x 100; zero denominator gives 0.0). `RegionSummaryRow`
   gains `unregistered_count` and per-bucket shares. Shares are computed on the server (I19).
4. Existing fields are kept.

## Tables that share the basis

The "pipeline" basis was one concept used in four places. All four move to "every project", so the
dashboard stays reconcilable (each list sums to `PipelineTotals.total_count`, and a region row's
`total_count` equals the sum of its `status_counts`):

| Endpoint | Before | After |
|---|---|---|
| `/dashboard/pipeline-totals` | all except Commercialized | all projects |
| `/dashboard/region-summary` pipeline fields | all except Commercialized | all projects |
| `/dashboard/hub-type-pipeline` | all except Commercialized | all projects |
| `/dashboard/analytics` (by_type, by_category, by_hub, by_reg_year, completing_* denominators) | all except Commercialized | all projects |

`/dashboard/status-overview` and `region-summary.status_counts` were already all statuses and are
unchanged. No table keeps the old basis.

Consequence for "completing within year": the active run marks excluded Commercialized projects
`within_year` ("trivially done"). The Dashboard's within-year card (I9) already counted them. The
analytics cross-tab previously subtracted them from both numerator and denominator; now it counts
both, so `sum(completing_hub_type.completing_count)` equals the card's `within_year_count` exactly
and `completing_pct` has a larger denominator and a larger numerator. *Corrected 2026-10-20
(P17-R01; the original text said "lower percentages", which was wrong in direction).* The
percentages went UP: portfolio 90/236 = 38.14 % to 107/253 = 42.29 %; PD-India 30.82 % to 33.33 %;
PD-Romania 36.36 % to 56.25 %; OEM-Seltek 88.9 % to 90 %; R&D-Greece, R&D-India and OEM-HCK
unchanged. All 17 Commercialized projects count as within-year (17/17), while 29 Cancelled and 15
On Hold sit in the denominator and never complete (0/44). See OQ #42 on whether Cancelled belongs
in the denominator.

## Per-region shares

A region row's `*_share_pct` is its count over the portfolio's count for the same bucket (so the
three regions of one card sum to about 100), not over its own total. `share_pct` (region total over
portfolio total) is unchanged. All use the same filter as the card they sit under.

## Not decided here

Whether `Cancelled` projects belong in the total (OQ #42). The owner said "every project", so they
are included.

## Consequences

- Seeded `client_2026` total moves from 236 to 253 (the 17 Commercialized rows return). That seed
  has `reg_year = 2026` and `carry_over = false` on every project, so it shows Spillover 0, New 253,
  Unregistered 0; the client's 76/160/3 cannot be reproduced from it (OQ #42).
- Frontend hand-mirrored types for `PipelineTotals` and `RegionSummaryRow` must add the new fields
  (the OpenAPI/frontend contract test fails until they do).
