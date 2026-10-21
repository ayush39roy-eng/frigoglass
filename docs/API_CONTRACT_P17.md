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

## GET /dashboard/completing-within-year — delivery by priority (P17-R03)

Additive; nothing removed. Same RBAC, hub scope, `hub_id` and `region` filters as before.

**Row fields (new)** on `CompletingWithinYearRow`:

```
status: ProjectStatus      # wire value ("In Queue", "Commercialized", ...), non-sensitive
not_started: bool          # status == "In Queue" AND no stage of the project has progress
```

"Started" reuses the scheduler's `progress_tracked` rule (`scheduling.workflow`): a project is
started once any stage has `status != Not Started`. The row has no workflow plan, so the server reads
the stored stage rows (`EXISTS project_workflow_steps.status != 'Not Started'`). `not_started` is
true only for an In Queue project with no started stage. An In Queue project with a started stage is
in flight; Commercialized is never `not_started`.

**Response field (new)** `priority_delivery: PriorityDeliveryBand[5]`, always P1, P2, P3, P4, Q in
that order (zeroed bands when nothing is in scope; with no active run, counts are served and every
`*within_year*` figure is 0):

```
PriorityDeliveryBand {
  priority: "P1"|"P2"|"P3"|"P4"|"Q"
  total, within_year: int
  in_flight_total, in_flight_within_year: int
  not_started_total, not_started_within_year: int
  delivered_total, delivered_within_year: int     # Commercialized, counted apart
  other_total: int                                # On Hold, Cancelled, Draft
  within_year_share_pct          # within_year / total
  in_flight_within_year_share_pct  # in_flight_within_year / in_flight_total
  not_started_within_year_share_pct
  in_flight_share_pct, not_started_share_pct, delivered_share_pct, other_share_pct   # / total
}
```

All shares 2 dp, 0.0 on a zero denominator (I19); the browser never counts or divides.

- **Basis.** Every project in scope and filter (so band totals sum to `PipelineTotals.total_count`
  for projects that have a priority), LEFT JOINed to the active run's outcome. `within_year` is the
  same exclusive bucket as the counts (`within_year AND NOT blocked`).
- **Exact reconciliation.** `total == in_flight_total + not_started_total + delivered_total +
  other_total` and `within_year == in_flight_within_year + not_started_within_year +
  delivered_within_year`.
- **Delivered** = Commercialized only. It is EXCLUDED from the in-flight and not-started figures;
  all its projects are within-year (ADR 0030). `delivered_within_year` is served so `within_year`
  reconciles.
- **Other** = On Hold, Cancelled, Draft. They never complete: they are in `other_total` and never in
  any `*_within_year`.
- **In flight** = every remaining project: In Buyoff, Under Industrialization, In Development, and
  In Queue with a started stage. **Not started** = In Queue with no started stage.
- A project with a null priority is in no band (the page has none today).

**Frontend (P17-R04):** mirror in `frontend/src/surfaces/dashboard/api/types.ts` the two row fields,
a new `PriorityDeliveryBand`, and `priority_delivery` on `CompletingWithinYear`.
`test_openapi_frontend_contract.py::test_field_sets_match[CompletingWithinYearRow]` and
`[CompletingWithinYear]` are red until then (`PriorityDeliveryBand` is not in that test's mapping;
add a mapping row when the type lands).

## P17-R09 note (appended 2026-10-21): `type=Unmapped` on `GET /dashboard/projects`

The register's `type` query parameter now accepts `ProjectType` values **or** the sentinel
`Unmapped`, meaning `Project.type IS NULL`. It is the same sentinel as the `/dashboard/analytics`
`by_type` bucket key (`_UNMAPPED` in `api/routers/dashboard.py`, P13-T10), so for any scope and
filter `GET /dashboard/projects?type=Unmapped` `.total_count` equals that bucket's `count` (0 /
absent bucket when there are none).

- **Combines** with every other filter (`hub_id`, `region`, `category`, `status_`, `priority`, `q`,
  `leader_engineer_id`, `current_step`, `sort`), ANDed server-side, inside the caller's RBAC hub
  scope (`narrowed_hub_filter`): a Hub Planner gets only their own hubs' untyped projects; an
  out-of-scope `hub_id` answers `{total_count: 0, rows: []}`, never 403.
- **Single-valued**, as before: one `type` per request. The parameter is not repeatable (the
  Dashboard drill-down sends one value per cell; a combined "typed + untyped" list was not needed).
- **Strict:** the match is exact and case-sensitive. Any other value (`unmapped`, `UNMAPPED`,
  `Unknown`, `null`, `None`, empty, trailing space, unknown codes) is 422.
- Pydantic: `schemas.dashboard.RegisterTypeFilter = ProjectType | Literal["Unmapped"]`. No response
  shape changes; rows keep `type: null` for these projects.
- Frontend: `UNTYPED_REGISTER_FILTER_SERVED = true` in `frontend/src/surfaces/dashboard/lib/drilldown.ts`;
  the pipeline table's untyped ("—") cells and column total are now drill-down buttons.
- Not changed: the Dashboard export (`services/export_builder.build_dashboard_sheets`) still parses
  `type_` with `ProjectType(...)`, so an export request with `type=Unmapped` would not be honoured
  there; follow-up for whoever owns that file.
