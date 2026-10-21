# API contract: P25, P1 capacity fill (ADR 0036)

Owner: backend-builder (P25-T01, §5 P25-T03). Consumer: frontend-builder (P25-T02, §5 P25-T04). Date: 2026-10-21.
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

## 5. Board, Workspace and Matrix export (P25-T03, 2026-10-21)

*(Revised by P25-T03. Before it, this section said the board, the Workspace and the export still
used the stored score band.)* The fill is served everywhere a band is shown, from the same one-pass
loader (`services/priority_capacity_fill.py`), so a project's four fill fields are **identical** on
its Matrix row, its board card, its Workspace score section and its export row. Hub scoping is
unchanged: only the rows shown are scoped, and the walk for each shown hub uses every project of
that hub (§1).

**5a. `PriorityBoardCard` (`GET /priority-board`)**, additive:

| Field | Type | Meaning |
|---|---|---|
| `external_code` | string \| null | **new**: the project's external code (null if none), for telling apart similar names in the List layout |
| `suggested_band` | `"P1".."P4" \| null` | **new**: the promoted band, as §1 |
| `score_band` | `"P1".."P4" \| null` | **new**: the pure score band, as §1 |
| `capacity_fill` | boolean | **new**, as §1 |
| `capacity_fill_reason` | string \| null | **new**, as §1 |
| `band` | `"P1".."P4" \| null` | **unchanged**: the stored score band (always equal to `score_band`); kept for existing clients |

Columns stay keyed by the **committed** `Project.priority`: a promoted card stays in its committed
column, and column `count`, `design_weeks` and `lab_weeks` are unchanged.

**5b. `WorkspacePriorityScore` (`GET /projects/{id}/workspace` → `priority_score`)**:
`suggested_band` **changes meaning** to the promoted band (as on Matrix rows), and `score_band`,
`capacity_fill`, `capacity_fill_reason` are **new**, as §1. `priority_score` stays null for an
unscored project.

**5c. `GET /exports/matrix` (CSV / XLSX, `Matrix` sheet)**:

| Column | Meaning |
|---|---|
| `suggested_band_after_capacity_fill` | the row's promoted `suggested_band`. **Renamed** from `suggested_band` so the header says it is the band after the P1 capacity fill |
| `score_band` | **new**: the pure score band |
| `capacity_fill` | **new**: `True` / `False` |
| `capacity_fill_reason` | **new**: the served reason text, empty when null |

The four columns are adjacent, in that order. Every other column is unchanged; nested fields
(`dimension_points`, `dimension_scores`) stay out; text cells keep the formula-injection guard.

**Still not changed:** committed priority (`set_priority`, `Project.priority`), stored scores and
the stored `PriorityScore.suggested_band`. Project cards (`services/project_cards.py`) are an
internal helper and still carry the stored band. Nothing here writes, audits or schedules.

## 6. Contract-test rows (`backend/tests/test_openapi_frontend_contract.py`)

| TS (`frontend/src/surfaces/matrix/api/types.ts`) | Backend schema | Mode | Red until the frontend… |
|---|---|---|---|
| `PriorityMatrixRow` | `PriorityMatrixRow` | exact | adds `score_band`, `capacity_fill`, `capacity_fill_reason` |
| `PriorityCompareProject` | `PriorityCompareItem` | exact | adds the same three |
| `PriorityDistribution` | `PriorityDistribution` | exact | adds `capacity_fill_count` |
| `PriorityPortfolioSummary` | `PriorityPortfolioSummary` | exact | adds `score_band_counts`, `capacity_fill_count` |
| `HubP1Fill` | `HubP1Fill` | exact | declares it (new) |
| `PriorityCapacityFill` | `PriorityCapacityFill` | exact | declares it (new) |

P25-T03 rows (red until P25-T04 mirrors them; the six rows above are green since P25-T02):

| TS | Backend schema | Mode | Red until the frontend… |
|---|---|---|---|
| `PriorityBoardCard` (`frontend/src/surfaces/priority-board/api.ts`) | `PriorityBoardCard` | exact | adds `external_code`, `suggested_band`, `score_band`, `capacity_fill`, `capacity_fill_reason` |
| `WorkspacePriorityScore` (`frontend/src/surfaces/project-workspace/api/types.ts`) | `WorkspacePriorityScore` | exact, plus `test_section7_nullability_matches_exactly` | adds `score_band` and `capacity_fill_reason` (both `\| null`) and `capacity_fill` |

The export has no contract row (CSV / XLSX); its columns are pinned by
`backend/tests/test_p25_t03_fill_surfaces.py`.
