# API contract: P38, deactivate engineers instead of deleting them (ADR 0053)

*Updated at P38-T02 (2026-11-17) with the workflow-auditor's ruling R38-1..R38-9. Binding.*

This is a short note. Only the endpoints and fields listed here change. **"Week"** means the
**calendar** week from `plan_clock` (the constant until P37-T04 lands; R38-7). **"Open project"** means a project the engineer leads whose status is not Commercialized or
Cancelled. **Admin** means the Admin or Super Admin role.

## 1. Engineer reads

`EngineerRead` (every endpoint that returns it) gains:

| Field | Type | Meaning |
|---|---|---|
| `active` | bool | False once deactivated. |
| `deactivated_at` | ISO-8601 datetime \| null | When. |
| `deactivated_week` | int 1..52 \| null | Calendar week of the deactivation (it counts as worked). |
| `deactivated_plan_year` | int \| null | The served `plan_year`, not the ISO year. While `plan_year_closed`, the week is recorded as 52. |
| `deactivation_reason` | `"left_company"` \| `"changed_role"` \| `"long_absence"` \| `"other"` \| null | Code only, never free text. |

`deactivated_by_user_id` is in the audit row only. It is not served.

`GET /engineers` gains `?status=active|inactive|all` (default **`active`**). An unknown value is
422. Hub scoping is unchanged. `GET /engineers/{id}` returns an inactive engineer too.

## 2. Deactivation

### `GET /engineers/{id}/deactivation-preview` (Admin)

```json
{
  "engineer": { "id": "…", "name": "…", "hub": "R&D-Greece", "active": true },
  "deactivation_week": 47,
  "has_linked_login": true,
  "open_projects": [
    { "project_id": "…", "name": "…", "hub": "OEM-HCK", "status": "In Development",
      "priority": "P1", "category": "A", "schedulable": true, "frozen": false,
      "progress_tracked": true, "done_stages": 4, "in_flight_lab": false,
      "candidates": [ { "engineer_id": "…", "name": "…", "fte": 1.0, "load_weeks": 12 } ] }
  ],
  "supply_effect": {
    "capacity_hub": "R&D-Greece",
    "yearly_design_capacity": { "before": 412.5, "after": 398.1 },
    "remaining_design_capacity": { "before": 38.0, "after": 33.2 }
  },
  "led_projects_token": "…"
}
```

- `candidates`: **eligible active engineers of the project's capacity hub**, excluding the
  engineer being deactivated. Eligible means FTE > 0 and the scheduler's own category predicate
  `greedy._cat_not_allowed` passes (R38-3): the category is in `allowed_categories`, or, for an
  OEM hub, the `OEM` marker or the project's own OEM-workflow category. Sorted by remaining run-booked load
  ÷ FTE, then by name. The list may be empty. The dialog then shows "No eligible engineer in
  R&D-Greece", and the row can only be left empty. For example, 3 of Theoni's 6 schedulable
  projects have no candidate (OQ #103).
- `progress_tracked`, `done_stages` (count of Done stages) and `in_flight_lab` (a lab stage In
  Progress or Blocked) drive the dialog's warning copy (R38-3).
- `frozen: true` rows cannot be left empty (below).
- `led_projects_token`: an opaque hash of the sorted open-project id set. It is not a secret.
- `supply_effect` is present only when `counts_in_capacity` is true. It is computed with the
  R38-1 helper at the response's calendar week.
- Errors: 403 `ENGINEER_STATUS_ADMIN_ONLY`; 404 when the engineer is unknown or out of scope;
  409 `ENGINEER_ALREADY_INACTIVE`.

### `POST /engineers/{id}/deactivate` (Admin)

```json
{
  "reason": "left_company",
  "led_projects_token": "…",
  "reassignments": [
    { "project_id": "…", "leader_engineer_id": "…" },
    { "project_id": "…", "leader_engineer_id": null }
  ]
}
```

- `reassignments` must name **exactly** the current open-project set. A `null` leader means
  "leave with no leader" (the "Deactivate anyway" rows). The dialog's "Use one leader for all"
  control only fills rows on the client. The server sees per-project rows.
- A `null` row on a **frozen** project returns 422 `FROZEN_NEEDS_LEADER` with the row index. The
  fix is to unfreeze on the Gantt first (R38-3, OQ #101).
- A non-null target must be an existing **active** engineer with FTE > 0, other than this one.
  Otherwise 422 `LEADER_INACTIVE` or `UNKNOWN_LEADER`, with the row index. A target outside
  the capacity hub, or a target that fails `CAT_NOT_ALLOWED`, is accepted (the same rule as a
  leader PATCH) and reported in `warnings`.
- One transaction:
  - set the engineer inactive and open the inactive period;
  - apply every row: set the leader or NULL, `leader_is_provisional = false`, `schedule_stale`
    for a schedulable project, and one `project_leader_history` row;
  - write the audit rows (`engineer.deactivate`, and one `project.update` per project with
    `cause = "engineer_deactivated"`).
- After the commit, one greedy run is dispatched (`queued` / `deferred`, ADR 0023, week read
  when the QUEUED row is created) **iff** (a) a schedulable project changed leader, or (b) the
  active run has a design row assigned to this engineer that ends after `deactivated_week`
  (R38-5). Otherwise the status is `not_needed`.
- Lock order (R38-5):
  - the engineer row first: `FOR UPDATE` here and in reactivate, `FOR SHARE` in every leader
    write that names an engineer;
  - then project rows in `project_id` order;
  - no band-rank lock. A leader change keeps `band_rank`, and a project cleared to NULL keeps its
    rank (R38-8).

Response 200:

```json
{
  "engineer": { "…EngineerRead…" },
  "reassigned": 5,
  "left_without_leader": 2,
  "left_without_leader_project_ids": ["…", "…"],
  "warnings": [ { "project_id": "…", "code": "CAT_NOT_ALLOWED" } ],
  "run": { "status": "queued" , "run_id": "…" }
}
```

- `run.status`: `queued` | `deferred` (ADR 0023 follow-up) | `not_needed` (neither condition
  (a) nor (b) holds). `run_id` is null unless the status is `queued`.
- **Dialog warning copy** (frontend, verbatim):
  - always, when any row is empty: *"These N projects will have no leader. They will not be
    scheduled (Left out: no leader) until someone sets a leader."*
  - added when any empty row has `progress_tracked` or `in_flight_lab`: *"Their recorded stages
    will not show on the Gantt, and any lab test in progress gives up its chamber in the plan,
    until someone sets a leader."*
- Errors: 403 `ENGINEER_STATUS_ADMIN_ONLY`; 404; 409 `ENGINEER_ALREADY_INACTIVE`;
  422 `FROZEN_NEEDS_LEADER`;
  409 `LED_PROJECTS_CHANGED`, when the token or the id set differs from the set found under
  lock (body: the fresh `open_projects`); 422 as above; 503
  `ENGINEER_STATUS_BUSY` on lock timeout (the same pattern as `BAND_RANK_BUSY`).
- The lookup, authz and rate limit run before any lock (P36-R01 pattern).

### `POST /engineers/{id}/reactivate` (Admin)

The body is empty. It closes the open period and sets `active = true`. It does not give back
projects that were reassigned or cleared. No run is dispatched, and supply updates at once. Audit
`engineer.reactivate`. Errors: 403, 404, 409 `ENGINEER_ALREADY_ACTIVE`.

## 3. Changed writes

| Endpoint | Change |
|---|---|
| `DELETE /engineers/{id}` | **410 `ENGINEER_DELETE_RETIRED`** for every caller with Capacity Planning write. Nothing is deleted or audited. Callers without that permission keep getting 401 / 403. |
| `PATCH /engineers/{id}` on an inactive engineer | Only `name` is accepted. Any other field returns 409 `ENGINEER_INACTIVE`. |
| `POST /projects` (register), `PATCH /projects/{id}`, the register batch save, bulk edit | `leader_engineer_id` naming an inactive engineer returns 422 `LEADER_INACTIVE`. Unchanged when the field is not written: a closed project keeps its inactive leader. |
| Same endpoints, plus client re-import and the seed: a **reopen** (status leaves Commercialized / Cancelled) | If the stored leader is inactive, the same write must set `leader_engineer_id` (active or `null`). Otherwise 422 `LEADER_INACTIVE` on `leader_engineer_id` (R38-4). |
| User form, the engineer link | Linking an inactive engineer returns 422 `ENGINEER_INACTIVE`. |
| What-if plan import | A row naming an inactive engineer (with or without the export's " (inactive)" suffix) is matched, then warned `ENGINEER_INACTIVE` and auto-assigned as "no engineer given". It is never a new hypothetical engineer. The "keep the matched project's leader" branch uses active engineers only (R38-2). |

## 4. Served engineer names gain an `active` flag

Wherever an engineer name is served, a sibling bool is added. It is `true` for active engineers,
and it is withheld wherever the name is withheld (OQ #8 / P13):

- `leader_active`: project cards, the register rows, Priority / VIP board cards, Dashboard
  project lists, Workspace header, Gantt rows, run changes.
- `assigned_engineer_active`: Gantt and Workspace stage rows.
- `active`: utilization matrix rows, engineer utilization, resource load rows, and the
  `/resource-load/options` and project leader filter options (inactive engineers come after
  the active ones).
- Workspace header: `former_leaders: [{ name, active, until_week }]` from
  `project_leader_history`, under the same name rule.
- Exports: the leader cell reads `Name (inactive)`. There is no new column.
- Audit log: the entity label is unchanged. `before_state` / `after_state` gain `active`,
  `deactivated_week` and `deactivation_reason`.

The utilization endpoints (`/capacity/utilization-matrix`, `/capacity/engineer-utilization`,
`/planning/resource-load`) gain `?include_inactive=false` (default). With `true`, inactive
engineers are listed with 0 capacity in every week their periods cover (R38-1).

The project leader filter gains a `no_leader` option if it does not exist yet.

## 5. Capacity figures

The supply formulas follow ADR 0053 §4 / R38-1 (the `A_e` helper). They are byte-identical while
no inactive period exists.

- Capacity hub rows gain `inactive_engineers` (int). `counted` and `not_counted` now count active
  engineers only, and the three sum to the roster.
- The P1 capacity fill's `C` is the served `design_capacity_remaining` (its own query is retired).
- The What-if `capacity_before` / `utilization_before` and the plan-import weekly supply equal the
  Capacity figures (I43; `test_p18_r02`) through the `WhatIfBaseline` supply-only field (P38-T03).
  Their response shapes do not change.
- Per-engineer utilization capacity is 0 in every week a period covers.

## 6. Permissions summary

| Role | Preview / deactivate / reactivate | Roster `status=inactive` |
|---|---|---|
| Super Admin, Admin | yes | yes |
| Hub Planner | 403 (OQ #93) | yes (own hub) |
| Portfolio Manager | 403 | yes (read) |
| Others | 403 (no Capacity Planning read) | 403 |
