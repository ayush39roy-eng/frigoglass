# API contract: P42, priority bands mean something for scheduling (ADR 0056)

*Written at P42-T03 (2026-11-17) from DOMAIN_RULES "Priority band meaning" and the workflow-auditor's
ruling R42-1..R42-12 (MEMORY "[2026-11-17] P42-T01"). Binding for P42-T04.*

Only the endpoints and fields listed here change. Every field below is **additive**: nothing is
renamed or removed, and no existing field changes type. Where an existing figure changes *meaning*
(it now counts counting rows only), that is called out as **Meaning change**.

## 0. Vocabulary

- **Stored flags.** Every run outcome row (`schedule_run_project_outcomes`) now carries two
  booleans written by the scheduler (migration `p42a`). Surfaces read them from the stored row only.
  The browser never derives them from the live priority or status.
  - `counts_toward_year`: false for a project in a schedulable status that is P4 or Q, or that is
    P3 with status In Queue (R42-4). Frozen does not change it. Status-excluded projects
    (Commercialized, On Hold, Cancelled, Draft) are true.
  - `not_scheduled_priority`: true for a **non-frozen** P4 or Q project in a schedulable status.
    It is never scheduled, books nothing and has no step rows (R42-3, I49).
  - Runs stored before P42 read `counts_toward_year = true` and `not_scheduled_priority = false`
    (the column defaults, which are truthful for them, I14).
- **Outcome bucket** (`ScheduleOutcome`). One exclusive bucket per outcome row, with this
  precedence (R42-6):
  `NOT_SCHEDULED_PRIORITY > QUEUED > BLOCKED > WITHIN_YEAR > SPILLOVER > LEFT_OUT`.
  - `QUEUED` = `counts_toward_year` false and not `not_scheduled_priority`.
  - A row in none of the six (On Hold / Cancelled / Draft, or a data error) has bucket `null`.
  - The type is now
    `"WITHIN_YEAR" | "SPILLOVER" | "LEFT_OUT" | "BLOCKED" | "QUEUED" | "NOT_SCHEDULED_PRIORITY"`.
  - **Meaning change:** the four old buckets now hold counting rows only. A queued project that is
    also `left_out` or `blocked` is `QUEUED`.
- **Labels (R42-1).**

  | Code | `label` | Chip |
  |---|---|---|
  | P1 | Must do this year | P1 |
  | P2 | Good to have this year | P2 |
  | P3 | In queue | P3 |
  | P4 | Miscellaneous | P4 |
  | Q | Unprioritised | Q |

  `priority_label` fields below carry the `label` (null when the project has no band).
- **`outcome_label`** (served display text, so the browser composes no copy):
  - `"Not scheduled (P4)"` for `NOT_SCHEDULED_PRIORITY` (the text is fixed, also for Q);
  - `"Queued — fits by W{n}"` for `QUEUED` with stored `projected_end_week = n ≤ 52`;
  - `"Queued — after W52"` for `QUEUED` with `projected_end_week > 52`;
  - `"Queued — no slot"` for `QUEUED` that is `left_out` (or has no projected week);
  - `null` for a counting row or no row. The surface then keeps its pre-P42 copy.

## 1. `GET /reference/priorities` (new)

Any authenticated principal, like `GET /hubs`. It returns a list in band order P1, P2, P3, P4, Q.

```json
[
  { "code": "P1", "label": "Must do this year", "short_label": "P1",
    "not_scheduled": false, "queued_when_in_queue": false },
  { "code": "P3", "label": "In queue", "short_label": "P3",
    "not_scheduled": false, "queued_when_in_queue": true },
  { "code": "Q", "label": "Unprioritised", "short_label": "Q",
    "not_scheduled": true, "queued_when_in_queue": true }
]
```

| Field | Type | Meaning |
|---|---|---|
| `code` | `"P1"`…`"Q"` | Band. |
| `label` | string | R42-1 label. |
| `short_label` | string | The chip text (the code). |
| `not_scheduled` | bool | A non-frozen project of this band in a schedulable status is never scheduled (P4, Q). |
| `queued_when_in_queue` | bool | An In Queue project of this band does not count toward the year (P3, P4, Q). |

## 2. Priority board: `GET /priority-board`

`PriorityBoardColumn` gains:

| Field | Type | Meaning |
|---|---|---|
| `label` | string | R42-1 label of the column. |
| `not_scheduled` | bool | True for P4 and Q. Their cards keep their ranks (R42-7). |
| `queued_count` | int | Cards of this column with `queued` true. |

`PriorityBoardCard` gains:

| Field | Type | Meaning |
|---|---|---|
| `counts_toward_year` | bool \| null | Stored flag; null when the project is not in the active run. |
| `not_scheduled_priority` | bool \| null | Stored flag; null when not in the run. |
| `queued` | bool | **The "Queued" badge (R42-7).** Stored bucket is `QUEUED`. False when not in the run. |
| `outcome_label` | string \| null | See §0. |

The card order is unchanged (rank order). The scheduler walks every started P3 before every queued
P3 (key 1a), so the badge is what tells them apart (R42-7, accepted consequence).

## 3. Project Workspace: `GET /projects/{id}/workspace`

`WorkspaceSchedule` (`schedule`) gains the following fields. All are null when the project has no
outcome row in the active run.

| Field | Type |
|---|---|
| `counts_toward_year` | bool \| null |
| `not_scheduled_priority` | bool \| null |
| `outcome` | `ScheduleOutcome` \| null |
| `outcome_label` | string \| null |
| `priority_label` | string \| null (from the live band; null with no band) |

`health` is unchanged (I13). A not-scheduled project reads `unscheduled`, and a queued one reads as
its structure says (`left_out`, `off_track`, …). Show `outcome_label` when it is set.

## 4. Gantt: `GET /gantt` (and the Gantt export, §8)

`GanttProjectRow` gains the following fields, all with defaults when the project has no outcome row:

| Field | Type | Default |
|---|---|---|
| `priority_label` | string \| null | null |
| `counts_toward_year` | bool | true |
| `not_scheduled_priority` | bool | false |
| `outcome` | `ScheduleOutcome` \| null | null |
| `outcome_label` | string \| null | null |

A not-scheduled project has no step rows, so its per-project weeks are null. I23 holds: a project
contributes only its booked rows.

## 5. Capacity

`GET /capacity/hubs` (= `/capacity/hub-load`) → `HubCapacitySummary` and `GET
/capacity/class-breakdown` → `ClassBreakdown` both gain:

| Field | Type | Value |
|---|---|---|
| `priority_bucket_labels` | `{ [key]: string }` | `{"P1":"P1","P2":"P2","P3":"P3","P4":"P4","Queue":"Q"}` |

The split key `Queue` (band Q or none) **stays on the wire**. Its display label is now **"Q"**, so it
no longer collides with P3 "In queue" (R42-1).

`ClassBreakdownRow` gains:

| Field | Type | Meaning |
|---|---|---|
| `queued_count` | int | Schedulable projects of the category whose active-run outcome is `QUEUED`. |
| `not_scheduled_priority_count` | int | … whose outcome is `NOT_SCHEDULED_PRIORITY`. |

**Meaning change:** `deliverable_count`, `left_out_count`, `total_count`, both `*_by_priority`
splits and `by_hub` now count counting rows only. The two new counts are outside all of them.

**Meaning change (I25, R42-6):** remaining demand (`design_load_remaining_weeks`,
`lab_load_remaining_weeks`, the members' remaining, the totals, and the legacy `estimated_*`) now
covers a schedulable status ∧ (band ∉ {P4, Q} ∨ frozen). Full-year demand is unchanged. Queued P3
stays in remaining demand because it is scheduled.

## 6. VIP

`GET /vip-projects` → `VipProject` and `GET /vip-board` → `VipBoardProject` each gain these four
fields:

| Field | Type |
|---|---|
| `priority_label` | string \| null |
| `counts_toward_year` | bool \| null (null when not in the active run) |
| `not_scheduled_priority` | bool \| null |
| `outcome_label` | string \| null |

**Behaviour (R42-6).**
- A non-frozen P4/Q project never auto-fills the VIP list, whether its outcome is not scheduled or
  it has no outcome row yet ("pipeline, not yet in run").
- A *pinned* one is still listed (`selection: "pinned"`), with `outcome_label: "Not scheduled (P4)"`.

## 7. Priority move preview / confirm

`POST /projects/{id}/priority/preview` and `POST /projects/{id}/priority` (`applied`).

`PriorityPreviewMoved` (`moved`) gains:

| Field | Type | Meaning |
|---|---|---|
| `counts_toward_year_before` / `_after` | bool \| null | Null when that side has no outcome. |
| `not_scheduled_priority_before` / `_after` | bool \| null | Same. |
| `effect` | `"leaves_plan"` \| `"joins_queue"` \| null | R42-8, see below. |
| `effect_label` | string \| null | `"leaves the plan"` / `"joins the queue — not counted this year"`. |

`effect` rules:
- `leaves_plan` applies when the move makes the project not scheduled (into P4/Q).
- `joins_queue` applies when after the move the project is queued (not counting, not P4-excluded)
  and before it was either not scheduled (P4 → P3 while In Queue) or counting (for example P2 → P3
  while In Queue).
- Otherwise `effect` is null. For example, P4 → P1/P2 enters last in the band (R36-3) and counts.

The moved project is never in `changes`, so a move into P4 is never "drops out of the year".

`PriorityPreviewChange` (each row of `changes`) gains:

| Field | Type | Meaning |
|---|---|---|
| `counts_toward_year_before` / `_after` | bool | A side with no outcome reads `true`. |
| `not_scheduled_priority_before` / `_after` | bool | A side with no outcome reads `false`. |
| `priority_label` | string \| null | Label of `priority`. |

**Meaning change:** `summary.pushed_out_of_year` counts only rows that are still counting after the
move.

## 8. Dashboard

### `GET /dashboard/completing-within-year` → `CompletingWithinYear`

New top-level fields:

| Field | Type | Meaning |
|---|---|---|
| `queued_count` | int | Rows in bucket `QUEUED`. |
| `not_scheduled_priority_count` | int | Rows in bucket `NOT_SCHEDULED_PRIORITY`. |
| `excluded_count` | int | Rows in no bucket (On Hold / Cancelled / Draft / data error). |
| `counting_outcome_count` | int | `within_year_count + spillover_count + left_out_count + blocked_count`: **the denominator** (I53). |
| `within_year_share_pct` | float | `within_year_count / counting_outcome_count × 100`, 2 dp, 0.0 on 0. |

The invariant is `Σ six bucket counts + excluded_count == len(rows)`.

**Meaning change:** the four old counts hold counting rows only. On dev, R42-10 expects the
denominator to go from 272 to 200 and the share from 49.6% to 67.0%.

`CompletingWithinYearRow` (`rows[]`) gains:

| Field | Type |
|---|---|
| `counts_toward_year` | bool |
| `not_scheduled_priority` | bool |
| `outcome` | `ScheduleOutcome` \| null: the row's bucket (the counts partition by it) |
| `priority_label` | string \| null |
| `projected_end_week` | int \| null (the stored value, for the queued copy) |

`DeliveryRegionRow` (`regions[]`) gains `queued_count` and `not_scheduled_priority_count`. For each
of the six buckets, Σ over `regions` equals the top-level count.

`PriorityDeliveryBand` (`priority_delivery[]`) gains:

| Field | Type | Meaning |
|---|---|---|
| `priority_label` | string | Band label. |
| `queued_total` | int | Projects of the band whose active-run bucket is `QUEUED`. |
| `not_scheduled_priority_total` | int | … `NOT_SCHEDULED_PRIORITY`. |
| `counting_total` | int | `total − queued_total − not_scheduled_priority_total`. A project with no outcome row counts. |
| `in_flight_counting_total` | int | Counting projects of `in_flight_total`. |
| `not_started_counting_total` | int | Counting projects of `not_started_total`. |

**Meaning change:**
- `within_year` counts the exclusive WITHIN_YEAR bucket, counting rows only.
- `within_year_share_pct` = `within_year / counting_total`.
- `in_flight_within_year_share_pct` = `in_flight_within_year / in_flight_counting_total`.
- `not_started_within_year_share_pct` = `not_started_within_year / not_started_counting_total`.
- The composition shares (`*_share_pct` of `total`) are unchanged.

### `GET /dashboard/analytics`

`CompletingHubTypeRow`, `CompletingByTypeRow` and `CompletingByHubRow` each gain `counting_count:
int`. It is `pipeline_count` minus the cell's projects whose active-run bucket is `QUEUED` or
`NOT_SCHEDULED_PRIORITY`.

**Meaning change:** `completing_pct` = `completing_count / counting_count`. `pipeline_count` and
every `by_*` list are unchanged (composition).

### `GET /dashboard/projects` (register) → `ProjectFilterRow`

- `outcome` can now also be `QUEUED` or `NOT_SCHEDULED_PRIORITY`, with the precedence in §0.
- New fields: `priority_label` (string \| null), plus `counts_toward_year` and
  `not_scheduled_priority` (bool \| null, null with no outcome row).
- The Dashboard export ("Dashboard" sheet) carries these columns automatically.

### Unchanged

`/dashboard/region-summary`, `/pipeline-totals`, `/status-overview` and `/hub-type-pipeline` are
portfolio composition from the live project table, not run outcomes. Their "spillover" is the
registration carry-over. They do not change.

### Executive view

There is no Executive endpoint. The KPI strip and risks are built from the payloads above, using
the served counts, `rows[].outcome`, `rows[].counts_toward_year` and `register.rows[]`. "VIP not in
year" excludes rows with `counts_toward_year = false`.

## 9. Schedule runs

`POST /schedule-runs/greedy-recalc` → `GreedyRecalcResponse` gains `queued_count` and
`not_scheduled_priority_count`. **Meaning change:** `left_out_count`, `within_year_count` and
`spillover_count` count counting outcomes only. The audit row carries the same five counts.

`GET /schedule-runs/{id}/changes?against=` → `ScheduleRunChangeRow` gains these fields:

| Field | Type |
|---|---|
| `before_counts_toward_year` / `after_counts_toward_year` | bool |
| `before_not_scheduled_priority` / `after_not_scheduled_priority` | bool |
| `priority_label` | string \| null |

A side with no outcome row reads every flag `false` (as `before_*` / `after_*` already do).
**Meaning change (I20):** a row is listed when any of the six compared fields differs, so a project
that only changed class appears.

## 10. What-if and plan import

`POST /whatif/simulate` and `/whatif/solve` (`achieved`):
- `ProjectResultOut` gains `counts_toward_year` and `not_scheduled_priority` (bool).
- `OutcomeLiteral` (`projects[].outcome`, `before_outcome` / `after_outcome` of changes) gains
  `"not_scheduled_priority"` and `"queued"`.
- `outcome_counts_before` / `_after` gain both keys.
- `diff.within_year_*` already counts only `within_year` flags, which the engine sets to false for
  non-counting projects.

`POST /whatif/import/simulate`, the saved scenarios (`GET /whatif/import/scenarios[/{id}]`) and the
exports:
- `ImportKpisOut` gains `queued` and `not_scheduled_priority` (int, default 0). In merge mode,
  `not_scheduled_priority` includes the plan projects the engine does not serve as rows (P42-T02
  resolution (c)); those are no longer counted in `excluded`. **Meaning change:**
  `within_plan_year`, `spillover`, `left_out` and `blocked` count counting outcomes only (the
  classes are exclusive).
- `ImportProjectOut` gains `counts_toward_year` (default true) and `not_scheduled_priority`
  (default false). Its `outcome` / `before_outcome` can now be the two new classes.
- `BreakdownOutcomesOut` gains `queued` and `not_scheduled_priority` (default 0).
- `BreakdownBucketOut` gains `queued` (default 0).
  - A queued project is placed in a finish-year block by its `finish_week` and counted in that
    block's `queued`, never in `within_year`.
  - A queued project with no slot is in `not_placed`.
  - A not-scheduled project is only in `all`, like `excluded`.
- The issue codes `NOT_SCHEDULED_PRIORITY` and `QUEUED` (severity `info`) come from the engine.
- **P41 saved scenarios** are immutable snapshots taken before P42. They read with the defaults
  above (0 / true / false). Their figures stay as they were computed then, under pre-P42 rules. A
  compare across the P42 boundary therefore mixes both rule sets, so label it if needed.
- Scenario workbook:
  - the Breakdown sheet gains the `queued` column;
  - the Projects sheet gains `counts_toward_year` and `not_scheduled_priority`;
  - Summary / KPIs gain the two KPI rows automatically.

## 11. Exports

The Gantt export (CSV / XLSX) gains two columns after `cat_not_allowed`:
`counts_toward_year` and `not_scheduled_priority`. The Dashboard export follows §8. The scenario
exports follow §10.

## 12. Not an API change, for information

- **Notifications.** A run whose new outcome for a project is non-counting raises no
  `PROJECT_LEFT_OUT` or `DELAY_INTRODUCED` event for it. A conflict event is still raised.
- **Check-ins / tracking.** A non-frozen P4/Q project has nothing due (`GET /check-ins/due`, the
  tracking status is `idle`). Queued P3 is unchanged.
- **Ask the agent.** The project context gains `schedule.counts_toward_year` and
  `schedule.not_scheduled_priority`.

## 13. Rollout (R42-10)

1. `alembic upgrade head` applies `p42a_outcome_band_flags`. It adds the two columns and marks
   `schedule_stale` on every project in a schedulable status that is P4/Q or P3 In Queue (one
   `project.schedule_stale` audit row each, actor null, `reason: "ADR 0056"`). It never solves.
2. `RPD_DATABASE_URL=… python -m scripts.p42_band_rules_run` dispatches exactly one **greedy** run
   with `trigger_reason = "band_rules"`. It is idempotent: `already_dispatched` on a second call,
   and `nothing_to_do` when no project changes class. Exit codes: 0 / 1 / 2 / 3, as for the P33
   script. CP-SAT is never dispatched.
3. On dev, `/changes` against the previous run mixes the P42 effect with the week roll (W42 → the
   calendar week). The T05 audit isolates P42 on a disposable copy with `RPD_CURRENT_WEEK=42`.
