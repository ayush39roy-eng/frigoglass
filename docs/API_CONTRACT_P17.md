# API contract P17 — Dashboard Project Pipeline row (ADR 0030)

Additive. Existing fields keep their names and types. All shares are server-computed, 2 dp, 0.0 on a
zero denominator. Same RBAC (Dashboard read), hub scope, `hub_id` and `region` filters as before.

## GET /dashboard/pipeline-totals

```
PipelineTotals {
  spillover_count: int          # carry_over true
  new_count: int                # carry_over false and reg_year not null
  unregistered_count: int       # carry_over false and reg_year null   (new)
  total_count: int              # = sum of the three = every project, Commercialized included
  spillover_share_pct: float    # (new)  spillover_count / total_count x 100
  new_share_pct: float          # (new)
  unregistered_share_pct: float # (new)
}
```

## GET /dashboard/region-summary

```
RegionSummary { total_count: int, regions: RegionSummaryRow[3] }   # Greece, India, Romania
RegionSummaryRow {
  region, total_count, share_pct,                 # unchanged (total now = every project)
  spillover_count, newly_registered_count,        # unchanged
  unregistered_count: int,                        # (new)
  spillover_share_pct: float,                     # (new) this region's count / portfolio spillover_count x 100
  newly_registered_share_pct: float,              # (new) / portfolio new_count
  unregistered_share_pct: float,                  # (new) / portfolio unregistered_count
  status_counts, status_share_pct                 # unchanged
}
```

Reconciliation (any filter): `summary.total_count == totals.total_count`; per bucket, the sum over
regions equals the `PipelineTotals` count; `row.total_count == spillover + newly_registered +
unregistered == sum(status_counts)`.

## Basis change (breaking only in value, not shape)

`/dashboard/hub-type-pipeline` and `/dashboard/analytics` (all lists, including the `completing_*`
pipeline denominators) now count every project too, so each sums to `PipelineTotals.total_count`.
`/dashboard/status-overview` is unchanged.

## Frontend types to update (frontend-builder)

`frontend/src/surfaces/dashboard/api/types.ts`: add the four fields to `PipelineTotals` and the four
to `RegionSummaryRow` (exact-match contract test `test_openapi_frontend_contract.py` fails until
then). Render the shares from the server; never divide in the browser.

## GET /dashboard/status-overview — five cards (P17-T03)

Additive; `in_buyoff`, `under_industrialization`, `in_development`, `in_queue`, `other_counts` are
unchanged. Same RBAC, hub scope, `hub_id` and `region` filters. Shares are server-computed, 2 dp,
0.0 on a zero denominator (I19); the browser never divides.

```
StatusOverview {
  ...existing fields...,
  commercialized_count: int,
  on_hold_count: int,                  # PROJECT status "On Hold" (see below)
  total_count: int,                    # every project in scope/filter == PipelineTotals.total_count
  in_development_share_pct: float,     # count / total_count x 100  (progress-bar width)
  under_industrialization_share_pct: float,
  in_queue_share_pct: float,
  commercialized_share_pct: float,
  on_hold_share_pct: float,
  other_statuses_count: int,           # remainder, see below
  other_statuses_counts: dict[str,int],# {"In Buyoff": n, "Draft": n, "Cancelled": n}, zero entries omitted
  other_statuses_share_pct: float
}
```

Card fields: In Development = `in_development`, Under Industrialization = `under_industrialization`,
In Queue = `in_queue`, Commercialized = `commercialized_count`, On Hold = `on_hold_count`.
(Existing counts keep their old names; the two new counts use the `_count` suffix.)

**Remainder.** In Buyoff has no card (it stays in `in_buyoff`). Draft and Cancelled have none either.
`other_statuses_count = in_buyoff + Draft + Cancelled`, so
`in_development + under_industrialization + in_queue + commercialized_count + on_hold_count +
other_statuses_count == total_count` for every filter. The frontend shows "Other statuses: n" from
`other_statuses_count`. `other_counts` (existing) is NOT the remainder: it also holds Commercialized
and On Hold.

**Per-country chips** need nothing new: `region-summary.regions[].status_counts[status]` and
`status_share_pct[status]` already carry every status (including "Commercialized" and "On Hold") under
every `hub_id` / `region` filter. The chip share is the country's count over the portfolio count for
that status (the three chips of one card sum to about 100), not over the country's own total. The
card's bar width is the card's `*_share_pct`.

**ADR 0017.** `on_hold_count` is the project STATUS `On Hold` (the whole project is out of the plan).
It is not the stage-level "On Hold" (stored `Blocked`) outcome or the health badge; the two are never
summed or shown under one label.

Frontend (P17-T04): add the eleven fields to `StatusOverview` in
`frontend/src/surfaces/dashboard/api/types.ts`. `test_openapi_frontend_contract.py::
test_field_sets_match[StatusOverview]` fails until it does.
