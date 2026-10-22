# API contract: P26, editable scoring rubric (ADR 0037)

Owner: backend-builder (P26-T01). Consumer: frontend-builder (P26-T02). Date: 2026-10-22.
Rules: `docs/DOMAIN_RULES.md` "Prioritization scoring"; ADR 0037 (also ADR 0029, 0033, 0036).

The rubric (dimensions, pillars, weights, order) lives in tables and is edited in the
Prioritization Matrix by Admin / Super Admin. **Breaking** for the frontend: the 13 flat score
fields are gone from every row / score shape (§4, §5); scores are a `scores` map keyed by dimension
key; `dimension_scores` has one entry per ACTIVE dimension.

Error envelope (unchanged): `{"detail": string | [{loc, msg, type}], "code"?: string}`.

## 1. `GET /scoring-rubric` (Matrix read: PM, HP, EV, Admin, Super Admin; 403 Engineer / Auditor)

Response `ScoringRubricRead`:

```json
{
  "version": 1,
  "total_weight": 295,
  "changed_at": "2026-10-22T07:00:00Z",
  "changed_by_user_id": null,
  "changed_by_name": null,
  "reason": "Initial rubric: the 13 fixed dimensions of ADR 0029 / ADR 0033, migrated to tables (ADR 0037).",
  "dimensions": [
    {"id": "…", "key": "strategic_project", "label": "Strategic Project",
     "pillar": "Strategic Alignment", "weight": 25, "scaled_weight": 8.47,
     "inverted": false, "active": true, "display_order": 1},
    "… 13 in display order; inactive ones included with scaled_weight null …"
  ],
  "pillars": ["Strategic Alignment", "Regulatory & Quality", "Financial Return",
              "Investment & Feasibility", "Market & Volume"],
  "can_edit": false
}
```

| Field | Notes |
|---|---|
| `total_weight` | Σ weights of ACTIVE dimensions |
| `dimensions` | every dimension (active and inactive), ordered by `display_order` |
| `scaled_weight` | `weight × 100 / total_weight`, 2 dp; `null` for an inactive dimension |
| `inverted` | meaning only (CAPEX); no formula change |
| `pillars` | distinct pillar names, order of first appearance |
| `can_edit` | caller holds Admin or Super Admin |
| `changed_by_name` | the user's full name; null for the migrated version 1 |

`ScoringRubricDimension`: `{id: uuid | null, key, label, pillar, weight, scaled_weight: number | null,
inverted, active, display_order}` (`id` is null only in a preview, for a dimension that does not
exist yet).

## 2. `GET /scoring-rubric/versions` (same permission)

`ScoringRubricVersionsResponse {versions: ScoringRubricRead[]}`, newest first; each entry is that
version's snapshot (`dimensions`, `total_weight`, `reason`, who / when). `can_edit` is the caller's
current right.

## 3. `PUT /scoring-rubric` (Admin, Super Admin; others 403)

Full replacement. Body `ScoringRubricUpdateRequest` (strict: no coercion, extra keys forbidden):

```json
{
  "version": 1,
  "reason": "Raise New Models, add ESG",
  "dimensions": [
    {"key": "strategic_project", "label": "Strategic Project", "pillar": "Strategic Alignment",
     "weight": 25, "inverted": false, "active": true},
    "… every existing dimension, in the new order …",
    {"label": "Sustainability & ESG", "pillar": "Sustainability", "weight": 30}
  ]
}
```

| Field | Rule |
|---|---|
| `version` | integer ≥ 1, the version the admin edited. Not current → **409 `RUBRIC_VERSION_CONFLICT`** |
| `reason` | 1..500 chars after trimming, required |
| `dimensions` | 1..100 items; list position = new `display_order` |
| `dimensions[].key` | an existing key (pattern `^[a-z][a-z0-9_]*$`, ≤ 64) or omitted / null for a NEW dimension |
| `label` | 1..80 chars after trimming |
| `pillar` | 1..60 chars after trimming; a new name creates the pillar |
| `weight` | integer 1..100 (a string, float or boolean is 422) |
| `inverted`, `active` | booleans, default `false` / `true` |

New keys are slugified from the label (`"Sustainability & ESG"` → `sustainability_esg`; a leading
digit gets `d_`; empty → `dimension`), with `_2`, `_3`... on a collision with an existing key or a
Matrix row / export column name (e.g. `"Rank"` → `rank_2`). Keys never change afterwards.

Coded 422s (nothing saved):

| `code` | When |
|---|---|
| `RUBRIC_NO_ACTIVE_DIMENSION` | no dimension active |
| `RUBRIC_DIMENSION_MISSING` | an existing dimension is not listed (never deleted; send `active: false`) |
| `RUBRIC_UNKNOWN_KEY` | a `key` that does not exist (omit `key` to add) |
| `RUBRIC_DUPLICATE_KEY` | a key listed twice |
| `RUBRIC_DUPLICATE_LABEL` | two labels equal ignoring case |

Field-level violations are FastAPI's own 422 (no `code`).

Response: the new `ScoringRubricRead` (version N+1). In the same transaction:
- every project's `weighted_score`, `normalized_pct` and score band are recomputed and stamped with
  the new `rubric_version`;
- one `scoring_rubric.update` audit row is written (before / after versions, totals and
  dimensions, `reason`, `recomputed_scores`, `normalized_pct_changes`, `score_band_changes`).

An unchanged proposal returns 200 with the current version (no new version, no audit row).
Nothing is marked `schedule_stale` and no run starts.

## 4. `POST /scoring-rubric/preview` (Admin, Super Admin; others 403)

Body `ScoringRubricPreviewRequest {dimensions}`. It takes the same items and the same validation and
422 codes as the PUT. It has no `version` and no `reason`, and **nothing is saved**.
Response `ScoringRubricPreview`:

```json
{
  "current_version": 1, "current_total_weight": 295, "proposed_total_weight": 380,
  "dimensions": [ /* ScoringRubricDimension[], as it would be saved; new ones id null */ ],
  "scored_projects": 4,
  "score_band_change_count": 1,
  "suggested_band_change_count": 2,
  "band_changes": [{"from_band": "P3", "to_band": "P4", "count": 1}],
  "projects": [
    {"project_id": "…", "project_name": "Mid", "hub": "R&D-Greece",
     "old_normalized_pct": 63, "new_normalized_pct": 69,
     "old_score_band": "P2", "new_score_band": "P2",
     "old_suggested_band": "P2", "new_suggested_band": "P1", "new_capacity_fill": true,
     "score_band_changed": false, "suggested_band_changed": true,
     "missing_dimension_keys": ["rank_2"]}
  ]
}
```

- `projects`: the projects in the caller's scope that are scored under the current or the
  proposed rubric, ordered by name. Unscored-under-both projects are not listed.
- `*_suggested_band` and `new_capacity_fill`: after the P1 capacity fill (ADR 0036), computed with
  the same loader as Matrix rows.
- `band_changes`: score-band transitions; "Unscored" is used as a band when a project becomes
  scored or unscored.

After a PUT with the same dimensions, every `new_*` value equals the saved Matrix row (tested).

## 5. Changed shapes

**`PUT /priorities/{project_id}`** (Matrix write, as before). Body `PriorityScoreUpdateRequest`:

```json
{"scores": {"strategic_project": 4, "sustainability_esg": 3, "capex_investment": null},
 "hard_gates": []}
```

- Keys must be ACTIVE dimension keys; anything else is a 422 with
  `code: "UNKNOWN_DIMENSION_KEY"`.
- Values are integers 0..5 (strict) or null (clears that score).
- Active keys left out keep their stored value (null on a new row), and inactive dimensions'
  historic scores are never touched.
- The 13 flat fields are gone, and sending them is a 422 (extra keys are forbidden).
- The score is computed under the shared rubric lock.

Response `PriorityScoreRead`:

```json
{"id": "…", "project_id": "…", "hard_gates": [], "weighted_score": 177.0, "normalized_pct": 54,
 "suggested_band": "P3", "dimension_scores": [ /* DimensionScore[] */ ],
 "missing_dimension_keys": ["sustainability_esg"], "rubric_version": 2}
```

`suggested_band` here is the stored score band, null when no active dimension is scored. It is
unchanged since P3.

**`PriorityMatrixRow`** (`GET /priorities`, `GET /priorities/{id}`):
- **removed**: `strategic_project` … `capex_investment` (13 fields);
- **new**: `missing_dimension_keys: string[]`, `rubric_version: number`;
- `dimension_scores`: one entry per ACTIVE dimension in `display_order`;
- `dimension_points`: keyed by active keys, `{points: 0, scaled_points: 0}` for a missing score;
- `has_score`: true when at least one active dimension is scored.

**`PriorityCompareItem`**: **new** `missing_dimension_keys`, `rubric_version`.

**`WorkspacePriorityScore`** (`GET /projects/{id}/workspace` → `priority_score`, null when
unscored):
- **removed**: the 13 flat fields;
- **new**: `dimension_scores: DimensionScore[]`, `missing_dimension_keys: string[]`,
  `rubric_version: number`.

**`PriorityDimensionsResponse`** (`GET /priorities/dimensions`): only the ACTIVE dimensions, plus
**new** `rubric_version`.

**`ScenarioPriorityScoreChange`** (`POST /scenarios/apply` items): `{project_id, scores, hard_gates}`,
with `scores` as in the PUT above. Any non-active key fails the whole batch with a 422 and writes
nothing.

`DimensionScore` is unchanged: `{key, label, pillar, score, weight, points, max_points}`.
`score` and `points` are null for a missing dimension. `Σ points` (null counts 0) equals
`weighted_score`.

**Audit / scenario snapshots** of a score now hold `scores: {key: value}` and `rubric_version`
instead of 13 flat keys. Old rows keep the old shape.

**`GET /exports/matrix`**: one column per ACTIVE dimension, headed by its key, right after
`has_score`, in `display_order` (the 13 keep their old header names). An empty cell means no score.
An inactive dimension has no column.

Unchanged: distribution, summary, capacity fill and the Priority board read the recomputed cached
fields. Bands, `score_band`, `suggested_band` and `capacity_fill` keep their meaning.

## 6. Migration

`p26a_scoring_rubric_tables` (head, revises `p24b_checkin_reset_escape`):
- creates the three tables and `priority_scores.rubric_version`;
- inserts the 13 dimensions and version 1;
- copies every score;
- recomputes the cached fields with the frozen weights (identical on consistent data; the number
  of corrected rows is logged);
- **drops** the 13 old columns and their CHECK constraints.

Downgrade restores them from the table and refuses if a project lacks one of the 13 scores.

## 7. Contract-test rows (`backend/tests/test_openapi_frontend_contract.py`)

Red until P26-T02 mirrors them in `frontend/src/surfaces/matrix/api/types.ts` (and the Workspace
types file):

| TS interface | Backend schema | Red because |
|---|---|---|
| `PriorityMatrixRow` | `PriorityMatrixRow` | 13 flat fields removed; + `missing_dimension_keys`, `rubric_version` |
| `PriorityCompareProject` | `PriorityCompareItem` | + `missing_dimension_keys`, `rubric_version` |
| `PriorityScoreUpdateRequest` | `PriorityScoreUpdateRequest` | 13 flat fields → `scores` |
| `PriorityScoreRead` | `PriorityScoreRead` | flat fields removed (TS extends the request); + `dimension_scores`, `missing_dimension_keys`, `rubric_version` |
| `ScoringDimensionTable` | `PriorityDimensionsResponse` | + `rubric_version` |
| `ScenarioPriorityScoreChange` | `ScenarioPriorityScoreChange` | 13 flat fields → `scores` |
| `WorkspacePriorityScore` (`project-workspace/api/types.ts`) | `WorkspacePriorityScore` | 13 flat fields → `dimension_scores`, `missing_dimension_keys`, `rubric_version` |
| `ScoringRubric` | `ScoringRubricRead` | new |
| `ScoringRubricDimension` | `ScoringRubricDimension` | new |
| `ScoringRubricDimensionInput` | `ScoringRubricDimensionInput` | new |
| `ScoringRubricUpdateRequest` | `ScoringRubricUpdateRequest` | new |
| `ScoringRubricPreviewRequest` | `ScoringRubricPreviewRequest` | new |
| `ScoringRubricVersions` | `ScoringRubricVersionsResponse` | new |
| `ScoringRubricPreview` | `ScoringRubricPreview` | new |
| `RubricPreviewProject` | `RubricPreviewProject` | new |
| `RubricBandChange` | `RubricBandChange` | new |

The export has no contract row. Its columns are pinned by `backend/tests/test_p26_scoring_rubric.py`.
