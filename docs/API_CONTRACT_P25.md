# API contract: P25, P1 capacity fill (ADR 0036)

Owner: backend-builder (P25-T01). Consumer: frontend-builder (P25-T02). Date: 2026-10-21.
Rules: `docs/DOMAIN_RULES.md` "Prioritization scoring" → "P1 capacity fill"; ADR 0036.

Everything here is **additive**, with one change of meaning: `suggested_band` on matrix rows and
compare items is now the band **after** the P1 capacity fill. The pure score band moves to the new
`score_band`. All endpoints are read only, need Matrix read permission, and are hub-scoped as before.
No financial field is read or served by the fill.

## 1. Row fields: `PriorityMatrixRow` (`GET /priorities`, `GET /priorities/{id}`) and `PriorityCompareItem` (`GET /priorities/compare`)

| Field | Type | Meaning |
|---|---|---|
| `suggested_band` | `"P1".."P4" \| null` | **changed meaning**: `"P1"` when `capacity_fill` is true, else `score_band`. Null when unscored |
| `score_band` | `"P1".."P4" \| null` | **new**: the pure score band (≥ 70 P1, ≥ 55 P2, ≥ 40 P3, else P4); null when unscored |
| `capacity_fill` | boolean | **new**: promoted to P1 by the hub's capacity fill. Label the band "P1 (capacity fill)" |
| `capacity_fill_reason` | string \| null | **new**: short reason, for display as served (do not parse) |

`capacity_fill_reason` is set for every candidate the walk decided on, and null otherwise (base P1
projects, candidates after the stop, excluded statuses, unscored, no active run):

| Walk outcome | `capacity_fill` | Reason text |
|---|---|---|
| promoted | true | `P1 (capacity fill): hub P1 design load 9.00 of 10.00 weeks with this project` |
| stopped (first that would exceed) | false | `Not promoted: hub P1 design load would be 11.00 of 10.00 weeks` |
| skipped, no remaining design work | false | `Not promoted: no remaining design work in the active run` |

A row's fill does not depend on the request's filters: the walk always uses every project of the
row's hub (ADR 0036 §5).

## 2. `GET /priorities/capacity-fill` (new)

Query: `hub_id`, `region` (the global hub / country filter, ANDed with the scope, never widening; out
of scope → `hubs: []`, not 403). Response `PriorityCapacityFill`, hubs in the same order as
`GET /capacity/hub-load` rows (`Hub.name` order):

```json
{
  "has_active_schedule_run": true,
  "schedule_run_version": 12,
  "hubs": [
    {"hub": "R&D-Greece", "capacity_weeks": 10.0, "base_load_weeks": 6.0,
     "filled_load_weeks": 9.0, "promoted_count": 1}
  ]
}
```

`HubP1Fill` (effort weeks, ADR 0032, 2 dp):

| Field | Meaning |
|---|---|
| `hub` | hub name |
| `capacity_weeks` | `C`: equals `GET /capacity/hub-load` `rows[hub].design_capacity_remaining` |
| `base_load_weeks` | `L`: Σ remaining design weeks (active run) of the hub's score-band-P1 projects |
| `filled_load_weeks` | `L` + the promoted projects' weeks; equals `base_load_weeks` when nothing is promoted |
| `promoted_count` | number of projects of the hub with `capacity_fill: true` |

With no active run: `has_active_schedule_run: false`, `schedule_run_version: null`, every hub has
its `capacity_weeks`, and `0.0` / `0.0` / `0` for the rest. Overfull hubs have
`base_load_weeks > capacity_weeks` and `promoted_count: 0`.

## 3. `GET /priorities/distribution` (changed)

| Field | Change |
|---|---|
| `band_distribution` | counts and shares now use the **promoted** `suggested_band` (the row field), so `Σ rows with suggested_band = X` = bucket X for the same query |
| `capacity_fill_count` | **new**: how many rows of this filtered set are `capacity_fill: true` (they are inside the P1 bucket) |

`score_histogram` is unchanged (scores).

## 4. `GET /priorities/summary` (changed)

| Field | Change |
|---|---|
| `suggested_band_counts` | now counts the **promoted** band |
| `score_band_counts` | **new**: counts of the pure score band |
| `capacity_fill_count` | **new**: promoted projects in scope |

## 5. Not changed

Committed priority (`set_priority`, `Project.priority`), stored scores, the priority board, project
cards, the Workspace, and `GET /exports/matrix` still use the stored score band. Nothing here writes,
audits or schedules.

## 6. Contract-test rows (`backend/tests/test_openapi_frontend_contract.py`)

| TS (`frontend/src/surfaces/matrix/api/types.ts`) | Backend schema | Mode | Red until the frontend… |
|---|---|---|---|
| `PriorityMatrixRow` | `PriorityMatrixRow` | exact | adds `score_band`, `capacity_fill`, `capacity_fill_reason` |
| `PriorityCompareProject` | `PriorityCompareItem` | exact | adds the same three |
| `PriorityDistribution` | `PriorityDistribution` | exact | adds `capacity_fill_count` |
| `PriorityPortfolioSummary` | `PriorityPortfolioSummary` | exact | adds `score_band_counts`, `capacity_fill_count` |
| `HubP1Fill` | `HubP1Fill` | exact | declares it (new) |
| `PriorityCapacityFill` | `PriorityCapacityFill` | exact | declares it (new) |
