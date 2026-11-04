# ADR 0044: Import a capacity-planning workbook into the What-if planner

## Status

Accepted (2026-11-04). Part of P32. Client message relayed by the owner on 2026-11-04 with the
workbook `2027 RPD Capacity Planning-04-11-Final version.xlsx` (sheets `draft 1 291026` and
`Process steps`), which "is the format that will be used for uploading":

> The objective is to upload the project information into the scheduler so that the software can
> automatically generate a Gantt chart indicating the expected completion timelines for each
> project … Development projects are already in progress and will be mapped in the Gantt chart as
> per their respective process steps. Projects in the queue should be mapped based on their assigned
> priority. If no priority is specified, the system can allocate them using the default
> prioritization logic. For any project where the engineer's name is not mentioned, please update
> and add the responsible engineer's name.

Contract: `docs/API_CONTRACT_P32.md`.

## Decision

1. **A What-if, not a write.** Upload → review → compute → results, on the What-if planner. Nothing
   is persisted (ADR 0031 §1): no project, engineer, step, run or file is stored. The only write is
   a coalesced audit row (counts and a digest, never file content). The file is parsed in memory
   and discarded.
2. **Two steps, both stateless.** `POST /whatif/import/parse` (multipart, the `.xlsx`) returns the
   normalised rows, the file's lead-time table, the engineer roster mapping and every issue found.
   The browser holds that and lets the planner fix it (engineer, hub, category, priority, status,
   include). `POST /whatif/import/simulate` takes the reviewed rows (JSON) plus Gantt edits and
   returns the full plan: per-project and per-step schedule, capacity, KPIs, diff, issues. Each
   simulate is two greedy runs (baseline + import), tens of milliseconds at this size.
3. **Merge with the current plan (default) or the file alone.** In `merge` mode the simulation is
   the live plan (every project of the DB, ADR 0031 baseline) with the file's rows added; a file
   row that matches an existing project **replaces** it (no double counting). In `file_only` mode
   only the file's rows are scheduled, on the live roster and chambers.
4. **Matching a row to an existing project**: normalised name (case, whitespace and tabs folded)
   equal to exactly one project; otherwise a real project code (`NN-NNNNN…`, not `NEW`/`TBA`/`TBD`)
   equal to exactly one project's `external_code` and occurring once in the file. Ambiguous → new
   project, with an info issue. Only projects in the caller's hub scope are matchable.
5. **Mapping the file's columns** (header-name based, not column-letter based; see contract §2):
   - *Status*: `Que` / `In Que` / `Queue` → In Queue; `Development` → In Development;
     `Industrialization` → Under Industrialization; `On Hold` (any case) → On Hold (listed, not
     scheduled, like the app); app labels accepted as they are; blank → In Queue (warning).
   - *Hub* (`RPD HUB`, falling back to `Expenses` then `Plant`): `Greece` → R&D-Greece; `PD ROM` /
     `ROM` / `Rom` → PD-Romania; `India` / `IND` / `INN` / `SAF` / `Egypt` → PD-India, or R&D-India
     when the resolved leader sits in R&D-India; `OEM-HCK` / `OEM/HCK` → OEM-HCK; `OEM-Seitek` /
     `OEM/Seitek` → OEM-Seitek; `OEM-NSR` and any other OEM value → OEM-HCK (warning; both OEM hubs
     share R&D-Greece capacity and the Greece lab region, ADR 0042, so the choice changes only the
     label). A row whose category or stage is OEM but whose hub is not → OEM-HCK (warning).
   - *Category*: app categories as they are. The file's own lead-time rows are used for durations
     (point 6). `Special Category` (in the category or the code column) uses the file's
     `Special Category` row; `C+` → C; `D` → C (base category for ordering and skip rules); blank →
     B / B-OEM (warning).
   - *Stage* (`PDD Project Stage`, `PDD-A`…`PDD-N` / `OEM-A`…`OEM-N`): the project's current step.
     Every DAG ancestor of it is **done before the import** (skipped in the solver: duration 0, no
     bar, no load). For `In Development` / `Under Industrialization` rows the first remaining
     non-skipped step is **In Progress from CURRENT_WEEK** (anchored: the client's "already in
     progress", booked from today without waiting for capacity, ENG_CONFLICT possible, as for any
     In Progress step); the rest are Not Started. For In Queue rows every remaining step is Not
     Started and placed by the scheduler in priority order. Blank stage → the first step.
   - *Priority* (`PRIORITY`, a rank 1, 2, 3 … per plant): a ranked row is **P1** and ranks are kept
     in order within the band (rank, then file row). An unranked row takes the matched project's
     band (the app's scored priority — the "default prioritization logic"); an unranked new row
     takes **P3**, the What-if default (ADR 0031 §5). The planner can change any row's band.
   - *Engineer* (`Recommended Design Engineer`): matched to the roster by full name, then by unique
     first name, then by unique surname (case-insensitive; `Lokesh Sharma` → Lokesh, `Stef` → Stef
     Marius, `Rahul Bhardwaj` → Rahul-Contractual). An engineer with FTE 0 is never matched. A
     **named** engineer not on the roster becomes a *new What-if designer* of that name (FTE 1.0, the
     row's capacity hub; warning). A **blank** or `TBC` engineer is **auto-assigned** (the What-if
     picker: the eligible designer of the capacity hub with the fewest led design-weeks per FTE,
     ADR 0031 §5) and flagged so the planner can replace it — the client's "please add the
     responsible engineer". *(Amended 2026-11-04: a blank or `TBC` engineer on a row matched to a
     plan project whose leader is on the roster keeps that leader — `ENGINEER_FROM_PLAN`, info —
     and auto-assign applies only when neither the file nor the matched project names one.)*
   - *Num of Projects*: shown; with `expand_multi=true` a row of `n > 1` becomes `n` projects
     (`name (k/n)`). Default off: one row, one Gantt line. *(Amended 2026-11-04, owner: expansion
     is the default — "if it is written 5, the system treats them as 5 projects". `expand_multi`
     defaults to true (a caller may send false); blank or 1 is one project, `n ≥ 2` is `n` projects
     `name (k/n)` keyed `row-<file_row>-<k>` with the row's hub, category, status, priority, rank,
     stage, step weeks and leader; only copy 1 replaces the matched plan project; On Hold rows are
     still dropped; a value that is not a whole number 1..100 is read as 1 with warning
     `NUM_PROJECTS_INVALID`; the 600-project cap applies after expansion (422); the parse
     `counts.projects_after_expansion` gives the expanded total. P32-R03.)*
   - Ignored, never parsed into the response or logged: `Customer`, `CAPEX`, `Tooling`, `notes`,
     `Annual volume`, `Business case summary`, `Comments` (commercially sensitive or free text).
6. **Durations come from the file's `Process steps` sheet.** Each project's step weeks are the
   file's lead time for its (workflow, category row), passed as a per-project duration override
   (0 = skipped). A step the file gives weeks but the app's table has at 0 for the base category
   cannot be revived (ADR 0019) and is reported. Without a `Process steps` sheet the app's lead-time
   table is used (warning). FTE stretches design steps as everywhere (ADR 0032).
7. **The plan year.** The file plans 2027 while the app's "today" is 2026 W42. Weeks are absolute
   (`1..52` = 2026, `53..104` = 2027). `plan_year_end_week` is 52 (2026) or 104 (2027, default for
   an import); "within the plan year" means `projected_end_week <= plan_year_end_week`;
   `horizon_weeks = plan_year_end_week + 26` so spillover is still told apart from left-out. This is
   the What-if only; DOMAIN_RULES' 52-week display rule is unchanged for every other surface.
8. **Capacity in the result** is computed per window (`2026 W42–W52`, `2027 W1–W52`) and per week:
   design load per capacity hub (effort spread evenly over a design step's span, so Σ = effort) vs
   `Σ FTE × working weeks per engineer / 52` per week (ADR 0008 supply, ADR 0042 capacity hubs);
   lab load per lab region (1 platform-week per project-week) vs `Σ efficient chamber weeks / 52`
   per week. Booked % and status use the ADR 0016 thresholds. Per-designer rows (booked weeks per
   window vs available) as on Capacity (ADR 0028).
9. **Gantt edits in the What-if** use the ADR 0019 + ADR 0043 fields (duration, earliest start,
   overlap) on any project of the simulation, held in the browser and sent with each simulate.
   Nothing is saved.
10. **Hub scope.** The simulation runs on the whole plan; rows of existing projects outside the
    caller's scope are not returned, capacity rows only for hubs/regions in scope (ADR 0031). The
    file's own rows are always returned (the caller supplied them).
11. **Bounds.** `.xlsx` only (magic-byte sniff), ≤ 5 MB, ≤ 2,000 data rows, ≤ 60 columns, formulas
    are read as cached values (never evaluated); ≤ 600 projects and ≤ 2,000 Gantt edits per
    simulate; per-user rate limit and the What-if time cap (`WHATIF_TIMEOUT`).

## Consequences

- The client can re-upload a new version of the same format at any time; nothing to clean up.
- Applying an imported plan for real (creating the projects) is a separate, later decision.

## Alternatives rejected

- *Persist the import as projects.* Not asked for, irreversible for a draft file the client calls
  "work in progress", and it would bypass Registration's required fields (ADR 0034).
- *Parse column letters.* The client edits the sheet; header names are stabler.

## Amendment (2026-11-04, owner ruling)

"On Hold project need not be mapped." A file row whose status is On Hold (or Cancelled /
Commercialized) is parsed with `include = false`, shown greyed on Review as "not mapped", and never
reaches the simulation, the Gantt, capacity or KPIs. In merge mode, a file row that matches a plan
project and says On Hold removes that project from the run (the file is the newer status).

## Amendment (2026-11-05, priorities workbook)

The client sent `2027 RPD Capacity Planning_Priorities.xlsx` (same two sheets). Its project sheet
has no `Status` column, renames `Num of Projects` to `Num of Models`, ranks PRIORITY 1..n per group
(one row `Running`), uses RPD HUB `Rom`, `Rom/Unbound`, `Rom/OEM`, `India`, leaves category, stage
and engineer mostly blank, and carries budget lines among the projects. Both formats are read
(P32-R06, issue codes in `docs/API_CONTRACT_P32.md` B2):

1. *Headers.* `Num of Models` ≡ `Num of Projects`; `Status` is optional.
2. *Status* for an absent column or a blank cell, first match wins: PRIORITY `Running` → In
   Development; the matched plan project's status (On Hold / Cancelled / Commercialized stay not
   mapped); `Spillover from 2026` = Yes → In Development; else In Queue. A file without the column
   gets one file-level info issue, not a warning per row.
3. *Priority.* `Running` → P1, rank 0 (first in its band; `priority_source` `running`). The engine
   takes ranks 1..9999, so the service passes rank + 1 (order kept; 9998 and 9999 would tie and
   fall back to the file row).
4. *Hub.* `Rom/<partner>` → PD-Romania; `Rom/OEM` → OEM-Seitek when Expenses mentions Seitek, else
   OEM-HCK (warning). A blank or unrecognised RPD HUB on a matched row takes the plan project's hub
   before the Expenses / Plant fallback.
5. *Category, stage, engineer* blank on a matched row → the plan project's category, current step
   (first step in walk order that is neither Done nor skipped in the live data, used only when it is
   a step of the row's workflow) and leader. Category is re-mapped to the hub's workflow
   (B ↔ B-OEM, A+/A → A-OEM, A-OEM → A, C ↔ C-OEM).
6. *Budget lines.* A blank-PRIORITY row whose description starts with `Provision`, starts with
   `Update certification`, contains `certification program`, or is a short CAPEX heading (at most
   three words before `CAPEX` and two after) is excluded (`include = false`, info `NOT_A_PROJECT`);
   the planner can include it on Review. The CAPEX rule is narrower than a bare `\bcapex\b`
   because a real feasibility project in the file mentions CAPEX mid-sentence.
