# API contract: P27, Registration "project nature" tags pre-fill scores (ADR 0038)

Owner: backend-builder (P27-T01). Consumer: frontend-builder (P27-T02). Date: 2026-10-22.
Rules: `docs/DOMAIN_RULES.md` "Prioritization scoring" (ADR 0038 amendment); ADR 0038 (also ADR
0037 editable rubric, ADR 0034 registration, ADR 0012 project grants).

Additive only: no field is removed or renamed. The existing single `type` (NM/CO/RC/NO/IMP) is
unchanged and independent of the tags.

Error envelope (unchanged): `{"detail": string | [{loc, msg, type, input?}], "code"?: string}`.

## 1. The tags

`ScoringTag` (wire value, string enum). Multi-select, zero or more, no duplicates. Served and
stored in this **canonical order** whatever order the client sends.

| Wire value | UI label | Pre-filled dimension key |
|---|---|---|
| `new_customer` | New Customer | `new_customer` |
| `strategic_project` | Strategic Project | `strategic_project` |
| `new_options` | New Options | `new_options` |
| `regulatory_compliance` | Regulatory / Business Compliance | `regulatory_compliance` |
| `new_models` | New Models | `new_models` |
| `improvement` | Improvement | `quality_improvements` |

The mapping is by dimension **key** (ADR 0037), so a renamed dimension label does not break it. Show
the dimension's current label from `GET /scoring-rubric` / `dimension_scores[].label`, not a
hard-coded one.

## 2. `POST /projects` (Registration create; RBAC unchanged: PM, Hub Planner in scope, Admin, Super Admin)

`ProjectCreateRequest` gains one optional field:

```ts
scoring_tags?: ScoringTag[]   // default []; null is a 422
```

Behaviour: every tag on a new project is a not-set → set transition, so each mapped dimension's
score is written as **5** in the same transaction (the project's score row is created). Every
other dimension has no score, so the project reads as scored but **incomplete**
(`missing_dimension_keys` lists them). No tags → no score row (unscored, as before).

Response: `ProjectRead` (201), see §5.

## 3. `PATCH /projects/{id}` (Registration edit, also used by the Workspace edit)

`ProjectUpdateRequest` gains:

```ts
scoring_tags?: ScoringTag[]   // the FULL new set (replaces it). Omit = unchanged.
```

Permission: exactly the existing Registration write rule (role WRITE on Project Registration and hub
in scope, or a project-level **Admin** grant). Viewer / Editor grants, Engineer, Executive Viewer
and Auditor get 403; an out-of-scope project is 404.

Rule (ADR 0038 §2):

| Before → after | Score effect |
|---|---|
| not set → set | mapped dimension score := 5, cached score recomputed (same transaction) |
| set → set (re-save) | nothing; a manual edit of that score survives |
| set → not set | nothing; the score stays as it is |
| removed, later re-added | a new not-set → set transition: 5 again (overwrites a manual edit) |

- If an Admin has deactivated the mapped dimension, the 5 is still stored; it does not count (and
  is not in `dimension_scores`) until the dimension is reactivated.
- The tags are not a scheduler input: `schedule_stale` is **not** set by a tags-only change, and
  `Project.priority` is never changed. No run is started.
- Response: `ProjectRead` (200). Re-fetch the Matrix row / Workspace to see the new score; the
  PATCH response does not carry the score.

## 4. Errors

| Case | Status | Body |
|---|---|---|
| Unknown value (`"bogus"`, a label like `"New Customer"`, a dimension key like `"quality_improvements"`) | 422 | FastAPI validation list, `type: "enum"`, `loc: ["body","scoring_tags",i]` |
| Duplicate value | 422 | validation list, `type: "value_error"`, msg "each scoring tag may appear once" |
| Not a list (`"new_models"`) / `null` element | 422 | validation list (`list_type` / `enum`) |
| More than 6 entries | 422 | validation list, `type: "too_long"` |
| `scoring_tags: null` on PATCH | 422 | `code: "NULL_NOT_ALLOWED"`, detail "scoring_tags may not be null" |
| `scoring_tags: null` on POST | 422 | validation list, `type: "list_type"` |

Nothing is written on any 422.

## 5. Read shapes (all additive)

`ProjectRead` (`GET /projects`, `GET /projects/{id}`, POST / PATCH responses) and therefore
`WorkspaceProject` (`GET /projects/{id}/workspace` → `project`):

```ts
scoring_tags: ScoringTag[]        // canonical order, [] when none
tag_dimension_keys: string[]      // the mapped dimension keys of those tags, canonical tag order
```

`PriorityMatrixRow` (`GET /priorities`, `GET /priorities/{id}`): the same two fields.

`tag_dimension_keys` is the "from registration" hint: mark the `dimension_scores` entries whose
`key` is in it (they stay editable through `PUT /priorities/{id}` exactly as before). It reflects
the tags, not whether the score is still 5: a manually edited score on a tagged dimension is still
listed. A key of an inactive dimension may appear in it while not appearing in `dimension_scores`;
ignore it then.

Matrix export: one new column `scoring_tags` (comma-joined values). `tag_dimension_keys` is not
exported.

## 6. Audit and activity

- A tag-driven score write is one audit row like the Matrix score PUT's: `action`
  `priority_score.create` (no prior score row) or `priority_score.update`, `entity_type`
  `PriorityScore`, before / after score snapshots, plus `after_state.source = "registration_tag"`
  and `after_state.tags` (the tags newly set). Workspace activity line: "Score pre-filled from
  project nature (New Options): 27%, suggested P4".
- `project.create` / `project.update` snapshots now include `scoring_tags`; a change reads
  "Project nature set to New Models, Improvement" in the activity feed.

## 7. Migration `p27a_project_scoring_tags`

Backfill from `type`: NM → `new_models`, NO → `new_options`, RC → `regulatory_compliance`, IMP →
`improvement`; CO and null get none. Each mapped score set to 5 (score row created if missing),
cached score recomputed under the current rubric, one audit row per project (actor null,
`source = "registration_tag_backfill"`). The log line reports the count of projects whose score
band changed. Downgrade drops the tags; the scores are **not** reverted.

## 8. Contract-test rows (`backend/tests/test_openapi_frontend_contract.py`)

Red until P27-T02 mirrors them (field sets must match exactly):

- `ProjectCreateRequest` (registration `api/types.ts`): `scoring_tags` (optional).
- `ProjectRead` (registration `api/types.ts`): `scoring_tags`, `tag_dimension_keys`.
- `WorkspaceProject` (inherits `ProjectRead`).
- `PriorityMatrixRow` (matrix `api/types.ts`): `scoring_tags`, `tag_dimension_keys`.
