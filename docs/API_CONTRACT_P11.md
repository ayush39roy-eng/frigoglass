# P11 API contract — shared by backend-builder (P11-T01) and frontend-builder (P11-T02)

Written 2026-10-09 by the orchestrator so the two can build in parallel. Same rules as
`docs/API_CONTRACT_P9.md`:
- backend-builder implements these shapes exactly (Pydantic v2 strict, `extra="forbid"` on
  requests);
- frontend-builder writes `// PLACEHOLDER` TS mirrors and reconciles them against the regenerated
  OpenAPI before closing;
- any deviation is recorded in `docs/MEMORY.md`, never silently diverged.

ADRs: 0015 (priority move), 0016 (booked %), 0017 (On Hold label). Existing shapes are unchanged
unless marked *extended*.

## 1. Priority move — `POST /projects/{project_id}/priority`  (new)

Permission: same as `PATCH /projects/{id}`, meaning `PROJECT_REGISTRATION` WRITE, hub-scoped, or an
Admin-level project grant (`authorize_project_action(..., min_grant_role="admin")`).

```jsonc
// request
{ "priority": "P1" | "P2" | "P3" | "P4" | "Q" }

// 200 response (always 200; recalc_status says what happened)
{
  "project_id": "uuid",
  "priority_before": "P1" | … | null,
  "priority_after":  "P2",
  "recalc_status": "queued" | "deferred" | "not_needed" | "unchanged",
  "schedule_run_id":  "uuid|null",   // set only when queued
  "baseline_run_id":  "uuid|null",   // the run active before the move; null if none / not queued
  "task_id":          "str|null"     // celery task id, set only when queued
}
```

- `queued`: the priority is saved and a greedy run has been dispatched (`trigger_reason=
  "priority_move"`, `activate=True`). Follow it on the existing SSE stream `GET
  /schedule-runs/{schedule_run_id}/progress`.
- `deferred`: the priority is saved, but another run was already queued or running. The project
  stays `schedule_stale`. This is not an error.
- `not_needed`: the priority is saved, but the project status is not schedulable.
- `unchanged`: the requested value equals the current one. Nothing is written.

Errors:
- 409 `HARD_GATE_FORCES_P1`: the project has hard gates and the target is not P1.
- 403 / 404: as for PATCH.
- 422: bad body.

## 2. `PATCH /projects/{project_id}`  (*extended*)

The body is unchanged. When `priority` changes, the same logic as §1 runs, including the
`HARD_GATE_FORCES_P1` 409. The response body stays `ProjectRead`, with these response headers
added:

```
X-Schedule-Recalc:            queued | deferred | not_needed     (absent when priority did not change)
X-Schedule-Run-Id:            <uuid>                             (only when queued)
X-Schedule-Baseline-Run-Id:   <uuid>                             (only when queued and a run was active)
```

Add these headers to the CORS `expose_headers` list next to `X-Schedule-Stale-Count`.

## 3. Run-to-run changes — `GET /schedule-runs/{run_id}/changes?against={baseline_run_id}`  (new)

Permission: the same `_read_any` dependency as `GET /schedule-runs`. Rows are hub-scoped through
`hub_scope_filter` on `Project.hub_id`.

Responses:
- 404 when either run does not exist.
- 409 `RUN_NOT_COMPLETED` when `run_id` is not `COMPLETED`.

```jsonc
{
  "run_id": "uuid", "run_version": 42,
  "against_run_id": "uuid", "against_run_version": 41,
  "hidden_count": 3,               // changed projects outside the caller's hub scope (count only)
  "rows": [                        // only projects whose compared fields differ; sorted by
    {                              // |delta_weeks| desc (null last), then project_name
      "project_id": "uuid", "project_name": "…", "hub": "PD-India",
      "priority": "P2",            // the project's live priority now
      "before_projected_end_week": 40 | null, "after_projected_end_week": 46 | null,
      "delta_weeks": 6 | null,     // after − before; null if either is null
      "before_within_year": true,  "after_within_year": true,
      "before_left_out": false,    "after_left_out": false,
      "before_blocked": false,     "after_blocked": false,
      "is_new": false,             // true if the project has no outcome row in the baseline run
      "is_removed": false          // true if it has none in the new run
    }
  ]
}
```

Compared fields: `projected_end_week`, `within_year`, `left_out`, `blocked`. Only stored values are
used. Nothing is recomputed.

## 4. Capacity — `GET /capacity/hubs` (alias `/capacity/hub-load`)  (*extended*)

`HubCapacityRow` gains:

```jsonc
"design_booked_pct_year": 92.31 | null,  "design_booked_pct_remaining": 131.2 | null,
"lab_booked_pct_year":    48.0  | null,  "lab_booked_pct_remaining":    67.4  | null,
"design_booking_status_year": "available" | "near_full" | "full",
"design_booking_status_remaining": "…",
"lab_booking_status_year": "…",  "lab_booking_status_remaining": "…",
"area": "Europe" | "India"
```

`HubCapacitySummary` gains (numbers below are illustrative):

```jsonc
"near_full_threshold_pct": 85, "full_threshold_pct": 100,
"areas": [
  {
    "area": "Europe",
    "hubs": ["R&D-Greece", "PD-Romania"],        // in-scope hubs only
    "lab_regions": ["Greece", "Romania"],        // in-scope regions only
    "design_load_weeks": 210, "design_capacity_year": 289.9, "design_capacity_remaining": 193.2,
    "lab_load_weeks": 140.0,  "lab_capacity_year": 289.26,   "lab_capacity_remaining": 205.82,
    "design_booked_pct_year": 72.44 | null, "design_booked_pct_remaining": 108.7 | null,
    "lab_booked_pct_year": 48.4 | null,     "lab_booked_pct_remaining": 68.02 | null,
    "design_booking_status_year": "available", "design_booking_status_remaining": "full",
    "lab_booking_status_year": "available",    "lab_booking_status_remaining": "available"
  },
  { "area": "India", … }
]
```

Formulas (ADR 0016):
- `booked_pct = load / capacity × 100`, rounded to 2 dp. It is null when capacity == 0.
- Status:
  - `full` when booked_pct ≥ 100, or when capacity == 0 and load > 0;
  - `near_full` when 85 ≤ booked_pct < 100;
  - `available` otherwise.
- Area lab sums count each lab region **once**.
- Areas are ordered Europe, then India. An area with no in-scope hub is omitted.
- Every figure is rounded to 2 dp with the existing `round2`.

## 5. On Hold labels  (ADR 0017)

The wire values are unchanged: `"Blocked"`, `blocked`, `blocked_count`, `blocked_reason`,
`"stage_blocked"`, and the health value `"blocked"`. Server-generated **text** changes:

- notification message: `Project "X" (Hub): stage PDD-F Proof of Concept is on hold — <reason>`;
- Workspace activity summaries say "on hold" / "On Hold";
- the Ask-the-agent context renders stage status `Blocked` as `On Hold` and the reason key as
  `hold_reason`;
- Excel exports, if they carry stage status, write `On Hold`.

Notifications stored before this change keep their old text.
