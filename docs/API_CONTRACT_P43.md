# API contract: P43, presentable Excel exports with a drawn Gantt (ADR 0057)

*Written at P43-T02 (2026-11-17). Binding for P43-T03 (frontend).*

Presentation only: no scheduler, KPI, data-scope or role change. Every export keeps the RBAC, hub
scope, financial-field rules and formula guard it had before P43.

## 1. What changed for every `.xlsx`

One styled writer (`backend/services/xlsx_writer.py`) builds every workbook:
- `/exports/{surface}` (sync and async jobs);
- the What-if import exports (current result, saved scenario, comparison);
- the import template;
- the new What-if planner export (§3).

**Table sheets** (every data sheet):

| Row | Content |
|---|---|
| 1 | Title (e.g. "Gantt — schedule data", "Dashboard — project analytics") |
| 2 | Context: counts, then `Scope: …` and `Filters: …` (surface exports), or the scenario and week |
| 3 | `Generated YYYY-MM-DD HH:MM UTC` |
| 4 | blank |
| **5** | **Header row** (`TABLE_HEADER_ROW = 5`): human column names, navy fill, white bold text |
| 6+ | Data |

- Frozen at `B6`: the header and the first column stay visible.
- Auto-filter on the header row.
- Column widths sized to the content.
- Booleans are written as **Yes / No** (CSV keeps `True` / `False`).
- Decimals use `#,##0.00`. Empty values are empty cells.
- Rows are banded by one conditional format.
- Print setup: landscape, A4, fit to one page wide, header row repeated.

**Report sheets** (`Summary` of an import scenario and of the planner export): a small key / value
report under the same title block. The header is `Item | Value` on row 5. Section headings are rows
with a blue fill (e.g. "Scenario", "Plan", "Results"). Item names are human (`plan_year_end_week` →
"Plan year ends (week)").

**Formula guard.** Every text cell, including chart labels, legend and titles, goes through the
P13-F10 guard (`'` prefix on `= + - @ \t \r`) and is written as a text cell. No cell is a formula.
Every header label goes through the same guard, in CSV and xlsx alike (P43-R01, security M-1): a
header can be user text, e.g. an Admin-edited rubric label on the Matrix.

**Human column names.** `snake_case` keys become words. There is a shared map
(`xlsx_writer.HEADER_LABELS`, e.g. `planned_start_week` → "Planned start (week)", `tcogs_eur` →
"TCOGS (EUR)", `leader_name` → "Leader"), and the rest are humanised word by word (`id` → ID, `pct`
→ %, `eur` → (EUR), `fte` → FTE, …). On the Matrix export, each scoring-dimension column is headed by
its **rubric label** (it used to be headed by its key). OQ #112 records that downstream scripts that
parse the old headers break.

**CSV.** Only the header row changes, to the same human names. Values, order, encoding (UTF-8 with
BOM) and the formula guard are unchanged.

## 2. Sheets per export

| Export | Sheets, in order |
|---|---|
| `GET /exports/gantt?format=xlsx` | **Gantt** (drawn, new), **Gantt data** (the former `Gantt` table, renamed) |
| `GET /exports/gantt?format=csv` | the Gantt data table (unchanged columns, human headers) |
| `GET /exports/dashboard` | Dashboard |
| `GET /exports/capacity` | Capacity |
| `GET /exports/matrix` | Matrix |
| `GET /exports/project-registration` | Projects |
| `GET /exports/capacity-planning` | Engineers, Chambers |
| `POST /whatif/import/export.xlsx` | Summary, **Gantt** (new), Breakdown, Projects, Steps, Capacity |
| `GET /whatif/import/scenarios/{id}/export.xlsx` | Summary, **Gantt** (new), Breakdown, Projects, Steps, Capacity |
| `GET /whatif/import/scenarios/compare.xlsx` | KPIs, Outcome changes, **Gantt S1** … **Gantt S4** (one per compared scenario, new) |
| `GET /whatif/import/format/template.xlsx` | Projects, Process steps (header styling only, see §4) |
| `POST /whatif/export.xlsx` (**new**, §3) | Summary, Gantt, Gantt data |

- For import scenarios, the existing **Steps** sheet is the numeric "Gantt data" table. It is not
  renamed.
- The comparison's `KPI` column now shows human names ("Plan excluded", "Source file",
  "Within plan year"). The scenario column headers (`S1: <name>`, `S2 - S1`) are unchanged.
- Filenames and `Content-Disposition` are unchanged.

## 3. New route: `POST /whatif/export.xlsx`

The plain What-if planner (simulate) had no export. It now has one.

- **Body:** `SimulateExportIn`, strict, unknown keys → 422.

  ```json
  { "scenario": { …same ScenarioRequest as POST /whatif/simulate… }, "name": "optional, 1..120 chars" }
  ```

  A `result` key is rejected (422). The server always simulates again.
- **Response:** `200`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
  - `Content-Disposition: attachment; filename="<safe name>.xlsx"`. Without a name, the file is
    `whatif-scenario.xlsx`.
  - `Cache-Control: no-store`.
- **RBAC:** the What-if read, `CAPACITY_PLANNING / READ`. That is Portfolio Manager, Hub Planner,
  Admin and Super Admin. Everyone else gets 403.
- **Hub scope:**
  - As for `/whatif/simulate`, only projects in the caller's hubs are drawn and listed.
  - A scenario that names an out-of-scope **hub or lab region** gets 403 `SCENARIO_OUT_OF_SCOPE`.
  - A scenario that names an out-of-scope **project, engineer or chamber id** gets 422
    `INVALID_SCENARIO`, exactly like an unknown id. This is deliberate, so the response never
    reveals that the id exists (P43-R01, security I-1).
- **Rate limit (P43-R01, security L-1):**
  - The export has its own per-user bucket, `WHATIF_EXPORT_RATE_LIMIT`: 6 requests, refilling one
    every 10 s. Over it, the answer is 429 with `Retry-After`. It does not use the shared What-if
    bucket.
  - Both the simulation and the workbook write run inside the per-user What-if in-flight slot
    (`run_capped`, one heavy job at a time). A second heavy What-if call while one runs is 429
    with `Retry-After: 2`.
- **Errors:** the same as simulate: 422 `INVALID_SCENARIO`, 503 `WHATIF_TIMEOUT` (the workbook
  write shares the 20 s cap).
- **Audit:** one `whatif.export` row, coalesced like simulate. It holds the scenario shape, the
  project count and `named: true/false`. It never holds the name or the result.
- **Sheets:**
  - **Summary:**
    - Scenario: name, projects / designers / chambers added, designers removed, downtime changes,
      priority overrides;
    - Within the year: before, after, change, existing before / after, new and new within the year;
    - Changes: newly slipping, recovered, otherwise moved;
    - Outcomes after and before the scenario, per outcome class;
    - How it was computed: the simulate `workings`.
  - **Gantt:** the drawn chart of the scenario's schedule (§5).
  - **Gantt data:** one row per in-scope project × step. Columns: `project_id` (blank for a new
    hypothetical project), `project_name`, `hub`, `category`, `priority`, `priority_label`,
    `is_new`, `frozen`, `outcome` (class), `outcome_label`, `finish_week`, `within_year`,
    `counts_toward_year`, `not_scheduled_priority`, `step_id`, `step_name`, `kind`,
    `sequence_order`, `duration_weeks`, `start_week`, `end_week`, `skipped`, `pinned`,
    `engineer_name`, `chamber_code`. Headers are human, as in §1.
- **Names:**
  - Step rows name the assigned engineer or chamber, as `GET /gantt` serves them to every reader
    (ADR 0028).
  - The project row's leader column is blank. `GET /gantt` serves a leader name only to that
    leader (OQ #8).
  - Nothing financial is in a scenario.
- **Same weeks as simulate:** the step weeks come from the same pure engine calls
  (`apply_scenario` then the greedy SGS, deterministic). Every `finish_week` equals the
  `SimulateResponse` one for the same scenario at the same plan week.

## 4. Import template

- Header row 1 is styled (fill, bold, frozen below, widths).
- No title block. Header text and cell positions are exactly as before.
- The parser reads it unchanged (round-trip test).

## 5. The drawn "Gantt" sheet

| Rows | Content |
|---|---|
| 1-3 | Title, context, generated line plus "Legend: row N, below the chart" |
| 4 | Year band over the week columns: `2026 (from W1)`, `2027 (from W53)` |
| 5 | Header: `Project / step`, `Hub`, `Priority`, `Leader / engineer`, `Start`, `End`, `Outcome`, then week numbers `1`..horizon |
| 6+ | One **project row**, then its **step rows** indented beneath |
| after a blank row | **Legend** |

**Layout:**
- Freeze panes at `H6`: the fixed columns and the header stay visible.
- Auto-filter on A5:G (step rows repeat hub and priority, in grey, so a filter keeps them).
- Week columns are narrow. The horizon is the source's: 78 for the plan, the scenario's
  `horizon_weeks` for an import. It widens to the last served week if one is later, so a bar is
  never cut.

**Project row:**
- bold name, with "(frozen)" when frozen;
- hub;
- `P1 · Must do this year` (`domain_constants.PRIORITY_LABELS`);
- leader;
- start and end as `W12`-formatted numbers;
- the outcome as coloured bold text.

Its bar is slate grey from the first step's start to the last step's end, or the served project
span where the source has one (import).

**Step row:**
- `A · Marketing Brief`, with "(pinned)" or "(skipped)" where they apply;
- the engineer or chamber;
- start and end;
- the kind (Design / Lab / Elapsed).

Its bar fills **exactly the served `start..end` weeks (inclusive)**:
- `GET /gantt` `planned_start_week..planned_end_week`;
- import `start_week..end_week`;
- the planner's engine rows.

A skipped step draws no bar. The step letter is written in the bar's first cell.

**Colours** (the app's step palette, `frontend/src/surfaces/gantt/lib/step-colors.ts`
`STEP_PALETTE_HEX`, slot = step letter A..N, PDD and OEM share slots):

| Slot | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Hex | 1A6FE0 | 8B7FFF | 0D9488 | 00C9A7 | F59E0B | E11D48 | 7C3AED | 2563EB | 059669 | D97706 | DB2777 | 4F46E5 | 0891B2 | 65A30D |

- **The colour is by step, as on screen since P40, not by kind.** The kind is in the step row's
  last fixed column and in the legend.

**Markers:**
- **Frozen project:** its bars are hatched (`lightUp`, white stripes over the step colour).
- **Pinned step:** the bar has a medium dark outline.
- **Current week:** the header cell is amber `F59E0B` and the empty cells of that column are pale
  amber `FEF3C7`.
- **W52 (and W104):** a medium red `DC2626` right border down the whole column.
- **Weeks after W52:** a grey header (`CBD5E1`).

**Outcome text and colour:**
- The served `outcome_label` when there is one: "Not scheduled (P4)", "Queued — fits by W40", …
- Otherwise the outcome's name, coloured:

| Outcome | Text | Colour |
|---|---|---|
| within year | Within year (import: "Within plan year") | green 15803D |
| spillover | Spillover | amber B45309 |
| left out | Spillover · unplaced (the screen's wording) | orange C2410C |
| blocked | Blocked | red B91C1C |
| queued | served label, else Queued | blue 1D4ED8 |
| not scheduled (P4) | Not scheduled (P4) | slate 64748B |
| status-excluded | Not in the plan (status) | slate 64748B |
| Commercialized (any source with a status) | Delivered — counts as within year (P43-R02) | green 15803D |
| data error | Data error | red B91C1C |
| none | No run outcome | slate 64748B |

**Legend**, below the chart:
- every step present (letter, served name, code, kind, swatch);
- the markers (project span, frozen, pinned, current week, year end, next year);
- the outcome colours.

## 6. Frontend work (P43-T03)

- **What-if planner (Simulate view):**
  - add an "Export to Excel" button;
  - it sends `POST /whatif/export.xlsx` with the current `scenario` and an optional name;
  - download the blob, using the `Content-Disposition` filename;
  - handle 403, 422, 429 (`Retry-After`) and 503 like simulate.
- **Gantt page:** the existing export now yields the drawn chart. The button copy may say "Excel
  (chart + data)". No API change.
- **What-if import:** the current-result, saved-scenario and compare exports already exist. Each now
  carries Gantt sheets. Copy only.
- Nothing in the browser parses export headers today. If any test fixture asserts on CSV header
  names, it needs the human names.

## 7. P43-T02 rework (2026-11-17, coordinator review of the rendered samples)

Everything below supersedes the matching parts of §1, §2 and §5.

**Sheets per export (supersedes §2 for surface exports).** Every `/exports/{surface}` xlsx now starts with a **Summary** sheet. CSV is unchanged: still the one data table, in its served column order, with human headers.

| Export | Sheets, in order |
|---|---|
| Gantt | Summary, Gantt, Gantt data |
| Dashboard | Summary, Dashboard |
| Capacity | Summary, Capacity |
| Matrix | Summary, Matrix |
| Project registration | Summary, Projects |
| Capacity planning | Summary, Engineers, Chambers |

What-if import and planner exports keep their sheets as in §2 (they already open on a Summary or KPIs sheet).

**Summary sheets.** One or more small formatted tables, each with a heading bar, a navy header row, banded rows and an optional note. Shares are formatted `0.0%`.
- **Dashboard.** From the served `GET /dashboard/completing-within-year` read (the P42 figures), with the export's hub, region, category and type filters:
  - "Delivery this year": within year, spillover, spillover · unplaced, blocked, the counting denominator, within-year share, queued (P3), not scheduled (P4), not in the plan. Every share on a Summary sheet, the headline included, is a 1-decimal percent number format (`0.0%`, e.g. 57.0%) (P43-R01);
  - "By priority": the served `priority_delivery` bands;
  - "By hub": each served row's outcome bucket, counted per hub, with the hub's share;
  - "By country": the served `regions`.
  The status, priority, search, leader and step filters apply only to the Dashboard table, as on screen.
- **Gantt:** projects by served outcome bucket, by priority, and step counts (placed, skipped, pinned).
- **Matrix:** scored / not scored / promoted by the capacity fill, by suggested band, by set priority.
- **Project registration:** by status, priority and hub.
- **Capacity:** the served booked % and booking status per capacity hub.
- **Capacity planning:** engineers per hub (all, active, active FTE), chambers per lab region (count, platforms).

**Data sheets (supersedes the column layout in §1).**
- **Column order:** the identifying columns come first, in this order where present: `project_name` / `name`, `code`, `hub`, `priority` / `set_priority`, `status`, `step_name`. They are frozen (e.g. freeze at `E6`). Internal id columns (`id`, `*_id`, `*_ids`, `ref`, `source_file_sha256`) move to the far right. Everything else keeps its served order in between. A sheet with no identifying column freezes column A, as before. The import template is untouched.
- **Header text wraps**, with a row height to match. Columns are sized to their content, capped at 36.
- **Readable added columns:**
  - the Project registration and Engineers sheets gain a `hub` (name) column, since the rows only carry `hub_id`;
  - Capacity's `chambers` becomes one readable cell ("CODE (n platform(s)); …").

**Drawn Gantt (supersedes ordering in §5)**, for every drawn Gantt: surface, planner, import current, saved and comparison.
- **Sections**, in this order, each under a blue heading row:
  1. "In the plan";
  2. "Queued (P3) — spare capacity only, not counted this year";
  3. "Not scheduled (P4)";
  4. "Not in the plan (status: On Hold, Cancelled, Draft, …)".
  The headings are omitted when every project is in the plan. In the surface Gantt, a project with no outcome bucket and no placed step goes in the last section.
- **Order within a section:** priority P1, P2, P3, P4, Q (none last), then band rank (none last), then name. The band rank comes from the project's `band_rank` on the surface export and from the engine input on the planner. Import results carry no band rank, so they are ordered by priority, then name.
- **Markers in the project name:** "(VIP)" and "(frozen)".
- **Not-scheduled and not-in-the-plan projects** get one line each, with no step rows.
- **Outline grouping:** step rows are at row outline level 1 under their project row, with the summary above (`summaryBelow=false`). Everything is expanded by default, so a user can collapse each project to its bar.

## 8. P43-R01 (2026-11-18): gate remediation

**Security fixes:**
- **M-1:** every CSV and xlsx header label goes through the formula guard (§1).
- **L-1:** `POST /whatif/export.xlsx` has its own rate limit, and the workbook is written inside the per-user What-if slot (§3).
- **I-1:** an out-of-scope id gives 422 `INVALID_SCENARIO` (§3).

**Workflow advisories:**
- **A1:** in the Dashboard Summary "By priority" table, the served `counting_total` column is headed "Counted (incl. on hold / cancelled)". A note under the table gives the served identity: Σ counted = the headline denominator + the projects not in the plan (on hold, cancelled, draft, data error or no run outcome). This is copy only; the figures are unchanged. Every share on a Summary sheet is a 1-decimal percent.
- **A3:** the surface "Gantt data" sheet (and its CSV) gains a `skipped` column ("Skipped", Yes / No in xlsx, True / False in CSV), right after `kind`. The planner's Gantt data and the import Steps sheet already had it.
- **A4:** a frozen P4 / Q project books its locked capacity but is not counted (R42-2, OQ #107). Its outcome bucket is QUEUED, but every drawn Gantt draws it under its own section, "Locked P4 / Q — booked, not counted", right after "Queued (P3)", with steps and hatched bars.
  - The new section order is: In the plan, Queued (P3), Locked P4 / Q, Not scheduled (P4), Not in the plan.
  - This applies wherever the frozen flag is known: the surface Gantt and the planner. The import result serves no frozen flag.

## 9. P43-R02 (2026-11-18): QA gate gaps and the G5 ruling

- **G1** (fixed at R01). Every Summary share is `0.0"%"`. On the Dashboard Summary the share is the last column (H) of every table: "By priority" is now Priority, Meaning, Projects, Counted (incl. on hold / cancelled), Within year, Queued, Not scheduled (P4), Within-year share. Non-share labels don't use the word "share" ("Counting projects (the denominator)").
- **G2.** The Capacity per-priority load columns read "Design load P1 (weeks)" … "Lab load Queue (weeks)". A key with a capitalised segment is now humanised too.
- **G3.** The comparison "Outcome changes" week columns read "S{n}: <name> finish (week)". The `S{n}: <name> outcome` columns are unchanged.
- **G4.** The identifying columns are, in order: `project_name`, `name`, `project`, `code`, `hub`, `priority`, `set_priority`, `step_name`, `step_id`, `status`. `step_id` is a step code, so it is not moved right as an id. The import Steps sheet therefore starts Project, Step code, Status and is frozen at D6, with Ref last.
- **Empty tables** keep their header row: the headers come from the row model's fields, with nested fields unexpanded. For example, Chambers with no chambers.
- **Wording.** A status-excluded project's outcome reads "Not in the plan (status)" everywhere: chart text, legend, the planner Summary and import charts. The section heading stays "Not in the plan (status: On Hold, Cancelled, Draft, …)".
- **G5 (coordinator ruling).** Commercialized projects count as within year (DOMAIN_RULES, OQ #109).
  - **Every drawn Gantt** draws them in their own section, "Delivered (Commercialized) — counts as within year", right after "In the plan". It is one line each, with no bar and no step rows, and the outcome reads "Delivered — counts as within year" in green.
  - **Status source:** the surface Gantt reads the project status with the same scoped id lookup as the band rank. The planner reads it from its engine input, the import from the served `status`.
  - **Section order** is now: In the plan, Delivered, Queued (P3), Locked P4 / Q, Not scheduled (P4), Not in the plan.
  - **Planner Summary:** the "Outcomes after / before the scenario" tables split the served `excluded` class into "Not in the plan (status)" and "Delivered (Commercialized) — counts as within year" (served flags: `outcome = excluded AND within_year`). They end with "Within year, in total (the headline above)" = Within year + Delivered, which equals "Projects within the year after / before". The What-if classifier and every served figure are unchanged.
