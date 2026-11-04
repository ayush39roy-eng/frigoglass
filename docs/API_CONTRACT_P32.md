# API contract — P32: parallel steps (overlap) and the plan import into the What-if

Owners: algorithm-engineer (P32-T01, P32-T02), backend-builder (P32-T03, P32-T04), frontend-builder
(P32-T05, P32-T06). Date: 2026-11-04. Rules: ADR 0043, ADR 0044, `docs/DOMAIN_RULES.md`
"Precedence", "Step timing from the Gantt", I3, I27. Reference workbook (client format, NOT
committed — it holds customer names): `/Users/ayushroy/Downloads/2027 RPD Capacity
Planning-04-11-Final version.xlsx`. Tests must build their own small synthetic workbook with
openpyxl in a temp dir; never commit the client file or its rows.

---

## Part A — Parallel steps (ADR 0043)

### A1. Scheduler input (`backend/scheduling/types.py`)

```python
@dataclass(frozen=True)
class StepTimingInput:
    step_id: str
    duration_override_weeks: int | None
    start_not_before_week: int | None
    overlap_weeks: int = 0          # NEW, 0..104; 0 = no overlap. Ignored in a frozen project.
```

- `validate_step_timing`: `overlap_weeks` outside 0..104 → `ValueError`; a non-zero value on a
  workflow's first step (no predecessors) → `ValueError`.
- The input hash / canonical form must OMIT `overlap_weeks` when it is 0, so every existing hash,
  golden file and stored run is byte-identical (I8, I14).
- `StepPlan` gains `overlap_weeks: int = 0` (0 for a frozen project and for skipped steps).

### A2. Semantics (exact; greedy, CP-SAT, `unconstrained_end_week`, invariants all identical)

`P(s)` = template predecessors; `o(s)` = overlap of `s`; `frontier` = `first_step_frontier`.

```
G(q) = max(G(p) for p in P(q))  (frontier-1 if P(q) empty)      if q skipped   (= where it is emitted)
G(q) = end(q)                                                     if o(q) == 0
G(q) = max(end(q), max(G(p) for p in P(q)))                       if o(q) > 0
release(s) = max(G(q) for q in P(s))      (frontier-1 if P(s) empty)
SG(s)      = nearest non-skipped predecessors of s (walk through skipped steps)
anchor(s)  = max(start(r) for r in SG(s)) if o(s) > 0 and SG(s) else -inf
gate(s)    = max(release(s) + 1 - o(s), anchor(s), frontier)
```

- Not Started, non-frozen: search floor `max(CURRENT_WEEK, gate(s), start_not_before_week)`.
- Frozen: unchanged (`o = 0` everywhere).
- In Progress / Blocked tail and the Blocked hold: replace `pred_end + 1` with `gate(s)`.
- Skipped / held-not-blocked steps: emitted at `release(s)` (unchanged when every `o = 0`).
- CP-SAT: for each `r` in `R(s)` where `R` is the static set behind `release` (`R(q) = {q}` if
  `o(q) = 0`; `{q} ∪ ⋃R(p)` if `o(q) > 0`; `⋃R(p)` if skipped), `start(s) >= end(r) + 1 - o(s)`;
  and if `o(s) > 0`, `start(s) >= start(r)` for `r` in `SG(s)`.
- With every `o = 0`, all of the above equals today's rules. **Every golden file must be unchanged.**
- Invariants: I3 restated as `start(s) >= release(s) + 1` when `o(s) = 0` (unchanged); new **I27**:
  every non-skipped, Not Started step of a non-frozen project starts at or after `gate(s)`.
- Project `end_week` = max end of non-skipped steps (already so). Nothing may assume the last step
  in `sequence_order` ends last.

### A3. Database and API (backend-builder)

- Migration `p32a_step_overlap` (down_revision = current head): `project_workflow_steps.overlap_weeks`
  `SMALLINT NULL`, check `overlap_weeks BETWEEN 1 AND 104` (0 is stored as NULL).
- `PATCH /projects/{project_id}/steps/{step_id}/timing` body gains optional
  `overlap_weeks: int | null` (0..104, strict int; 0 is normalised to null). Absent = untouched,
  null = clear. Same 409/422 order as today, plus:
  - non-null non-zero `overlap_weeks` on the workflow's first step → 422 `VALIDATION_ERROR`
    (`loc: ["body", "overlap_weeks"]`);
  - non-null non-zero on an In Progress / Blocked step → 409 `STEP_STARTED` (clearing allowed);
  - on a Done step → 409 `STEP_DONE`; new non-null on a skipped step → 409 `STEP_SKIPPED`.
  - Audit `project.step_timing` carries the old/new `overlap_weeks`. Recalc lifecycle unchanged.
- `StepTimingResponse` gains `overlap_weeks: int | null`.
- `GanttStepRow` gains `overlap_weeks: int | null` and `predecessor_ids: list[str]` (the template's,
  sorted). A "timing edit" (`hasTimingEdit`, Reset timing) now includes a non-null `overlap_weeks`.
- `build_schedule_input_from_db` passes `overlap_weeks` (null → 0) into `StepTimingInput`; a step
  row with only an overlap is included.
- What-if baseline (ADR 0031) inherits it through the same builder.

### A4. Gantt gesture (frontend-builder)

- Dragging a `move_resize` step bar to start week `w`: compute `release` from the sibling step rows
  of the same project (served `planned_start_week` / `planned_end_week`, `skipped`,
  `predecessor_ids`, `overlap_weeks`) with the A2 formulas (a pure helper with unit tests).
  - `w >= release + 1`: send `{start_not_before_week: w, overlap_weeks: null}`.
  - `w < release + 1`: send `{start_not_before_week: w, overlap_weeks: release + 1 - w}`; the bar may
    not be dragged before the start of its nearest non-skipped predecessor (clamp).
  - Drag label while overlapping: "Parallel with {predecessor name} · {N} wk overlap". When the
    predecessor overlapped is a design step and so is this one: add "same designer — will start when
    they are free".
- *(Owner clarification 2026-11-04)* The "broken" chart is the expanded project view: one row per
  step, one below another (as today), each bar draggable/resizable; a bar dragged onto the step above
  runs in parallel with it. The collapsed project row is unchanged (no lane packing).
- "Reset timing" clears all three fields. Step timing dialog (keyboard path) gains an "Overlap with
  previous step (weeks)" number field (0..104, disabled on the first step / started steps).
- Copy `floorNote` updated: dragging onto the previous step makes the two run in parallel; capacity
  still applies.

---

## Part B — Plan import (ADR 0044)

### B1. Pure engine (`backend/scheduling/plan_import.py`, algorithm-engineer)

No I/O, deterministic, uses `run_greedy_sgs` and the What-if helpers (`WhatIfBaseline`, the leader
picker, `_supply` / capacity figures, `classify_outcome`). Never CP-SAT.

```python
@dataclass(frozen=True)
class ImportNewEngineer:
    key: str            # "new:<n>"; becomes the EngineerInput.engineer_id
    name: str
    hub: str            # a capacity hub (never OEM-HCK / OEM-Seitek)
    fte: float = 1.0

@dataclass(frozen=True)
class ImportProject:
    key: str            # "row-<file_row>" or "row-<file_row>-<k>" (expanded); unique
    name: str
    hub: str            # one of the 6 hubs
    category: str       # app category (base for ordering / skip rule)
    status: str         # app status; non-schedulable ones are listed, not scheduled
    priority: str       # P1..P4 | Q
    rank: int | None    # file PRIORITY rank; orders within the band (rank, then file_row)
    file_row: int
    leader: str | None  # existing engineer_id, an ImportNewEngineer.key, or None = auto-assign
    current_step_id: str | None              # None = the workflow's first step
    step_weeks: tuple[tuple[str, int], ...]  # (step_id, weeks 0..104) for the workflow; () = app table
    certification_testing_required: bool = True
    replaces_project_id: str | None = None   # baseline project replaced (merge mode)

@dataclass(frozen=True)
class StepEdit:
    project_ref: str                 # ImportProject.key or an existing project_id
    step_id: str
    duration_weeks: int | None       # 1..104 or None (no user value)
    start_not_before_week: int | None  # 1..horizon or None
    overlap_weeks: int | None        # 1..104 or None

@dataclass(frozen=True)
class PlanImportRequest:
    projects: tuple[ImportProject, ...]
    new_engineers: tuple[ImportNewEngineer, ...] = ()
    edits: tuple[StepEdit, ...] = ()
    mode: str = "merge"              # "merge" | "file_only"
    plan_year_end_week: int = 104    # 52 or 104

def run_plan_import(baseline: WhatIfBaseline, req: PlanImportRequest, *,
                    deadline_s: float | None = None, clock=None) -> PlanImportResult
```

Building the scenario input (both runs use `within_year_week = plan_year_end_week`,
`horizon_weeks = plan_year_end_week + 26`, the baseline's `current_week`):

1. **Baseline run** (merge mode only): the baseline schedule unchanged apart from the two week
   fields. In `file_only` mode there is no baseline run and every `before_*` is null.
2. **Import run**: merge → baseline projects minus every `replaces_project_id`, plus the file
   projects; file_only → the file projects only (the baseline's engineers, chambers, workflows and
   lead times are kept). New engineers are added as `EngineerInput(engineer_id=key, name, hub,
   allowed_categories=<all categories of that hub kind, as the What-if does for added designers>,
   fte)`.
3. **File project → `ProjectInput`**: `project_id = f"imp-{rank or 9999:04d}-{file_row:05d}-{k}"`
   (stable, so the greedy tie-break keeps rank order inside a band); `workflow_id` = `OEM` for an
   OEM hub else `PDD`; `capacity_hub` from `hubs` (ADR 0042); `frozen=False`; `actual_start_week=None`.
   - `step_timing`: for every step, `duration_override_weeks = step_weeks[step]` when `step_weeks`
     is given (0 allowed = skipped), and every DAG ancestor of `current_step_id` gets 0
     (done before import). Then the `edits` for this project are applied on top (an edit's
     `duration_weeks` replaces the duration, its floor and overlap are set as given).
   - `step_progress`: for `In Development` / `Under Industrialization`, the first step in walk order
     that is not an ancestor of the stage and not skipped is `In Progress`, `percent_complete=0`,
     `actual_start_week=current_week`. Nothing else has progress.
   - A step the file gives weeks > 0 but whose app lead time for the base category is 0 stays
     skipped (ADR 0019): reported as issue `STEP_NOT_IN_CATEGORY`.
   - `leader=None` → the What-if picker (eligible designer of the capacity hub, fewest led
     design-weeks per FTE, never FTE 0, never `counts_in_capacity=False`); picks are made in
     scheduling order so load spreads; reported `leader_auto_assigned=True`.
4. **Edits on baseline projects** replace that project's stored timing triple for the step (None =
   no value). Edits naming an unknown project/step → `ValueError` (the API maps to 422).
5. Caps: ≤ 600 file projects, ≤ 50 new engineers, ≤ 2,000 edits (`ValueError`), cooperative
   deadline (`WhatIfBudgetExceeded`).

`PlanImportResult` (frozen dataclasses; field names = the HTTP response, B3):
`current_week, plan_year_end_week, horizon_weeks, mode, projects, capacity, kpis, changes, issues,
workings, scheduling_order`. Per project and per step exactly the fields of B3 except display
names (the service maps engineer / chamber ids to names). `outcome` uses `classify_outcome`, so
`within_year` there means "finishes by `plan_year_end_week`".

**Capacity (ADR 0044 §8).** Windows: `y0` = `current_week..min(52, plan_year_end_week)`; `y1` =
`53..104` when `plan_year_end_week = 104`. Weekly series over `current_week..plan_year_end_week`.
- Design load per **capacity hub** per week: for each non-skipped design step booked by a project of
  that capacity hub (or one of its members), `duration_weeks / span_weeks` on each week of the
  booked span that is ≥ `current_week` (In Progress tails: their remaining effort over the tail
  weeks). Capacity per week: `Σ fte × working_weeks_per_engineer / 52` over the hub's engineers with
  `counts_in_capacity` (What-if `_supply`; new engineers count with their FTE).
- Lab load per **lab region** per week: 1 per lab step-week. Capacity per week:
  `Σ efficient lab weeks of the region's chambers / 52` (What-if `_supply`).
- Window rows: `load_weeks = Σ weekly load`, `capacity_weeks = Σ weekly capacity`, `booked_pct` and
  `status` via `booked_pct` / `booking_status` (ADR 0016). Rounded to 2 dp.
- Designer rows: per engineer that leads a design step in the run or counts in a capacity hub:
  `booked_weeks` per window = calendar weeks the engineer is booked in the window (span weeks),
  `available_weeks = fte × working_weeks_per_engineer / 52 × window weeks`, `booked_pct`, `status`.

**KPIs**: `projects_total` (scheduled + listed), `file_projects`, `plan_projects`,
`within_plan_year`, `spillover`, `left_out`, `blocked`, `excluded`, `data_error` (counts by outcome
class over every project in the run), `file_within_plan_year`, `file_scheduled` (file projects not
`excluded`), `before_within_plan_year` / `after_within_plan_year_existing` (baseline projects that
are still in the run; merge only, else null), `newly_slipping`, `recovered` (counts).

**Changes** (merge only): baseline projects (not replaced) whose `within_year` flipped
(`newly_slipping` / `recovered`) or whose `projected_end_week` moved (`moved`), as ADR 0031.

**Issues** (`ref`, `severity` info|warning|error, `code`, `message`): `LEADER_AUTO_ASSIGNED`,
`NEW_DESIGNER`, `ENG_CONFLICT`, `LAB_OVERLAP`, `LEFT_OUT` (with the reason: no leader / no chamber
step / horizon), `DATA_ERROR`, `CAT_NOT_ALLOWED`, `STEP_NOT_IN_CATEGORY`, `UNREACHABLE_IN_YEAR`
(unconstrained end after the plan year).

### B2. `POST /whatif/import/parse` (backend-builder)

RBAC `CAPACITY_PLANNING` / `READ` (as `/whatif/*`). Multipart field `file`. `.xlsx` only by magic
bytes (`services/file_sniff.py`), ≤ 5 MB (413 `FILE_TOO_LARGE`), openpyxl `read_only=True,
data_only=True`, defused XML; ≤ 2,000 data rows and ≤ 60 columns scanned; no header found →
422 `IMPORT_FORMAT` with a message naming the expected headers. Rate-limited (What-if limiter).
Audit `whatif.import_parse` (row counts + SHA-256 of the bytes; never names or content).

**Projects sheet**: the first sheet with a header row (within the first 10 rows) containing at least
`Project description` and one of `Status` / `RPD HUB`. Header match is case/space-insensitive,
leading/trailing spaces ignored, prefix-tolerant: `S/N`, `Project code`, `Plant`, `Expenses`,
`PRIORITY`, `Project description`, `RPD HUB`, `Project Category`, `PDD Project Stage`, `Status`,
`Recommended Design Engineer`, `Spillover from 2026` (any `Spillover…`), `Num of Projects`,
`Must Do`, `Complexity`, `Est. Dur. (Months)` (any `Est. Dur…`). All other columns are ignored and
never read into the response. A row with an empty `Project description` is skipped.

**Process-steps sheet**: the first sheet with a cell `PDD-A` and a row of 14 step codes. For each
section (`PDD-A..PDD-N` header row; `OEM-A..OEM-N` header row) read the category rows below it (first
column = label, e.g. `Special Category`, `A+`, `A`, `B`, `C+`, `D`, `A-OEM`, …) until a blank label;
cells are integers ≥ 0, blank = 0, non-numeric = 0 with a warning; extra columns (`Sum`, …) ignored.
Missing sheet → the app's lead-time table is used (warning `NO_PROCESS_STEPS`).

Response `ImportParseResponse`:

```jsonc
{
  "file_name": "…xlsx",
  "projects_sheet": "draft 1 291026",
  "steps_sheet": "Process steps" ,            // or null
  "base_year": 2026, "current_week": 42,
  "lead_times": [ { "workflow": "PDD", "label": "A+", "weeks": { "PDD-A": 1, …14 } } ],
  "steps_meta": [ { "workflow": "PDD", "step_id": "PDD-A", "name": "Marketing Brief", "kind": "design",
                    "sequence_order": 1, "predecessor_ids": [] } ],          // 28 rows
  "roster": [ { "engineer_id": "uuid", "name": "Lokesh", "hub": "PD-India",
                "capacity_hub": "PD-India", "fte": 1.0 } ],   // FTE > 0 and counts_in_capacity only
  "rows": [ ImportRow ],
  "issues": [ { "row_key": "row-5" | null, "file_row": 5 | null, "field": "engineer" | null,
                "severity": "info" | "warning" | "error", "code": "ENGINEER_UNKNOWN", "message": "…" } ],
  "counts": { "rows": 97, "schedulable": 85, "not_scheduled": 12, "matched": 38, "new": 59,
              "auto_assign": 20, "new_designers": 2 }
}
```

`ImportRow` (also the `/simulate` input, B3):

```jsonc
{
  "key": "row-5", "file_row": 5, "sn": "3", "code": "26-00421" | null, "plant": "Rom" | null,
  "name": "ICOOL3-750 B",
  "hub": "R&D-Greece", "hub_raw": "Greece",
  "category": "A+", "category_raw": "A+", "lead_time_label": "A+",   // the file row used (or "app")
  "status": "In Queue", "status_raw": "Que",
  "stage_step_id": "PDD-A" | null, "stage_raw": "PDD-A" | null,
  "rank": 3 | null, "priority": "P1", "priority_source": "rank" | "matched" | "default",
  "engineer_raw": "Antonis" | null,
  "leader": { "kind": "existing", "engineer_id": "uuid", "name": "Kanarios" }
          | { "kind": "new", "name": "Antonis" } | { "kind": "auto" },
  "matched_project_id": "uuid" | null, "matched_project_name": "…" | null, "match_by": "name" | "code" | null,
  "num_projects": 1 | null, "must_do": true | null, "spillover_from_previous": true | null,
  "complexity": "H" | null, "est_duration_months": "6-12" | null,
  "certification_testing_required": true,
  "step_weeks": { "PDD-A": 1, …14 },   // the workflow's 14 steps from lead_time_label
  "include": true
}
```

Issue codes: `HUB_DEFAULTED`, `HUB_OEM_DEFAULTED`, `CATEGORY_DEFAULTED`, `CATEGORY_MAPPED`,
`STATUS_DEFAULTED`, `STATUS_NOT_SCHEDULED`, `STAGE_UNKNOWN`, `STAGE_WORKFLOW_MISMATCH` (stage letter
kept, mapped to the hub's workflow), `ENGINEER_MISSING` (→ auto), `ENGINEER_FROM_PLAN` (blank engineer on a matched row keeps the plan project's leader), `ENGINEER_UNKNOWN` (→ new designer),
`MATCH_AMBIGUOUS`, `MATCHED`, `RANK_INVALID`, `NO_PROCESS_STEPS`, `LEAD_TIME_ROW_MISSING`,
`LEAD_TIME_VALUE`, `DUPLICATE_ROW`.

### B3. `POST /whatif/import/simulate` (backend-builder)

Same RBAC, limiter and time cap as `/whatif/simulate`; strict body; audit `whatif.import_simulate`
(counts only). 422 `INVALID_IMPORT` for an engine `ValueError` (message passed through, no names
added); 503 `WHATIF_TIMEOUT`.

Request:

```jsonc
{
  "mode": "merge" | "file_only",
  "plan_year_end_week": 52 | 104,
  "expand_multi": false,
  "rows": [ ImportRow ],         // as returned by /parse, possibly edited; ≤ 600 after expansion
  "edits": [ { "project_ref": "row-5" | "<project uuid>", "step_id": "PDD-E",
               "duration_weeks": 6 | null, "start_not_before_week": 60 | null, "overlap_weeks": 2 | null } ]
}
```

The service validates rows (hub/category/status/priority enums, `stage_step_id` in the hub's
workflow, `step_weeks` keys = the workflow's 14 steps with 0..104, `matched_project_id` in scope),
resolves `leader` (existing id must be on the roster; `new` names are deduplicated per
(name, capacity hub) into `ImportNewEngineer`s), drops `include=false` rows, expands
`num_projects` when `expand_multi`, and calls `run_plan_import` in the What-if worker thread.

Response `ImportSimulateResponse`:

```jsonc
{
  "base_year": 2026, "current_week": 42, "plan_year_end_week": 104, "horizon_weeks": 130, "mode": "merge",
  "kpis": { … B1 KPIs … },
  "steps_meta": [ … as /parse … ],
  "projects": [ {
      "ref": "row-5" | "<uuid>", "source": "file" | "plan", "file_row": 5 | null,
      "replaces_project_id": "<uuid>" | null, "name": "…", "hub": "…", "capacity_hub": "…",
      "category": "A", "priority": "P1", "status": "In Queue",
      "leader_name": "Lokesh" | null, "leader_ref": "<uuid>" | "new:1" | null, "leader_auto_assigned": false,
      "outcome": "within_year" | "spillover" | "left_out" | "blocked" | "excluded" | "data_error",
      "start_week": 43 | null, "end_week": 70 | null, "finish_week": 70 | null,
      "unconstrained_end_week": 60 | null,
      "before_outcome": "spillover" | null, "before_finish_week": 75 | null,
      "eng_conflict": false, "cat_not_allowed": false, "no_chamber_step_id": null, "data_error": null,
      "steps": [ {
          "step_id": "PDD-E", "kind": "design", "sequence_order": 5,
          "start_week": 50, "end_week": 55, "duration_weeks": 6, "span_weeks": 6,
          "skipped": false, "done_before_import": false,
          "status": "Not Started" | "In Progress" | "Blocked" | "Done",
          "engineer_name": "Lokesh" | null, "chamber_code": "CH-2" | null,
          "duration_override_weeks": 6 | null, "start_not_before_week": null, "overlap_weeks": null,
          "editable": "move_resize" | "resize" | "none"
      } ]            // all 14 steps, sequence order
  } ],
  "capacity": {
    "windows": [ { "key": "y0", "label": "2026 W42–W52", "from_week": 42, "to_week": 52 },
                 { "key": "y1", "label": "2027", "from_week": 53, "to_week": 104 } ],
    "hubs": [ { "hub": "PD-India", "fte": 6.25, "windows": [ { "key": "y1", "load_weeks": 210.5,
               "capacity_weeks": 280.0, "booked_pct": 75.18, "status": "ok" } ] } ],
    "lab_regions": [ { "region": "India", "chambers": 4, "windows": [ … ] } ],
    "weekly": { "weeks": [42, …, 104],
                "hubs": { "PD-India": { "load": [ … ], "capacity": [ … ] } },
                "lab_regions": { "India": { "load": [ … ], "capacity": [ … ] } } },
    "designers": [ { "ref": "<uuid>" | "new:1", "name": "Lokesh", "hub": "PD-India", "fte": 1.0,
                     "is_new": false, "windows": [ { "key": "y1", "booked_weeks": 40,
                     "available_weeks": 46.2, "booked_pct": 86.58, "status": "near_full" } ] } ]
  },
  "changes": { "newly_slipping": [ { "ref": "<uuid>", "name": "…", "hub": "…",
                 "before_finish_week": 50, "after_finish_week": 58 } ], "recovered": [ … ], "moved": [ … ] },
  "issues": [ { "ref": "row-5" | "<uuid>" | null, "severity": "warning", "code": "LEADER_AUTO_ASSIGNED", "message": "…" } ],
  "workings": [ "…" ]
}
```

- `projects` order: file projects in file order, then plan projects by `finish_week` (nulls last),
  then name. Plan projects outside the caller's hub scope are omitted; capacity `hubs` /
  `lab_regions` / `designers` rows only for hubs / regions in scope (the What-if `Scope`). Plan
  projects with outcome `excluded` (Commercialized, On Hold, Cancelled) are omitted from `projects`
  (counted in `kpis.excluded`); file rows that are excluded are returned (so the planner sees them).
- `editable`: `none` for skipped, `done_before_import`, Done, frozen, excluded and non-scheduled
  projects; `resize` for In Progress / Blocked; `move_resize` for Not Started.
- Weeks are absolute (`53` = 2027 W1). `base_year` lets the browser label them.
- No financial field, customer or free-text column is read, returned or logged.

### B4. Frontend (frontend-builder)

On Capacity Planning → What-if planner, a new sub-view **"Import plan (Excel)"** beside the
existing forms. A four-step, linear flow with a stepper (Upload → Review → Results), all state in a
Zustand store (session only):

1. **Upload**: drag-and-drop / file picker (`.xlsx`, 5 MB), a short "expected format" card listing
   the header names and the `Process steps` sheet, "Parse file". Errors shown inline (413, 422
   `IMPORT_FORMAT`, 429, 503).
2. **Review** (the "structured process"): summary counts; issues list grouped by severity with
   "show only rows with issues"; a virtualised table of rows (TanStack Table + Virtual) with editable
   cells: Include (checkbox), Hub (select), Category (select), Status (select), Priority (P1–P4, Q,
   with the source as a hint: "rank 3" / "from plan" / "default"), Stage (select of the workflow's 14
   steps), **Engineer** (combobox: roster of the row's capacity hub first, then others; "Auto-assign";
   "New designer…" with a name input). Rows with `ENGINEER_MISSING` / `ENGINEER_UNKNOWN` are
   highlighted and a top banner says "N projects have no engineer — choose one or keep auto-assign".
   Matched rows show "replaces: <plan project>". Options: Mode (Merge with current plan / This file
   only), Plan year (2027 default / 2026), Expand "Num of Projects". "Compute plan" button.
3. **Results**, tabs:
   - *Overview*: KPI tiles (projects, finishing in plan year, spillover, left out; file vs plan;
     before/after for merge), newly slipping / recovered lists, issues.
   - *Gantt*: rows = projects (filter: file / plan / all, hub, outcome, search), a year-aware week
     axis (W42 2026 → plan year end, labels "W5 '27"), plan-year end marker, collapsed row = one
     summary bar, expand (and Expand all) → 14 step rows one below another (A4). Step bars are draggable/resizable exactly
     like the live Gantt (move → floor, onto the predecessor → overlap, right edge → duration), using
     the same pure helpers; each drop updates the edits map and re-runs `/simulate` (debounced,
     previous request aborted), with a "recomputing…" state and an "Undo" / "Reset all edits".
     Elapsed steps hollow, lab vs design colours as the live Gantt, done-before-import steps not drawn
     (listed in the tooltip), left-out projects marked.
   - *Capacity*: per hub and lab region a window table (load, capacity, booked % with the ADR 0016
     status chip) and an ECharts weekly load-vs-capacity chart (hub selector); designers table.
   - *Projects*: sortable table (name, source, hub, category, priority, status, leader (with an
     "auto" chip), finish week, outcome, before → after).
   - A "Back to review" button keeps every edit.
- No `dangerouslySetInnerHTML`; every figure is served (the browser only formats weeks and draws).
- Tests: store, the release/overlap helper, lane packing, parse → review → simulate happy path
  with MSW-style mocks, engineer combobox, a11y (axe) on each step.
