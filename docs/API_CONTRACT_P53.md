# API contract: P53, one week line across years, P1–P3 to completion, delivery by year (ADR 0063)

**Status: P53-T03 (2026-11-19).** Binding source: DOMAIN_RULES "One week line, open horizon, delivery
by year" and the R53 ruling (R53-1..R53-9, I57–I63) in `docs/MEMORY.md`. Only what is listed here
changes. Every field below is visible to every role that can already read the endpoint, unless a
row says otherwise. No field is a financial field.

**Week vocabulary.** Every week on the wire is **absolute** from `week_base_year` W1 (2026 W1 = 1,
2027 W1 = 53, 2028 W1 = 105). It is never re-based. Helpers (backend `domain_constants`; the
browser mirrors them from `/me.week_base_year`):

```
year_of(w)      = week_base_year + ⌊(w − 1) / 52⌋
week_of_year(w) = (w − 1) mod 52 + 1
year_start(Y)   = 52 × (Y − week_base_year) + 1
year_end(Y)     = 52 × (Y − week_base_year + 1)
```

ISO week 53 folds into week 52 of its ISO year (28 Dec 2026 – 3 Jan 2027 → 52). No label is ≥ W53.

## 1. `GET /me`

| Field | Type | Meaning |
|---|---|---|
| `current_week` | int ≥ 1 | **Changed:** absolute calendar week (Europe/Athens, ISO W53 → W52 of its year) or the `RPD_CURRENT_WEEK` pin (1..5200). 4 Jan 2027 → 53. |
| `weeks_left_in_year` | int 0..51 | `plan_year_end_week − current_week` (current week not counted). |
| `plan_year` | int | **Changed:** `year_of(current_week)`. No longer from `RPD_PLAN_YEAR`. |
| `week_base_year` | int | **New.** Always 2026. |
| `plan_year_start_week` | int | **New.** `year_start(plan_year)`. |
| `plan_year_end_week` | int | **New.** `year_end(plan_year)`. |
| `horizon_years` | int 1..10 | **New.** The Admin setting N (default 5). |
| `horizon_weeks` | int | **New.** `current_week + 52 × horizon_years`: the search limit the **next** run will store. |
| `plan_year_closed` | bool | **Deprecated.** Always `false`; removed in the next release. |
| `plan_week.status` | … | Unchanged values. `failed` is now real (§6, 3 failed rollover attempts this week). |

## 2. Scheduling horizon setting (Admin)

`GET /scheduling-settings` — any authenticated role.
`PUT /scheduling-settings` — **Admin or Super Admin** only (403 otherwise). Rate-limited.

```jsonc
// GET / PUT response
{
  "horizon_years": 5,          // N, 1..10
  "version": 1,                // optimistic lock; 0 = never saved (default 5 in force)
  "updated_at": "2026-11-19T10:00:00+02:00" | null,
  "current_week": 47,
  "horizon_weeks_next_run": 307 // current_week + 52 × N
}
// PUT body (extra fields forbidden)
{ "horizon_years": 6, "version": 1 }
```

- 409 `VERSION_CONFLICT` when `version` is not the stored one. 422 when N ∉ 1..10.
- Audit `settings.scheduling_horizon_updated` `{before: {horizon_years}, after: {horizon_years}}`.
- No run is dispatched (Rescheduling is explicit). The UI offers the standard Recalculate after a
  save. N is read once when a run row is created and stored as that run's `horizon_weeks`.

## 3. Schedule runs

`ScheduleRunSummary` (`GET /schedule-runs`, `/active`, recalc responses) gains:

| Field | Type | Meaning |
|---|---|---|
| `rules_epoch` | `"p53"` \| null | null = computed before P53. |
| `within_year_week` | int | `year_end(year_of(current_week))` (52 for every 2026 run). |
| `pre_p53` | bool | `rules_epoch is null`. |
| `rules_label` | string \| null | `"Computed under the earlier rules (78-week search; queued P3 not counted)"` on pre-P53 runs, else null. Show it wherever the run is shown. |

`horizon_weeks` (existing) is `current_week + 52 × N` on P53 runs and 78 on older runs.

`GET /schedule-runs/{run}/changes` gains `includes_rule_change: bool` — true when the baseline is
pre-P53 and the run is P53. UI label: "includes the scheduling-rule change (P53)".

New `trigger_reason` values: `"p53_rules"` (one deploy run, system actor) and `"week_rollover"`
(§6, now dispatched).

## 4. Delivery by year

### 4.1 Payload `DeliveryByYear`

Served from the one pure function over the run's stored rows, after hub scoping and the
endpoint's filters. The browser derives nothing.

```jsonc
{
  "run_week": 47,            // the run's (or simulation's) input week
  "base_year": 2026,         // Y0 = year_of(run_week)
  "within_year_week": 52,    // year_end(Y0) (live / what-if) or u (import)
  "horizon_weeks": 307,
  "horizon_years": 5,        // null when not derivable (import with N changed since)
  "rows": [
    {
      "kind": "by_end_of_year",  // "by_end_of_year" | "year" | "not_placed" | "blocked"
      "year": 2026,              // null on not_placed / blocked
      "label": "By end of 2026", // server label; "2027", "Not placed within 5 years", "Blocked"
      "indicative": false,       // true when year > Y0 + 1
      "p1": 40, "p2": 30, "p3": 10, "other": 0, "total": 80,
      "cum_p1": 40, "cum_p2": 30, "cum_p3": 10, "cum_other": 0, "cum_total": 80,  // null on not_placed / blocked
      "left_out_reasons": null   // on not_placed only: {no_leader, no_chamber, data_error, beyond_horizon}
    }
  ]
}
```

- Row 1 `by_end_of_year` = every counting outcome with `within_year = true` (I59: equals the
  served `within_year_count`). Then one `year` row per Y from Y0 + 1 to the largest finish year
  present (contiguous; empty years are zeros) = counting `spillover` with `year_of(completion) = Y`.
  Then `not_placed` (counting `left_out`, reason split), then `blocked`.
- Columns P1, P2, P3 use `priority_at_run` (the band in the run input). VIP is not a column.
  Non-counting projects never appear. `other` holds a counting project with no P1–P3 band (a
  Commercialized project delivered in Y0 whose band is P4 / Q / none); it is 0 otherwise. In every
  row `p1 + p2 + p3 + other = total`.
- `horizon_years` is null when `horizon_weeks − run_week` is not a positive multiple of 52.

### 4.2 Where it is served

| Endpoint | New fields |
|---|---|
| `GET /dashboard/completing-within-year` (Dashboard and Executive) | `delivery_by_year: DeliveryByYear \| null`; `delivery_by_year_unavailable: "pre_p53_run" \| "no_active_run" \| null`; `rules_epoch`; `rules_label`; `tail_warnings: {far_finish_count: int, leader_overloaded_count: int} \| null` (counts only, no names); each `rows[]` gains `priority_at_run`, `delivery_year: int \| null`, `left_out_reason`, `far_finish: bool`. |
| `GET /dashboard/delivery-by-year/projects` (drill-in) | Query: `kind` (required, as rows), `year` (required for `by_end_of_year`/`year`, else 422 `YEAR_REQUIRED`), `band` (`P1`\|`P2`\|`P3`, optional), plus the dashboard filters `hub_id`, `region`, `category`, `type`. Response `{schedule_run_version, kind, year, band, rows: [{project_id, project_name, hub, band, completion_week, delivery_year, far_finish, left_out_reason}]}`. Hub-scoped; 404 `NO_ACTIVE_RUN` without an active run; `rows: []` for a pre-P53 run with `delivery_by_year_unavailable: "pre_p53_run"`. |
| `POST /whatif/simulate`, `POST /whatif/solve` (each scenario) | `delivery_by_year: DeliveryByYear` |
| `POST /whatif/import/simulate` | `delivery_by_year: DeliveryByYear`; `plan_until_presets` (§5) |
| `GET /whatif/import/scenarios/{id}` | `result.delivery_by_year` as stored; `null` + `delivery_by_year_unavailable: "pre_p53_run"` for scenarios saved before P53. |
| Exports: dashboard xlsx | New sheet **"Delivery by year"** (same rows; pre-P53 run: one line with the label). |

### 4.3 LEFT_OUT reason and tail warnings

- `left_out_reason ∈ {"no_leader", "no_chamber", "data_error", "beyond_horizon"} | null`, on
  every outcome row that already carries `left_out`. P53 runs store it
  (`schedule_run_project_outcomes.left_out_reason`, additive, from the scheduler's diagnostics);
  on a pre-P53 row only `data_error` / `beyond_horizon` can be told apart. `beyond_horizon` copy: "Cannot be scheduled
  within {N} years — check resources".
- `far_finish: bool` = scheduled and `year_of(completion) > Y0 + 1` (copy "Finishes {year} — check
  leader load"). Served on Dashboard rows, the drill-in, and Gantt project rows.
- **Leader tail (engineer-level, GDPR OQ #8):** only on `GET /capacity/engineer-utilization`
  (same roles and hub scope as today). Each engineer row gains `leader_tail_week: int | null`,
  `leader_overloaded: bool` (`leader_tail_week > year_end(Y0 + 1)`), `far_finish_count: int`.
  Dashboard / Executive get only `tail_warnings` counts.

## 5. Plan import (amends API_CONTRACT_P49 / ADR 0061)

- `ImportSimulateRequest.plan_year_end_week`: `int | null` (was `52 | 104`, default 104).
  null → `year_end(year_of(current_week))`. Must be a positive multiple of 52 with
  `current_week ≤ value ≤ H`, else 422 `INVALID_IMPORT`.
- `plan_from_week`, `plan_until_week`: `ge=1, le=5200` on the schema; the service checks
  `cw ≤ f ≤ u ≤ H` (`H = cw + 52 × N`), else 422 `INVALID_IMPORT`.
- `StepEditIn.start_not_before_week`: `ge=1, le=5200`; ≤ H checked in the service (422).
- What-if `SimulateResponse` (and `SolveResponse.achieved`) gain `delivery_by_year` over the served
  projects; the What-if engine does not carry the no-leader / no-chamber diagnostics, so its
  `not_placed` reasons are `data_error` / `beyond_horizon` only. Plan import carries all four.
- Plan-import breakdown year keys run from `year_of(current_week)` (were fixed 2026 / 2027).
- `ImportParseResponse` and `ImportSimulateResponse` gain `plan_until_presets: [{year, week, label}]`
  for each year from `year_of(cw)` whose `year_end(year) ≤ H`. `plan_week_choices` runs from cw
  to H. Response `horizon_weeks = H`.
- Re-run of a saved scenario: if the stored u > H, `u := H` and the issue `PLAN_UNTIL_LOWERED`.
- Saved scenarios accept any `plan_year_end_week` that is a positive multiple of 52.

## 6. Weekly rollover (P37-T05, absolute week)

- `ensure_week_rollover()` runs from the in-app ticker (every 5 min, `RPD_WEEK_ROLLOVER_TICKER`,
  default true, false in tests) and Celery beat (every 15 min + Mondays 00:05 Europe/Athens).
- Decision per DOMAIN_RULES (R37-6/7/8): `not_needed` (no active run, or active / in-flight run
  week == calendar week), `deferred` (a run at another week in flight → one coalesced follow-up),
  `queued` (greedy, `activate=True`, `trigger_reason="week_rollover"`, system actor). Never
  CP-SAT, never sets `schedule_stale`. Max 3 queued attempts per week ≥ 30 min apart, then
  `/me.plan_week.status = "failed"`. No closed-year branch.
- Table `plan_week_rollovers(week PK absolute, plan_year = year_of(week), attempts,
  last_attempt_at, last_run_id, status)`.
- Audit `schedule.week_rollover` `{from_week, to_week, outcome, attempt}`.

## 7. Removed / relaxed

- `POST /check-ins` no longer answers 409 `PLAN_YEAR_CLOSED` (code retired). Check-ins stamp the
  absolute calendar week.
- `RPD_PLAN_YEAR`: unset is normal; `2026` is accepted with a deprecation log; any other value
  stops startup (`PlanClockConfigError`). `RPD_CURRENT_WEEK`: integer 1..5200.
- Step pins (`PUT` step pins): `current_week ≤ ms ≤ me ≤ plan_year_end_week` (422 `PIN_OUT_OF_RANGE`
  as today; the bound is now the current plan year's end, not 52).
- `target_end_week`: `1 ≤ t ≤ current_week + 520` (422 otherwise).
- `GET /gantt` gains `plan_year_start_week`, `plan_year_end_week`, `last_finish_week` (largest end
  week of a non-skipped run row, never below `year_end(Y0)`; null without a run) and per project
  row `far_finish`; `weekly_active_counts` covers `year_start(Y0)`..`last_finish_week`.
- Capacity weekly charts / heatmaps / VIP windows use the plan-year window
  `[plan_year_start_week, plan_year_end_week]` of the run (or of the clock), served as
  `week_range`.
