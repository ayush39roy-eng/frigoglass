# API contract — P41: import format settings, hand-picked scenarios, saved/exported import scenarios (ADR 0055)

All routes are under `/whatif/import`. "What-if access" means `require_permission(Surface.CAPACITY_PLANNING, Action.READ)`,
the same dependency as `/whatif/import/simulate`. The existing rate limiter `WHATIF_RATE_LIMIT` applies to every
POST, PUT and DELETE route and to every export. Errors use the existing `CodedHTTPException` shape.

## A. Import format (D1)

```
FIELD_KEYS = sn, code, plant, expenses, priority, name, hub, category, stage, status, engineer,
             spillover, num_projects, must_do, complexity, est_duration       # = keys of _FIELDS
```

`ImportFormatOut`:
```json
{
  "version": 0,                     // 0 = built-in default, no row yet
  "is_default": true,
  "fields": [
    { "key": "name", "label": "Project name", "required": true,
      "aliases": ["project description"], "default_aliases": ["project description"] }
  ],                                // FIELD_KEYS order
  "updated_at": null, "updated_by_name": null,
  "can_edit": false                 // true for Admin / Super Admin
}
```

- `required`: `name` is true. `status` and `hub` are "one of" (the UI shows "Status or Hub").
- The labels are fixed in the backend. Plain English: S/N, Project code, Plant, Expenses, Priority,
  Project name, Hub, Category, Stage, Status, Design engineer, Spillover, Number of projects, Must do,
  Complexity, Estimated duration (months).

Routes:
- `GET /whatif/import/format` (What-if access) returns `ImportFormatOut`.
- `PUT /whatif/import/format` (Admin, Super Admin; any other role gets 403):
  - body `{ "version": int, "fields": { "<key>": ["alias", …] } }`;
  - a key that is left out keeps its current aliases.
  - Validation is in ADR 0055 D1. The 422 codes are `FORMAT_UNKNOWN_FIELD`, `FORMAT_ALIAS_INVALID`,
    `FORMAT_ALIAS_DUPLICATE`, `FORMAT_REQUIRED_MISSING` and `FORMAT_TOO_MANY_ALIASES`. A version
    mismatch is a 409 `FORMAT_VERSION_CONFLICT`.
  - Returns `ImportFormatOut`, and writes an audit row (`import_format.updated`, with the before and
    after aliases).
- `POST /whatif/import/format/reset` (Admin, Super Admin):
  - body `{ "version": int }`;
  - sets the built-in aliases and bumps the version;
  - writes an audit row (`import_format.reset`).
- `GET /whatif/import/format/template.xlsx` (What-if access):
  - sheet `Projects`: row 1 is the first alias of each field, in FIELD_KEYS order, written in Title
    Case;
  - sheet `Process steps`: one PDD section and one OEM section in the layout `_read_steps_sheet`
    reads, with the step codes and an empty category row;
  - the parser must accept the downloaded template; a test covers this.
- `/whatif/import/parse` uses the stored aliases. `parse_plan_workbook(data, …, aliases=…)` defaults to
  the built-in `_FIELDS`.
- The "No projects sheet found" message lists the current aliases.

## B. Hand-picked scenario (D2)

`ImportSimulateRequest` gains:
```
exclude_plan_project_ids: list[str] = []   # max 2000, unique; merge mode only (422 IMPORT_INVALID in file_only)
```
- Each id must be a plan project in the caller's scope that is in the baseline; otherwise 422 `IMPORT_INVALID`.
- The ids are removed from both runs, together with `removed_project_ids` (`without_projects`).
- An id that a file row also matches is not an error: the file row replaces the project anyway.
- `ImportKpisOut` gains `plan_excluded: int`, the number of plan projects taken out by this list.
- `ImportSimulateResponse` gains `plan_projects: [{ "id", "name", "hub", "category", "priority", "status" }]`.
  It lists every in-scope plan project that **could** be in the run, before exclusion, so the UI can
  show a tick list. It is only filled in merge mode; it is `[]` in file_only.

## C. Saved import scenarios (D3)

`SavedScenarioSummary`:
```json
{ "id": "uuid", "name": "…", "note": "…|null",
  "source_file_name": "…", "source_file_sha256": "hex", "imported_at": "iso",
  "created_at": "iso", "created_by_name": "…", "can_edit": true,
  "mode": "merge|file_only", "plan_year_end_week": 104,
  "simulated_week": 47, "plan_version": 14,
  "hub_codes": ["PD-India", …],
  "kpis": { …ImportKpisOut… } }
```
`SavedScenarioOut` = summary + `"request": ImportSimulateRequest` + `"result": ImportSimulateResponse`.

Routes:
- `POST /whatif/import/scenarios`:
  - body `{ "name", "note"?, "source_file_name", "source_file_sha256", "imported_at", "request": ImportSimulateRequest }`.
  - The server runs the import simulate on `request` at the current clock (the same code path as
    `/simulate`) and stores the output. It returns 201 with `SavedScenarioOut`.
  - Limits: 200 per user and 2,000 in total (422 `SCENARIO_LIMIT`); stored size up to 8 MB (413
    `SCENARIO_TOO_LARGE`).
- `GET /whatif/import/scenarios` returns `{ "items": SavedScenarioSummary[] }`, newest first, filtered
  by visibility (ADR 0055 D3).
  - Optional `?source_file_sha256=`.
  - A scenario that is out of scope is not listed, and a GET on it returns 404, never 403.
- `GET /whatif/import/scenarios/{id}` returns `SavedScenarioOut`.
- `PATCH /whatif/import/scenarios/{id}`:
  - body `{ "name"?, "note"? }`;
  - only the creator, Admin or Super Admin; anyone else gets 403.
- `DELETE /whatif/import/scenarios/{id}`: the same users; returns 204.
- Audit actions: `whatif_scenario.saved`, `.renamed`, `.deleted` and `.exported`. The extra data is
  id, name and counts only, never the payload.

Table `whatif_import_scenarios`:
- id, name, note;
- created_by (FK users, `ON DELETE SET NULL`), created_at, updated_at;
- source_file_name, source_file_sha256, imported_at;
- mode, plan_year_end_week, simulated_week, plan_version (nullable);
- hub_codes `text[]`;
- request JSONB, result JSONB.
- Index on (created_by), (source_file_sha256) and (created_at desc).
- Migration `p41a_import_format_and_scenarios`. It also creates `import_format_settings`: id = 1 with a
  CHECK, version, field_aliases JSONB, updated_by, updated_at.

## D. Export (D5)

All of these return `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` with
`Content-Disposition: attachment; filename="<safe name>.xlsx"`. Every string cell that starts with
`= + - @`, a tab or a CR gets a leading `'`.
- `GET /whatif/import/scenarios/{id}/export.xlsx`
- `POST /whatif/import/export.xlsx`:
  - body `{ "name"?: str, "request": ImportSimulateRequest }`;
  - the server recomputes from the request and never trusts a browser-supplied result.
- `GET /whatif/import/scenarios/compare.xlsx?ids=a,b,c`:
  - takes 2–4 ids, all visible to the caller; a missing or out-of-scope id gets 404;
  - sheets: KPIs (one column per scenario, plus a delta against the first), Outcome changes (a project
    whose outcome differs, matched by `ref`).

The scenario workbook's sheets are Summary, Breakdown, Projects, Steps and Capacity (ADR 0055 D5).
They only use served fields.

## E. Frontend (frontend-builder)

1. **Import format (Upload step).** This is a "Excel format" card.
   - **All users:** the expected column names are visible, and there is a "Download template" button.
   - **Admin and Super Admin:** an "Edit format" button opens a dialog. It shows one row per field:
     the label, a chip input for the header names (add/remove), a required marker, and "Reset field".
   - The dialog footer has Save and "Reset all to default", with a confirmation. A 409 shows "Someone
     else changed the format — reload".
   - Other roles never see the edit button.
2. **Executive tab → "Scenario" bar** (top of the Executive tab):
   - a scenario selector: "Current result", the session variants, and the saved scenarios of this
     import;
   - **"Pick projects…"** opens a side sheet. It has a searchable, filterable list (category / hub /
     priority / source) of the file rows and, in merge mode, the plan projects (`plan_projects`).
     Each row has a tick box, and there are Select all / none and a count "N of M included".
   - "Compute scenario" runs `/simulate` with the ticked rows (`include`) and
     `exclude_plan_project_ids`.
   - **"Save scenario"**: a name and an optional note, then `POST /scenarios`. A toast confirms, and
     the scenario appears in the library.
   - **"Export"**: a saved scenario uses `GET …/{id}/export.xlsx`; an unsaved result uses `POST /export.xlsx`.
3. **Saved scenarios library** (a panel in the Compare tab, also reachable from the Scenario bar):
   - It lists all the saved scenarios the user can see, grouped by source file and import date.
   - Each card shows the name, the note, who saved it and when, `simulated_week` / `plan_version`,
     and 3 KPIs.
   - Actions: Open (loads the stored result read-only, with a banner "Saved scenario — simulated
     W47 against plan v14", and "Re-run on today's plan"), Rename, Delete (when `can_edit`), Export,
     and "Add to compare".
   - The Compare tab takes up to 4 from the session list and the saved list together, whatever import
     they came from. When the sources differ, a source chip goes on each column. There is a
     "different week / plan version" banner, and "Export comparison" uses `compare.xlsx`.
   - Remove the "session only" banner when saved scenarios are present. Keep it for unsaved session
     variants.
4. TanStack Query keys: `['whatif-import-format']` and `['whatif-import-scenarios', sha?]`. A
   mutation invalidates them. No `dangerouslySetInnerHTML`. The download goes through the existing
   authenticated fetch and a blob.

## F. Plan window in saved scenarios (P50-T01, ADR 0061 R49-13, R49-19)

- `POST /whatif/import/scenarios` stores the request with the resolved `plan_from_week` and
  `plan_until_week` (never null) and `plan_window_rerun: false`. No migration: both live in the
  `request` JSONB.
- `SavedScenarioSummary` / `SavedScenarioOut` gain `plan_from_week` and `plan_until_week`. A row saved
  before P50 reads f = `simulated_week` and u = `plan_year_end_week`; its served `request` and
  `result` are filled the same way (`result.plan_from_label`, `plan_week_choices` from the stored
  week). The list reads the two weeks from the JSONB by key, never the whole request.
- "Re-run on today's plan": send the stored `request` with `plan_window_rerun: true` (see
  API_CONTRACT_P32 D2).
- Compare: the frontend banner also fires when `plan_from_week` differs ("file projects start from
  different weeks") or `plan_until_week` differs ("plan windows differ — within counts are not like
  for like"). `compare.xlsx` gains `Plan from week` / `Plan until week` KPI rows and the same two
  lines in its context.
- Export Summary (saved and current result) gains `plan_from_week`, `plan_from` (label),
  `plan_until_week`, `plan_window`; the Gantt context names a later start and the window.
- Audit `whatif_scenario.saved` gains `plan_from_week` and `plan_until_week`.
