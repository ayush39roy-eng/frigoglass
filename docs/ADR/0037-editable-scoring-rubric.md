# ADR 0037: Editable scoring rubric (dimensions, weights, versions in tables)

## Status

Accepted (2026-10-22). Part of P26 (P26-T01 backend, P26-T02 frontend). Amends
`docs/DOMAIN_RULES.md` "Prioritization scoring": the 13 dimensions and their weights stop being
fixed constants. Keeps the points formula, the bands, ADR 0033 (scores 0..5) and ADR 0036 (P1
capacity fill) unchanged. Does not change scheduling.

## Context

Owner request, 2026-10-22: "in the Prioritization Matrix, only there, we can edit the scoring
rubric: edit the weightage and also add something (new dimensions)". The owner left the details to
the orchestrator's defaults (data model, formula, who can edit, versioning, endpoints, readers, no
schedule impact), which this ADR records.

Before P26 the rubric was `domain_constants.PRIORITIZATION_DIMENSIONS` (13 tuples, total 295) and
every project's scores were 13 fixed NOT NULL columns on `priority_scores`.

## Decision

1. **Data model** (migration `p26a_scoring_rubric_tables`).
   - `scoring_dimensions`: `id`, stable `key` (unique), `label`, `pillar` (free text), `weight`
     (integer 1..100, CHECK), `inverted`, `active`, `display_order`, `created_at`/`updated_at`,
     `created_by_user_id`.
   - `rubric_versions`: `version` (unique), `changed_by_user_id`, `changed_at`, `reason`,
     `total_weight`, `dimensions` (JSONB snapshot of every dimension).
   - `priority_dimension_scores`: (`priority_score_id`, `dimension_id`) primary key, `score`
     0..5 or null (CHECK), ON DELETE CASCADE from `priority_scores`.
   - `priority_scores.rubric_version`: the version the cached fields were computed with.
   - The migration inserts the 13 dimensions with their keys, labels, pillars and weights (ADR
     0029), `inverted` on CAPEX Investment only, `display_order` 1..13 in the old positional order,
     and version 1. It copies every score (13 rows per project) and recomputes the cached fields
     (identical on consistent data; the count of corrected rows is logged). **The 13 old columns
     and their CHECK constraints are dropped**, not kept deprecated: nothing reads them any more,
     and NOT NULL columns that no writer fills would break every new score. The downgrade restores
     them from the table and refuses if any project lacks one of the 13 scores.
   - Wire and export keys of the 13 are unchanged (`gross_margins` = Gross Profitability,
     `profitability` = ROI). Pillars: the existing five; naming a new pillar on a dimension creates
     it.
   - `inverted` is meaning only (CAPEX: a higher score means a lower investment). The formula is the
     same for every dimension, as before.

2. **Formula, unchanged in shape.**
   ```
   TOTAL_WEIGHT   = Σ weight(d) over ACTIVE dimensions      (no constant; was 295)
   points(d)      = score(d) / 5 × weight(d)                (0 gives 0; null counts 0)
   raw            = Σ points(d)                              (= weighted_score)
   normalized_pct = round(raw / TOTAL_WEIGHT × 100)          exact, half up
   bands          ≥ 70 P1, ≥ 55 P2, ≥ 40 P3, else P4         (unchanged)
   ```
   - A project scored on at least one active dimension is scored. Each active dimension it has no
     score on counts 0 points and is listed in `missing_dimension_keys` ("incomplete"). A project
     with no score on any active dimension is "Unscored", as today (cached fields null,
     `has_score` false, `missing_dimension_keys` empty).
   - **Rounding.** Rounding is now exact rational arithmetic, half up. Weights 1..100 make `.5`
     possible (for example weight 1 of 8 at score 5 is 12.5, which gives 13; Python's `round()`
     would give 12). Under the old rubric (every weight a multiple of 5, total 295) no input can land
     on `.5`, so every stored score is unchanged. The migration test pins this on every seeded
     score.
   - The P1 capacity fill (ADR 0036) is unchanged and uses the new `normalized_pct`.

3. **Who can edit.** Only Admin and Super Admin (`PUT /scoring-rubric`,
   `POST /scoring-rubric/preview`). Every role with Matrix read (Portfolio Manager, Hub Planner,
   Executive Viewer, Admin, Super Admin) reads `GET /scoring-rubric` and `/versions`. Engineer and
   Auditor have no Matrix read and get 403. The rubric holds no project data, so it is not
   hub-scoped. The preview lists only projects in the caller's scope.

4. **Versioning.**
   - Every change creates version N+1 with a snapshot, who made it, when, and a required reason.
   - The PUT carries the `version` it edited: 409 `RUBRIC_VERSION_CONFLICT` if that is no longer
     current. A transaction-scoped exclusive advisory lock serialises saves. Every score write
     (Matrix PUT, scenario apply) takes the same lock shared before reading the rubric, so no score
     is computed against a rubric that is being replaced. The unique `rubric_versions.version` is
     the backstop.
   - An unchanged proposal is a 200 with no new version and no audit row.
   - **Stored values.** `weighted_score`, `normalized_pct` and `suggested_band` (the score band)
     stay cached on `priority_scores`. A rubric save recomputes them for every project, in all
     hubs, in the same transaction, and stamps `rubric_version`. So after a commit every row
     carries the current version. Matrix rows, compare items, the score PUT response and the
     Workspace serve `rubric_version`.
   - One `scoring_rubric.update` audit row holds the before/after versions, total weights and
     dimension lists, the reason, and counts (`recomputed_scores`, `normalized_pct_changes`,
     `score_band_changes`).
   - `PriorityApplicationResult` snapshots are history and are not rewritten.

5. **Never a hard delete.** The PUT is a full replacement. It must list every existing dimension
   (422 `RUBRIC_DIMENSION_MISSING`) and may add new ones (no `key`; the key is slugified from the
   label and suffixed `_2`, `_3`... on a collision with an existing key or a Matrix row / export
   column name). `active=false` takes a dimension out of the formula and off every reader, and its
   historic scores stay stored. `active=true` restores them. Further validation:
   - at least one active dimension (`RUBRIC_NO_ACTIVE_DIMENSION`);
   - unique keys (`RUBRIC_DUPLICATE_KEY`) and no unknown keys (`RUBRIC_UNKNOWN_KEY`);
   - case-insensitive unique labels (`RUBRIC_DUPLICATE_LABEL`);
   - weight 1..100;
   - label and pillar required, trimmed;
   - strict types with no coercion, and extra keys forbidden.

6. **Every reader uses the tables.** Nothing reads a dimension or weight constant any more:
   - Matrix rows (`dimension_scores`: one entry per active dimension, in `display_order`;
     `dimension_points`; `missing_dimension_keys`; `rubric_version`);
   - compare, distribution, summary and capacity fill;
   - the Priority board (cached score and band);
   - the Workspace score section;
   - `GET /priorities/dimensions` (active dimensions, `total_weight`, `rubric_version`);
   - the score PUT (`{"scores": {key: 0..5 | null}, "hard_gates": [...]}`; active keys only,
     422 `UNKNOWN_DIMENSION_KEY`; omitted keys keep their value; null clears);
   - scenario apply (same `scores` map; any non-active key fails the whole batch before writing);
   - the Matrix export (one column per active dimension, headed by its key, after `has_score`);
   - audit and scenario snapshots (`scores` map plus `rubric_version`);
   - the seed (`seed/initial_scoring_rubric.py`: the 13 as seed data, scored through the same
     `compute_score`).

   The What-if engine does not use the rubric: an added hypothetical project takes a 0..100 score
   or a priority directly (ADR 0031).

7. **A rubric change does not change the schedule.** The scheduler never reads scores. This was
   verified for ADR 0029 §5, and again here: nothing under `backend/scheduling/` names a score or
   the rubric, and a test pins that. A rubric save marks nothing `schedule_stale`, never writes
   `Project.priority` and never starts a run. Only the suggested band (score band and capacity
   fill) can change. The committed priority stays a human decision.

## Consequences

- An admin can now correct the 295-vs-300 total themselves (OQ #41) by changing a weight; nothing
  in code assumes 295.
- Breaking wire changes for the frontend (P26-T02):
  - the 13 flat score fields leave `PriorityMatrixRow`, `PriorityScoreRead`,
    `WorkspacePriorityScore`, `PriorityScoreUpdateRequest` and `ScenarioPriorityScoreChange`;
  - the score bodies become a `scores` map;
  - `dimension_scores` has N entries.

  See `docs/API_CONTRACT_P26.md` §7 for the contract rows that are red until P26-T02.
- Old audit and scenario snapshots keep their flat 13-key shape. New ones use `scores`.
- `seed_demo_data --reset` never resets the rubric (it is configuration). Seeded scores are cached
  under the current rubric.
