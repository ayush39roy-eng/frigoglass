# API contract: P37, the current week follows the calendar (ADR 0052)

**Status: final at P37-T02 (2026-11-17).** It folds in ruling R37-1..R37-10 and the owner's answers to
OQ #88–#92. There is no `held` status: the owner chose OQ #89 (a).

This is a short note. Only the fields listed here change. **"Calendar week"** means
`plan_clock.now().week` evaluated once for the request (ADR 0052 §1–§3). **"Run week"** means the
active run's stored `current_week`.

## 1. `GET /me`: new and changed fields

| Field | Type | Meaning |
|---|---|---|
| `current_week` | int 1..52 | **Changed source:** the calendar week, previously the import-time constant. |
| `weeks_left_in_year` | int 0..51 | `52 − current_week`. Same definition as before. |
| `as_of_date` | `YYYY-MM-DD` | **New.** Today's date in Europe/Athens. The header shows this, not the browser's date. |
| `plan_year` | int | **New.** `RPD_PLAN_YEAR` (default 2026). Replaces the frontend `PLAN_YEAR` constant. |
| `plan_year_closed` | bool | **New.** True once the ISO year is later than `plan_year` (`current_week` is then 52). |
| `week_source` | `"calendar"` \| `"pinned"` | **New.** `"pinned"` when `RPD_CURRENT_WEEK` is set. |
| `week_ends_at` | ISO-8601 datetime with offset | **New.** The next Monday 00:00 Europe/Athens. The client refetches `/me` then. |
| `plan_week` | object \| null | **New.** Null when there is no active run. Otherwise `{ run_week: int, run_version: int, status: "current" \| "recalculating" \| "pending" \| "failed" }`. `current` ⇔ `run_week == current_week` (R37-6, equality). `recalculating` = a run is queued or running (rollover, follow-up or any other). `pending` = the weeks differ and nothing is in flight yet. `failed` = 3 queued rollover attempts ended FAILED / DISPATCH_FAILED / ABANDONED this week (R37-8). Null when there is no active run (R37-7). |

All the new fields are visible to every authenticated role. None of them is personal data or a
financial field.

## 2. Fields whose source changes (shape unchanged)

| Endpoint / field | Before | After |
|---|---|---|
| `GET /capacity/hub-load` `remaining_weeks` | run week (constant if no run) | calendar week (pairs with the remaining capacity and remaining demand, I19) |
| `GET /capacity/engineer-utilization` `current_week` | run week | calendar week ("now" column). **New** `run_week: int \| null`. |
| `GET /check-ins/due` `week` and every check-in stamp | constant | calendar week |
| `GET /capacity/hub-load` (alias `/capacity/hubs`) remaining supply | constant | calendar week |
| `GET /planning/capacity-summary` `current_week` | constant | calendar week |
| `GET /planning/resource-load` `current_week` | run week (constant if no run) | calendar week. **New** `run_week: int \| null` (the response is run-booked). |
| `GET /workflow-settings` `current_week` | constant | calendar week |
| What-if, What-if chat and plan-import `current_week` | constant | calendar week at request time |
| `GET /schedule-runs/*` `current_week` | stored run week | unchanged (the stored run is never re-read against another week) |

## 3. Schedule runs

- `GET /schedule-runs/{run}/changes` **gains** `baseline_week: int` and `run_week: int`, the two
  runs' stored `current_week` values (R37-4). Rows are unchanged (I20). When the two weeks differ,
  the UI labels the list "includes the move from W*a* to W*b*".
- A run's `current_week` is fixed when its `QUEUED` row is created, and the worker builds the input
  with it (R37-2). `GET /schedule-runs/*` `current_week` therefore equals the week the dispatch
  decision saw.

- New `trigger_reason` value: `"week_rollover"`. It has no user actor (`triggered_by_user_id =
  null`). Audit action: `schedule.week_rollover`, with `{from_week, to_week, outcome:
  queued|deferred|not_needed, attempt}`.
- A priority-move or band-rank preview token issued at week N and confirmed at week N+1 is refused
  with the existing 409 (stale preview). No new error code.

## 3a. Check-ins

- `POST /check-ins` answers **409 `PLAN_YEAR_CLOSED`** while `plan_year_closed` (R37-10). This is a
  new error code. `GET /check-ins/due` and `/history` stay available.
- `GET /check-ins/due`: a Not Started stage is due once its active-run planned start is ≤ `week`
  (R37-1); its due-since is that planned start. Response shape unchanged.

## 3b. What-if / plan import results

No new field. Each result carries its input `current_week`. The client compares it with
`/me.plan_week.run_week` and shows "Simulated from W*c*; the active plan is from W*n*" when they
differ (R37-3).

## 4. Startup

`RPD_CURRENT_WEEK` must be an integer between 1 and 52, and `RPD_PLAN_YEAR` an integer between 2000
and 2100. Any other value stops the process before it serves requests, with a message naming the
variable. `RPD_WEEK_ROLLOVER_TICKER` (boolean, default true) turns the in-app rollover ticker on or
off; both test suites set it to false (R37-9).
