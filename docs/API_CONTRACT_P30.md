# API contract: P30, per-project effort drives the schedule and the load (ADR 0041)

Owner: backend-builder (P30-T02). Consumer: frontend-builder (P30-T03). Date: 2026-10-23.
Rules: `docs/DOMAIN_RULES.md` "Lead times" (`eff`, the one skip predicate), "Per-project effort",
"Capacity supply → Load basis", "Booked % and areas" (I19 rev.), "Step timing from the Gantt",
invariants I6/I7/I17/I19/I23 (rev.) and I25/I26 (new). Binding source: ADR 0041 with the
workflow-auditor's R1–R14.

Additive on the wire: no field is removed or renamed. What changes is **what three existing fields
mean**: on the Capacity surfaces `design_load_weeks` / `lab_load_weeks` are now **full-year demand**
(were: run-booked), the year `booked_pct` / `gap` / `completion_pct` pair with it, and the remaining
ones pair with the new **remaining demand**. The run-booked figure moves to new
`*_load_booked_weeks` fields. Error envelope unchanged:
`{"detail": string | [{loc, msg, type, input?}], "code"?: string}`.

## 0. Summary for the frontend

| Surface / endpoint | Change |
|---|---|
| `HubName` | `"OEM-Seltek"` → **`"OEM-Seitek"`** (DB enum renamed by migration `p30a`). No other hub changes. |
| `ProjectType` | gains **`"AC"`** "Alternative Component" and **`"SER"`** "Service" (served by `GET /reference/project-types`, labels from `domain_constants.PROJECT_TYPE_LABELS`). Dashboard `type_counts` / Hub × Type pick them up from the enum. |
| `ProjectRead` / `ProjectListItem` / `WorkspaceProject` | new `design_effort_weeks`, `lab_effort_weeks`, `safety_lab_weeks`, `actual_design_weeks`, `actual_testing_weeks` (`number \| null`), `safety_certification_required`, `capacity_flag` (`boolean`) |
| `ProjectCreateRequest`, `ProjectUpdateRequest` | accept `design_effort_weeks`, `lab_effort_weeks` (`number \| null`, 0..9999.99, ≤ 2 dp); new 422 `EFFORT_SPLIT_REJECTED` |
| `GanttStepRow` | new `effort_weeks: number \| null`; `duration_override_weeks` is the **user's** value only |
| `StepTimingResponse` (`PATCH /projects/{id}/steps/{step}/timing`) | new `effort_weeks`, `lead_time_weeks`; `effective_duration_weeks` = `user ?? effort ?? lead` (0 when skipped); new 409 `STEP_SKIPPED` case |
| `WorkspaceStage` | new `lead_time_weeks`, `duration_override_weeks`, `effort_weeks`; `duration_weeks` = effective |
| `GET /capacity/hub-load` (= `/capacity/hubs`) `HubCapacityRow` | `design_load_weeks` / `lab_load_weeks` = full-year **demand**; new `design_load_remaining_weeks`, `design_load_booked_weeks`, `lab_load_remaining_weeks`, `lab_load_booked_weeks`; booked % / gap / completion pairs per I19 rev.; `load_days` / `lab_load_days` `.remaining` = remaining demand |
| `CapacityHubMember` (ADR 0042 `members`) | `design_load_weeks` = demand; new `design_load_remaining_weeks`, `design_load_booked_weeks`, `booked_project_count`; `project_count` = projects in the full-year scope |
| `CapacityArea`, `CapacityTotals` | new `design_load_remaining_weeks`, `design_load_booked_weeks`, `lab_load_remaining_weeks`, `lab_load_booked_weeks` |
| `LabRegionCapacityRow` | new `load_remaining_weeks`, `load_booked_weeks` |
| `GET /priorities/capacity-fill`, Matrix / board / Workspace fill | numbers change only: the P1 capacity fill uses **remaining demand** (R12) |
| Engineer heatmap, resource load, what-if "before" | unchanged: still **run-booked** (R12) |

## 1. Vocabulary

```ts
type HubName = "R&D-Greece" | "R&D-India" | "PD-India" | "PD-Romania" | "OEM-HCK" | "OEM-Seitek";
type ProjectType = "NM" | "CO" | "RC" | "NO" | "IMP" | "AC" | "SER";
```

`GET /reference/project-types` → `[{code, label}]` in this order: NM "New Model", CO "Cost
Optimization", RC "Regulatory / Business Compliance", NO "New Option", IMP "Improvement", AC
"Alternative Component", SER "Service". AC/SER carry no scoring tag (ADR 0038 §6 unchanged).

Hub filters, pickers, hub-families / hub-geo maps and every fixture must use `OEM-Seitek`. Stored
schedule runs hold no hub strings (their rows join to `hubs`), so old runs read the new spelling.

## 2. Project fields

```ts
interface ProjectRead {               // also ProjectListItem, WorkspaceProject (+ hub, leader name)
  // ...existing fields...
  design_effort_weeks: number | null; // client col 16 "Process Design Man Week", 2 dp. Writable.
  lab_effort_weeks: number | null;    // client col 21 "Lab Weeks- Process Derived", 2 dp. Writable.
  safety_lab_weeks: number | null;    // col 22, display only
  actual_design_weeks: number | null; // col 17, display only
  actual_testing_weeks: number | null;// col 23, display only
  safety_certification_required: boolean; // col 24, display only
  capacity_flag: boolean;             // col 3 "considered for Capacity Calculation" = Y, display only
}
```

Write (`POST /projects`, `PATCH /projects/{id}`; Registration WRITE as before):

- `design_effort_weeks` / `lab_effort_weeks`: JSON number or `null` (PATCH `null` clears the
  figure: the lead-time table applies again). `0 ≤ x ≤ 9999.99`, at most two decimals, else 422
  `VALIDATION_ERROR`. Not financial, so they are audited in clear on `project.update`.
- A change of a figure, `category`, `certification_testing_required` or `hub_id` re-derives the
  project's step split (§3) in the same transaction and marks it `schedule_stale` (never solves).
- **422 `EFFORT_SPLIT_REJECTED`** (R7): the split would put one step above 104 weeks (e.g. a B
  project with 300 design weeks → PDD-E 120). `detail = [{loc: ["body", "design_effort_weeks" |
  "lab_effort_weeks"], msg, type}]`. Nothing is written. Also returned by
  `POST /gantt/projects/{id}/freeze` with `frozen: false` if a lead-time edit made while frozen
  pushed the stored figure over the limit.
- On a **frozen** project the figure is stored and validated, but the split is applied only on
  unfreeze (I10).

UI guidance (P30-T03): show the figures read-only in the Workspace / Projects register ("Design
effort (client)", "Lab effort (client)", "Safety cert.", the two actuals; badges "Carry-over
2024/25" from `carry_over`, "Capacity flag" from `capacity_flag`). Whether Registration offers an
editor for the two figures is the frontend's call; the API accepts them.

## 3. Step durations: user override, effort, lead

Per step (`eff`, DOMAIN_RULES "Lead times"):

```
eff = 0                                   lead = 0, or a lab step with certification testing off
eff = duration_override_weeks ?? effort_weeks ?? lead_time_weeks      otherwise
skipped ⟺ eff = 0
```

- `duration_override_weeks` (1..104 | null): the **user's** Gantt / Workspace figure only. A
  "timing edit" (`hasTimingEdit`) and the "(table T)" tooltip read only this field and
  `start_not_before_week`; they must ignore `effort_weeks`.
- `effort_weeks` (0..104 | null): the step's share of the project's figure (server-derived, never
  a user edit). 0 = the step is skipped.
- `lead_time_weeks`: the lead-time table value.

```ts
interface WorkspaceStage {
  // ...existing...
  duration_weeks: number;              // eff, except: a lab step skipped only because certification
                                       // testing is off shows its lead time (unchanged behaviour)
  lead_time_weeks: number;             // NEW
  duration_override_weeks: number | null; // NEW (user)
  effort_weeks: number | null;         // NEW (derived)
  skipped: boolean;                    // the run's flag, or the one predicate on the live row
}
interface GanttStepRow { /* ...existing... */ effort_weeks: number | null; }   // NEW
interface StepTimingResponse {
  // ...existing...
  effective_duration_weeks: number;    // user ?? effort ?? lead; 0 when skipped
  effort_weeks: number | null;         // NEW: what "Reset timing" falls back to
  lead_time_weeks: number;             // NEW
}
```

Step timing (`PATCH /projects/{id}/steps/{step}/timing`), changes only:

- **Reset timing** (both fields `null`) restores the **effort** value, not the table: the response's
  `effective_duration_weeks` equals `effort_weeks ?? lead_time_weeks`.
- A step the effort split zeroed (`effort_weeks = 0`, no user override): a request that sets a
  **new non-null** `duration_override_weeks` or `start_not_before_week` → **409 `STEP_SKIPPED`**
  ("…its effort share is 0 weeks…"). Clearing values is always allowed. A step that already carries
  a user override is not skipped (the override keeps it) and stays editable.
- `timing_editable` on the Gantt is `"none"` for any step the one predicate skips (lead 0, lab
  without certification, effective 0), even if the active run predates the split.
- Unchanged: lead-0 steps → 409 `STEP_SKIPPED`; a lab step with certification off accepts values
  (kept for later) with `recalc_status: "not_needed"`.

Workspace stage PATCH: an effort-zeroed stage → 422 `STAGE_SKIPPED` (as for lead-0 stages).

## 4. Capacity hub table (`GET /capacity/hub-load` = `/capacity/hubs`)

```ts
interface HubCapacityRow {
  // ...existing supply / days / members fields...
  design_load_weeks: number;            // CHANGED MEANING: full-year DEMAND (I25), integer weeks
  design_load_remaining_weeks: number;  // NEW: remaining DEMAND (I25), integer weeks
  design_load_booked_weeks: number;     // NEW: booked in the active run (I6), integer weeks
  lab_load_weeks: number;               // CHANGED MEANING: full-year lab DEMAND of the lab region, 2 dp
  lab_load_remaining_weeks: number;     // NEW, 2 dp
  lab_load_booked_weeks: number;        // NEW: run-booked lab of the region (I7), 2 dp
  design_booked_pct_year: number | null;     // design_load_weeks / design_capacity_year × 100
  design_booked_pct_remaining: number | null;// design_load_REMAINING_weeks / design_capacity_remaining × 100
  lab_booked_pct_year: number | null;        // lab_load_weeks / lab_capacity_year × 100
  lab_booked_pct_remaining: number | null;   // lab_load_REMAINING_weeks / lab_capacity_remaining × 100
  design_gap_year / design_completion_pct_year       // full-year demand vs yearly capacity
  design_gap_remaining / design_completion_pct_remaining // remaining demand vs remaining capacity
  lab_* gap / completion                              // same pairs
  design_load_by_priority: PriorityLoadSplit;  // splits design_load_weeks (full-year demand)
  lab_load_by_priority: PriorityLoadSplit;     // splits lab_load_weeks
  load_days: YearRemaining;      // year = design_load_weeks × wd, remaining = design_load_remaining_weeks × wd
  lab_load_days: YearRemaining;  // year = lab_load_weeks × lab wd, remaining = lab_load_remaining_weeks × lab wd
  lab_load_units: number | null; // deprecated: full-year lab demand of the row's own (+member) projects
  design_load_estimated_weeks / lab_load_estimated_weeks // deprecated (R13), kept one release
  members: CapacityHubMember[];
}
interface CapacityHubMember {
  hub: HubName; own: boolean;
  project_count: number;               // CHANGED: projects in the full-year scope (not Cancelled/Draft)
  design_load_weeks: number;           // CHANGED: full-year demand
  design_load_remaining_weeks: number; // NEW
  design_load_booked_weeks: number;    // NEW
  booked_project_count: number;        // NEW: projects with booked design work in the run
}
interface CapacityArea  { /* existing */ design_load_remaining_weeks: number; design_load_booked_weeks: number;
                          lab_load_remaining_weeks: number; lab_load_booked_weeks: number; }
interface CapacityTotals{ /* existing */ design_load_remaining_weeks: number; design_load_booked_weeks: number;
                          lab_load_remaining_weeks: number; lab_load_booked_weeks: number; }
interface LabRegionCapacityRow { /* existing */ load_remaining_weeks: number; load_booked_weeks: number; }
```

Definitions (I25; DOMAIN_RULES "Load basis"):

- **Full-year demand** = Σ `eff` over design-kind (lab-kind) steps of every project of the capacity
  hub (own + member hubs; lab: of the lab region) whose status is not Cancelled or Draft — **On
  Hold and Commercialized are included** (client ruling).
- **Remaining demand** = the same over projects in a schedulable status (In Buyoff, Under
  Industrialization, In Development, In Queue), counting per stage: Done 0; In Progress / Blocked
  the derived remaining duration; Not Started `eff`.
- **Booked** = what the active run booked (non-skipped rows, effort weeks). With no active run it is
  0 while demand is still served.
- Demand is independent of the active run and of the caller's scope (aggregate rows, ADR 0042 §8);
  `members` lists in-scope hubs only, and each of its three load fields sums to the row's field
  when the caller sees every member. Areas / totals sum design per row and lab per region once.
- No booked % / status / gap / completion is served for the booked figure (I19 rev.). The browser
  derives nothing.

UI guidance: relabel the load column "Full-year demand", add "Remaining demand" (paired with the
remaining capacity / remaining booked %) and "Booked in plan" (`*_load_booked_weeks`, no %). The
Greece members breakdown shows demand and booked per member. The Gantt's per-project design / lab
weeks reconcile with `*_load_booked_weeks` (I23 rev.), not with the demand.

## 5. Other readers (R12)

- **P1 capacity fill** (`GET /priorities/capacity-fill`, Matrix / board / Workspace / export fill
  fields): `load(p)` = p's remaining design demand. `capacity_weeks`, `base_load_weeks`,
  `filled_load_weeks` and `capacity_fill_reason` figures change accordingly; shape unchanged. Still
  no promotion without an active run.
- **Engineer utilization** (`/capacity/engineer-utilization`, `/capacity/utilization-matrix`,
  `/planning/resource-load`) and the **what-if "before"** stay run-booked; they reconcile with
  `*_load_booked_weeks`.
- **Dashboard**: serves no capacity card today; any future one reads the fields above.
- **Capacity export**: the `members` cell reads e.g. `R&D-Greece 6 project(s) 77 wk demand, 56 wk
  remaining, 57 wk booked; OEM-HCK …`.

## 6. Audit (read-only for the frontend)

- `project.effort_rederived` (entity `Project`): one row per re-derivation that changed a step's
  effort. `before_state.effort_weeks` / `after_state.effort_weeks` per step; `after_state.trigger`
  ∈ `project_create`, `effort_figure`, `project_fields`, `workflow_change`, `lead_time_edit`,
  `step_kind_edit`, `unfreeze`, `stage_status`; `design_split` / `lab_split` with `applied`,
  `not_applied_reason` (`no_figure` | `no_nonzero_step` | `certification_off`), `target_weeks`,
  `raised_step_ids` (R3).
- `project.update` before/after now include `design_effort_weeks`, `lab_effort_weeks`,
  `certification_testing_required`.
- Workflow Settings PUT audit rows add `effort_rederived_projects` (count).

## 7. Fields still red in `tests/test_openapi_frontend_contract.py` until P30-T03 mirrors them

`HubCapacityRow`, `CapacityHubMember`, `CapacityArea`, `CapacityTotals`, `LabRegionCapacityRow`
(the `*_load_remaining_weeks` / `*_load_booked_weeks` / `load_remaining_weeks` /
`load_booked_weeks` / `booked_project_count` fields), `GanttStepRow` (`effort_weeks`),
`StepTimingResponse` (`effort_weeks`, `lead_time_weeks`), `ProjectCreateRequest`
(`design_effort_weeks`, `lab_effort_weeks`), `ProjectRead` and `WorkspaceProject` (the seven
project fields of §2), `WorkspaceStage` (`lead_time_weeks`, `duration_override_weeks`,
`effort_weeks`).
