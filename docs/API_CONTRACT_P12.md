# P12 API contract: shared by algorithm-engineer, backend-builder and frontend-builder

Written 2026-10-10 by the orchestrator so that four builders can work in parallel. The rules are the
same as `docs/API_CONTRACT_P11.md`:
- Shapes are implemented exactly (Pydantic v2 strict, `extra="forbid"` on requests).
- The frontend writes `// PLACEHOLDER` TS mirrors and reconciles them against the regenerated
  OpenAPI before closing.
- Any deviation is recorded in `docs/MEMORY.md`.

ADRs: 0018 (Priority board), 0019 (Gantt drag timing), 0020 (global hub filter), 0021 (weekly
check-in), 0022 (VIP projects).

Error bodies follow the existing `CodedHTTPException` shape: `{ "detail": { "code", "message" } }`.

---

## 0. Schema: one Alembic chain, two files with pre-assigned revision IDs

| File | revision | down_revision | Owner |
|---|---|---|---|
| `alembic/versions/p12a_step_timing.py` | `p12a_step_timing` | `d451acccb1ab` | backend-builder **A** |
| `alembic/versions/p12b_vip_checkins.py` | `p12b_vip_checkins` | `p12a_step_timing` | backend-builder **B** |

**p12a** adds two columns to `project_workflow_steps`:
- `duration_override_weeks INTEGER NULL`, with CHECK `IS NULL OR BETWEEN 1 AND 104`
  (name `duration_override_range`);
- `start_not_before_week INTEGER NULL`, with CHECK `IS NULL OR BETWEEN 1 AND 78`
  (name `start_not_before_range`).

**p12b** adds the following:
- On `projects`: `is_vip BOOLEAN NOT NULL DEFAULT false`.
- A new table `stage_checkins`, append-only:

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK projects.id NOT NULL | indexed |
| `step_template_id` | varchar FK workflow_step_templates.id NOT NULL | |
| `week` | int NOT NULL | the `CURRENT_WEEK` at submit time |
| `user_id` | uuid FK users.id NOT NULL | who submitted |
| `status` | `workflow_step_status` enum NOT NULL | as reported |
| `percent_complete` | int NOT NULL CHECK 0..100 | |
| `blocked_reason` | text NULL | |
| `note` | text NULL, at most 1000 characters (CHECK) | |
| `created_at` | timestamptz NOT NULL default now() | |

  - Index: `(project_id, step_template_id, week)`.
  - Protection: the same as the audit log. Give it a trigger that rejects UPDATE and DELETE, the
    way `ba3881d85b55` and the audit-log migration do. Check-ins are history.

## 1. Scheduler input: algorithm-engineer, in `backend/scheduling/types.py`

```python
@dataclass(frozen=True)
class StepTimingInput:
    step_id: str
    duration_override_weeks: int | None   # 1..104, None = lead-time table
    start_not_before_week: int | None      # 1..HORIZON_WEEKS, None = no floor

# ProjectInput gains (default keeps every existing caller and golden file valid):
    step_timing: tuple[StepTimingInput, ...] = ()
```

- Effective duration is `override ?? lead_time` everywhere: greedy, CP-SAT, the unconstrained
  finish, the remaining-duration derivation and the progress roll-up weight.
  `StepSchedule.duration_weeks` is the **effective** duration.
- A step whose lead time is 0 stays skipped even if an override is present. Overrides apply only to
  non-skipped steps.
- For a Not Started step, the floor is `start_not_before_week`.
- Input validation:
  - an unknown `step_id` → `ValueError`;
  - an override outside 1..104 → `ValueError`;
  - a floor outside 1..HORIZON → `ValueError`.
- `invariants.py` adds **I21** and **I22** (ADR 0019).
- The canonical/hashed input includes `step_timing`, sorted by step_id.

## 2. Priority board: `GET /priority-board?hub_id=` (new, backend B)

Permission: `MATRIX` READ, hub-scoped. Engineers have no matrix access, so they get 403.

```jsonc
{
  "run_id": "uuid|null",                 // the active run used for finish/health; null = none yet
  "columns": [                           // always 5, in order P1, P2, P3, P4, Q
    {
      "priority": "P1",
      "count": 12,
      "cards": [
        {
          "project_id": "uuid",
          "name": "str",
          "hub_id": "uuid",
          "hub": "R&D-Greece",
          "category": "A" | null,
          "status": "Active",            // ProjectStatus wire value
          "score": 72.5 | null,          // weighted priority score, as the Matrix serves it
          "band": "P1" | null,           // score-derived band, as the Matrix serves it
          "hard_gated": false,           // true ⇒ pinned to P1, not draggable out
          "is_vip": false,
          "projected_end_week": 48 | null,
          "within_year": true | null,
          "health": "on_track" | "at_risk" | "off_track" | "left_out" | "blocked" | null,
          "tracking_status": "live" | "due" | "overdue" | "idle"
        }
      ]
    }
  ]
}
```

- Cards are sorted by score descending (nulls last), then by name.
- The board includes every project in scope whose `priority` is set. Projects with `priority=null`
  (some Drafts) are not shown. `count` equals `cards.length`.
- A drop calls the **existing** `POST /projects/{id}/priority` (API_CONTRACT_P11 §1). No new write.

## 3. Gantt drag: `PATCH /projects/{project_id}/steps/{step_id}/timing` (new, backend A)

Permission: `GANTT` WRITE, hub-scoped, the same checks as the freeze toggle.

```jsonc
// request: send either field or both; an explicit null clears that field
{ "duration_override_weeks": 6 | null, "start_not_before_week": 40 | null }

// 200 response
{
  "project_id": "uuid",
  "step_id": "PDD-E",
  "duration_override_weeks": 6 | null,
  "start_not_before_week": 40 | null,
  "effective_duration_weeks": 6,
  "recalc_status": "queued" | "deferred" | "not_needed" | "unchanged",
  "schedule_run_id": "uuid|null",
  "baseline_run_id": "uuid|null",
  "task_id": "str|null"
}
```

Errors:

| Status | Code | When |
|---|---|---|
| 409 | `PROJECT_FROZEN` | |
| 409 | `NOT_SCHEDULABLE` | The status is not schedulable. The fields are still not saved. |
| 409 | `STEP_DONE` | Any change to a Done step. |
| 409 | `STEP_STARTED` | Setting `start_not_before_week` on an In Progress or Blocked step. |
| 409 | `STEP_SKIPPED` | The lead time is 0. |
| 422 | `VALIDATION_ERROR` | Range, or an unknown `step_id` for the project's workflow. |

- `unchanged` returns before any write.
- Otherwise the endpoint writes the fields, sets `schedule_stale`, writes audit
  `project.step_timing` with `{step_id, before:{…}, after:{…}}`, and dispatches a greedy run through
  the **same** `services/run_dispatch.py` path as the priority move: `trigger_reason="step_timing"`,
  `deferred` when a run is in flight, and the advisory lock.
- After that the UI follows the SSE run and shows the P11 "Timeline updated" panel via
  `GET /schedule-runs/{run}/changes?against=`.

`GET /gantt` step rows are **extended** with these fields:

```jsonc
"lead_time_weeks": 4,                    // table value
"duration_override_weeks": 6 | null,
"start_not_before_week": 40 | null,
"timing_editable": "move_resize" | "resize" | "none"
```

`timing_editable` is computed server-side from the ADR 0019 §4 rules **and** the caller's GANTT
write permission on that project. `duration_weeks` on the row is the effective duration.

The Gantt project row is **extended** with `"is_vip": bool` and `"tracking_status": "live" |
"due" | "overdue" | "idle"`. Backend B owns the service that computes `tracking_status`, and backend
A calls it.

## 4. Global hub filter (backend A)

These endpoints gain an optional `hub_id: uuid` query parameter. It is ANDed with
`hub_scope_filter`, never widens it, and an out-of-scope hub gives empty or zero results, not a 403:
- `GET /dashboard/pipeline-totals`
- `/dashboard/status-overview`
- `/dashboard/hub-type-pipeline`
- `/dashboard/completing-within-year`
- `/dashboard/projects`, which already has it
- `/dashboard/capacity-booked`, if it exists under that name (P11 card source), and any other
  `/dashboard/*` GET
- `GET /capacity/hub-load` (and `/capacity/hubs`): hub rows filtered, and `areas[]` reduced to the
  area containing that hub. Region-level lab figures stay region-wide (ADR 0020 §4).
- `GET /capacity/class-breakdown`, `/capacity/utilization-matrix`
- `GET /priorities`, which already has it; `/priorities/summary`
- `GET /gantt`, which already has it
- All P12 endpoints in §2, §5 and §6.

No new `/me` field is needed. It already serves `hub_scope_all`, `hub_ids` and `engineer_id`.

## 5. Weekly check-in (backend B)

### `GET /check-ins/due?hub_id=`

Returns the stages due for the caller this week (ADR 0021 §1, §3).

```jsonc
{
  "week": 31,                            // CURRENT_WEEK
  "summary": {
    "due_stages": 9, "checked_in_stages": 4,
    "projects_live": 2, "projects_due": 3, "projects_overdue": 1,
    "stale_projects": 2                  // projects with schedule_stale = true among these (for planners' Recalculate hint)
  },
  "projects": [
    {
      "project_id": "uuid", "name": "str", "hub": "str", "hub_id": "uuid",
      "tracking_status": "live" | "due" | "overdue" | "idle",
      "schedule_stale": false,
      "stages": [
        {
          "step_id": "PDD-E", "step_name": "Design Detailing", "kind": "design",
          "status": "In Progress", "percent_complete": 40, "blocked_reason": null,
          "planned_start_week": 28, "planned_end_week": 34,
          "plan_percent": 50,            // share of planned window elapsed at CURRENT_WEEK, 0..100, served (ADR 0021 §5)
          "checked_in_this_week": false,
          "last_checkin_week": 30 | null,
          "can_check_in": true
        }
      ]
    }
  ]
}
```

The response includes `can_check_in: false` stages only for readers such as the Executive Viewer.
Engineers see only their own stages.

### `POST /check-ins`

```jsonc
// request: one week's batch, 1..100 entries
{
  "entries": [
    { "project_id": "uuid", "step_id": "PDD-E",
      "status": "Not Started" | "In Progress" | "Blocked" | "Done",
      "percent_complete": 0..100,
      "blocked_reason": "str|null",
      "note": "str|null (≤1000)" }
  ]
}
// 200 response  (recalc fields added 2026-10-10, ADR 0023)
{ "week": 31, "accepted": 3, "projects_marked_stale": ["uuid", …],
  "recalc_status": "queued" | "deferred" | "not_needed",
  "schedule_run_id": "uuid|null", "baseline_run_id": "uuid|null", "task_id": "str|null" }
```

- The batch is atomic. Any invalid entry fails the whole batch with 422 `CHECKIN_INVALID` and
  `detail.errors: [{index, code, message}]`.
- Per-entry codes:
  - `NOT_DUE`
  - `FORBIDDEN_STAGE`, which is also returned when the stage is outside scope, so it does not leak
    existence
  - `STEP_DONE_IMMUTABLE`: a Done stage cannot be re-reported
  - `INCONSISTENT_PROGRESS`: the DOMAIN_RULES progress rules
  - `PROJECT_FROZEN`
- Server fills:
  - on the first move out of Not Started, `actual_start_week = CURRENT_WEEK`;
  - on Done, `actual_end_week = CURRENT_WEEK` and `percent = 100`.
- Effects:
  - writes the `ProjectWorkflowStep` progress fields;
  - appends a `stage_checkins` row for each entry;
  - sets `schedule_stale` on each changed project;
  - writes one audit row per project (`project.check_in`).
- *(Amended by ADR 0023)* One greedy run per batch is dispatched through `services/run_dispatch.py`
  (`trigger_reason="check_in"`), `not_needed` when no progress field of a schedulable project changed.
- Rate limit: reuse `services/rate_limit.py`.

### `GET /check-ins/history?project_id=&step_id=`

Returns the stage's own check-in history, newest first, at most 52 rows. The permission is the same
as reading that project's Workspace.

```jsonc
[ { "week": 30, "status": "In Progress", "percent_complete": 30, "blocked_reason": null,
    "note": "str|null", "by": "Full Name", "created_at": "iso" } ]
```

### Tracking status service

Backend B adds `services/tracking.py` with
`async def tracking_status_for(db, project_ids) -> dict[uuid, TrackingStatus]`, which implements
ADR 0021 §4. The Priority board, VIP, Gantt and Projects payloads all reuse it.

`GET /dashboard/projects` rows are **extended** with `is_vip` and `tracking_status`, for the
Projects cards.

## 6. VIP projects (backend B)

### `GET /vip-projects?year=plan|next&hub_id=&limit=15`

Permission: `DASHBOARD` READ, hub-scoped. `limit` is in 10..15, default 15.

```jsonc
{
  "run_id": "uuid|null",
  "year": "plan" | "next",
  "week_range": [1, 52],
  "limit": 15,
  "hubs": [
    {
      "hub_id": "uuid", "hub": "R&D-Greece",
      "pinned_count": 3, "over_limit": false,
      "projects": [
        {
          "rank": 1, "selection": "pinned" | "auto",
          "project_id": "uuid", "name": "str", "category": "A" | null,
          "priority": "P1" | null, "score": 81.2 | null,
          "expected_end_week": 44 | null, "projected_end_week": 47 | null,
          "within_year": true | null,
          "health": "on_track" | … | null,
          "progress_pct": 35 | null,
          "current_stage": { "step_id": "PDD-E", "step_name": "Design Detailing", "status": "In Progress" } | null,
          "tracking_status": "live" | "due" | "overdue" | "idle"
        }
      ]
    }
  ]
}
```

- Hubs are listed in name order, with only hubs in scope (or filtered by `hub_id`) and with at
  least one in-year project.
- Ranking follows ADR 0022 §3.
- `current_stage` is the first non-Done, non-skipped stage in sequence order.

### `PUT /projects/{project_id}/vip`

Permission: Registration WRITE, hub-scoped (same as the priority move), or an Admin-level grant.

```jsonc
// request
{ "is_vip": true }
// 200
{ "project_id": "uuid", "is_vip": true }
```

- An unchanged value is a no-op with no audit row.
- A changed value writes audit `project.vip_pin` or `project.vip_unpin`.
- There is no recalc.

## 7. Frontend: shared client-side pieces, decided here so both frontend builders agree

- **`src/stores/hub-filter.ts`** (frontend-builder **A** creates it first):
  ```ts
  interface HubFilterState { hubId: string | null; setHubId: (id: string | null) => void }
  export const useHubFilterStore: UseBoundStore<StoreApi<HubFilterState>>; // zustand + persist, name 'rpd-hub-filter'
  export function useHubFilter(): { hubId: string | null; setHubId: (id: string | null) => void };
  ```
  Every surface passes `hub_id: hubId ?? undefined` and puts `hubId` in its query key.
- **Nav entries** (frontend-builder **B** adds them to `src/app/nav.ts` and the router):
  - `/vip` "VIP projects" (Plan, `dashboard`), placed directly after Dashboard;
  - `/priority-board` "Priority board" (Plan, `matrix`), placed after Prioritization;
  - `/check-in` "Weekly check-in" (Execute, `project_workspace`), placed after Timeline.
- **The tracking chip** `src/components/shared/tracking-status-chip.tsx` (frontend-builder **B**
  creates it; A uses it on the Gantt row):
  ```ts
  export function TrackingStatusChip(props: { status: 'live' | 'due' | 'overdue' | 'idle'; className?: string }): JSX.Element;
  ```
  Labels: Live, Due this week, Overdue, No active stage.
- **The VIP badge** `src/components/shared/vip-badge.tsx` (B creates it; A uses it on the Gantt row):
  `export function VipBadge(props: { className?: string }): JSX.Element`.

## 8. Coalesced follow-up run (ADR 0023, added 2026-10-10 — backend B owns it)

- `services/run_dispatch.py` gains a durable follow-up request (one row/flag in Postgres, created in
  migration `p12b_vip_checkins`; never Redis-only). Setting and clearing happen under the existing
  dispatch advisory lock.
- `priority_move`, `step_timing` and `check_in` set it whenever they answer `deferred`. Response shapes
  are unchanged.
- When an activated run finishes (success, failure) and when `workers/schedule_run_sweeper.py` sweeps a
  stuck run, the worker clears the flag and, if it was set, dispatches exactly one greedy run with
  `trigger_reason="follow_up"`, `activate=True`.
- The explicit Workspace Recalculate is unchanged (409 in flight, no follow-up).
- Frontend: on `deferred`, show "Saved — the timeline updates automatically after the current
  recalculation", poll the existing endpoint that serves the active run id (every 5 s, give up after
  3 min) and invalidate the active-run-backed queries when it changes. The P11 move control's
  `deferred` copy changes the same way.
