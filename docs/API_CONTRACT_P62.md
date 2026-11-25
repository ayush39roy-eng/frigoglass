# API contract — P62: Lab hold weeks (room weeks)

Source of truth: DOMAIN_RULES "Lab hold weeks" (R62-0 … R62-13, I64–I67) and ADR 0071 (Accepted
2026-11-25). This contract is the hand-off from P62-T02 to P62-T03 (engine), P62-T04 (backend) and
P62-T05 (frontend). Where the code differs from a name or shape below, the backend-builder may adjust
it at T04 and must record the change in its MEMORY entry; the semantics may not change.

Vocabulary: **length** `n` = the step's weeks on the path (unchanged); **room weeks** / **hold** =
how many of those weeks book a chamber, always the **last** ones. NULL = "Full" (the whole length).

`partialRoom(p,s) ⟺ kind(s) = lab ∧ plan_lab_hold_weeks(p,s) IS NOT NULL`.

## 1. Storage (migration `p71a_lab_hold_weeks`, T04)

| Table | Column | Type | CHECK (I65) |
|---|---|---|---|
| `workflow_lead_times` | `lab_hold_weeks` | `int NULL` | `lab_hold_weeks IS NULL OR (lab_hold_weeks >= 0 AND lab_hold_weeks <= weeks)` |
| `project_workflow_steps` | `plan_lab_hold_weeks` | `int NULL` | `plan_lab_hold_weeks IS NULL OR (plan_lab_hold_weeks >= 0 AND plan_lab_hold_weeks <= plan_weeks)` |
| `schedule_run_project_steps` | `lab_hold_weeks` | `int NULL` | `lab_hold_weeks IS NULL OR (lab_hold_weeks >= 0 AND lab_hold_weeks <= duration_weeks)` |

The data steps all run in one transaction, in this order:

1. **Template defaults.**
   - PDD-J and PDD-L get `lab_hold_weeks` = 1 for A+, A and B.
   - C/PDD-J gets `weeks` 1 → 0 and `lab_hold_weeks` = 0. C/PDD-L gets `lab_hold_weeks` = 0 (its
     `weeks` is already 0).
   - OEM-J / OEM-L get values only if their kind is `lab` at migration time: A-OEM and B-OEM 1,
     C-OEM 0. On hosted they are not `lab`, so they stay NULL.
   - `template_version + 1` on each changed category.
   - Audit: one `workflow_template.applied` per category, with reason `p62_lab_hold_defaults`.
2. **Hold copies** (R62-7). `plan_lab_hold_weeks` is copied from the template for **every**
   project, including reached / frozen / Cancelled / Commercialized ones.
   - Audit: one `project.lab_hold_backfilled` per changed project.
3. **C/PDD-J length** (R62-11, R62-12). `plan_weeks` 1 → 0 on `¬never` pairs only (P33 §C),
     **whatever ownEffort says**.
   - Audit: `project.template_applied` with `weeks [1, 0]`.
   - Reached / frozen / Cancelled / Commercialized C projects keep their J.
4. **R62-1 re-derivation.** Trigger `lab_hold_default`; scope: every non-frozen project with a
   figure.
   - Lab S′ excludes `partialRoom` steps; their `effort_weeks` → NULL.
   - R3 raises and the ADR 0070 hold-back apply. There is **no `started_share` refusal**.
   - Audit: `project.effort_rederived`.
5. `schedule_stale = true` on every schedulable project. **No run is dispatched** (ADR 0069).

Downgrade drops the three columns. It does not restore C/PDD-J `weeks` = 1 or the old splits; the
audits record the before values, and that is noted in the migration docstring. Test up / down / up.

R62-1 (step 4), R62-2 and R62-11 (steps 1 and 3 for C) each sit behind one clearly named function so
that each can be reverted alone.

## 2. Engine input / output (T03; `backend/scheduling/types.py`)

- `StepInput.lab_hold_weeks: int | None = None`. None = full. The canonical input and the snapshot
  **omit** None (R33-7 style), so all-NULL input hashes are unchanged.
- The live builder (`services/schedule_persistence.py`) maps each step:
  - `lab_hold_weeks = plan_lab_hold_weeks` on lab steps, None otherwise;
  - a `partialRoom` step: `lead_weeks = plan_weeks` (None when equal to the table),
    `duration_override_weeks = user override` (never `effort_weeks`);
  - the certification-off skip is evaluated with `¬partialRoom` (R62-2). The engine receives the
    hold, so `is_step_skipped` must take it into account: one predicate, scheduler and service
    side.
- Per placed step the output carries `lab_hold_weeks` (the booked `h`, 0..n) on lab rows and None on
  non-lab rows. `assigned_chamber_id` is None when `h = 0` (I64).
- Run row `schedule_run_project_steps.lab_hold_weeks` = that `h`. NULL on non-lab rows; on rows
  written before p71a it is NULL and read as `duration_weeks`.

## 3. Template read

### 3.1 `GET /workflow-settings`

Each `lead_times[]` entry gains:

| Field | Type | Meaning |
|---|---|---|
| `lab_hold_weeks` | `int \| null` | room weeks; null = Full. Served on every row, null on non-lab rows (a stored value on a now-non-lab row is served as null, R62-3 / ADR §1). |

### 3.2 `GET /workflow-settings/category-timelines` and `POST /workflow-templates/timeline-preview` (C2 object)

Each `steps[]` entry gains:

| Field | Type | Meaning |
|---|---|---|
| `lab_hold_weeks` | `int \| null` | the template value (null = Full; null on non-lab steps) |
| `room_weeks` | `int` | `h = min(hold ?? duration, duration)` on a lab step, 0 otherwise |
| `room_start_week` | `int \| null` | `start_week + duration_weeks − room_weeks` (0-based offset, the step's own convention, end-exclusive); null when `room_weeks = 0` |

Each category:

- `lab_weeks` becomes **Σ `room_weeks`** over lab steps (I66; this is the L total of the Matrix
  "D/L").
- New `lab_length_weeks` (int) = Σ `duration_weeks` over lab steps (the old value), for the bar
  legend.
- `total_weeks` (critical path) is unchanged in meaning.

## 4. Template write (P33 apply — a third change kind)

### 4.1 Step override (timeline-preview `steps[]`, apply E1 `changes[].steps[]`)

`TemplateStepOverride` gains `lab_hold_weeks: int | "full"` (optional):

- an omitted field keeps the saved value;
- `"full"` sets NULL;
- an integer must be in `0..weeks`, where `weeks` is the override's `weeks` if given, else the
  saved value. Otherwise 422 `LAB_HOLD_OUT_OF_RANGE`.

The validator now needs at least one of `weeks`, `gap_weeks` or `lab_hold_weeks`.

Other rules:

- **Non-lab step:** a non-null `lab_hold_weeks` gives 422 `LAB_HOLD_NOT_LAB`. Sending `"full"` on a
  non-lab step is a no-op and is accepted.
- **Length below the saved hold:** when `weeks` is lowered under the saved hold and the request has
  no `lab_hold_weeks`, the server clamps the hold to the new `weeks`. The clamp is listed in the
  preview as flag `room_weeks_clamped`, so I65 always holds.
- **`NO_CHANGE`:** a step whose three values all equal the saved ones gives 422 `NO_CHANGE`, as
  today.

### 4.2 `POST /workflow-templates/apply-preview` (E2)

`ApplyPreviewStep` gains:

| Field | Type |
|---|---|
| `hold_before` | `int \| null` (the copy's `plan_lab_hold_weeks`) |
| `hold_after` | `int \| null` |

New step flags:

- `room_weeks_clamped`: see 4.1.
- `lab_split_rederived`: the hold flips NULL ↔ non-NULL on an own-lab-figure pair, so this project's
  lab split is re-derived (R62-8). The list shows the new F/H/J/L `eff` in
  `eff_before` / `eff_after` on each affected step.
- `partial_room_length_applied`: a length change on a `partialRoom` step of an own-lab-figure pair.
  It **is** applied (R62-12), and the `own_effort_length_not_applied` flag is not set.

A project whose only change is a hold is listed in `automatic` / `choosable` like a length change.
`own_effort` never lists a hold-only change (R62-8: written whatever ownEffort says).

### 4.3 `POST /workflow-templates/apply` (E3)

- `plan_lab_hold_weeks` is written on `¬never` receiving pairs; on own-effort pairs as well (R62-8).
- On a `lab_split_rederived` pair, the R6 re-derivation runs in the same transaction: trigger
  `lab_hold_change`, audit `project.effort_rederived`, no `started_share` refusal.
- Audit payloads `workflow_template.applied` / `project.template_applied` gain
  `lab_hold_weeks: [before, after]` per changed step.
- **Hold-only apply:** marks the projects stale and dispatches nothing (manual mode, ADR 0069). The
  response's run field is `not_needed`.
- **Permissions:** unchanged, `workflow_templates.write` (Admin, Super Admin).

### 4.4 Registration / category change / workflow change

These copy `lab_hold_weeks` with `weeks` and `gap_weeks` (P33 E4): all 14 rows at registration, and
the not-reached rows on a category change. R6 then re-derives with R62-1.

## 5. Gantt — `GET /gantt`

`GanttStepRow` gains:

| Field | Type | Meaning |
|---|---|---|
| `lab_hold_weeks` | `int \| null` | the run row's booked `h` (null on non-lab rows; a pre-p71a run serves `duration_weeks` on lab rows) |
| `plan_lab_hold_weeks` | `int \| null` | the project's copy (null = Full), next to `lead_time_weeks` |
| `room_start_week` | `int \| null` | first held week = `planned_end_week − h + 1` (same inclusive convention as `planned_start_week` / `planned_end_week`; T04 confirms it against the run row convention). Null when `h = 0`, skipped, or not placed |
| `room_end_week` | `int \| null` | = `planned_end_week` when `h > 0`, else null |

`assigned_chamber_code` is null when `h = 0`. `chamber_overlap` refers to held weeks only.

`GanttProjectRow.lab_weeks` = Σ `h` over the project's non-skipped lab rows of the active run (I66).
Before: Σ eff.

`GET /exports/gantt`: one "Room weeks" column per lab step. The step's length column is unchanged.

## 6. Readers that serve lab **load** (served fields; numbers change, shapes do not)

Each of these counts `h` (NULL = `duration_weeks`) instead of the step length, per DOMAIN_RULES
"Lab hold weeks" / Readers. T04 confirms the list by grep and records any addition.

| Endpoint / service | Field(s) |
|---|---|
| `GET /capacity/hubs`, `/capacity/hub-load` | `lab_load_booked_weeks`, booked %, gap, completion % (I66 = Σ h) |
| `GET /capacity/class-breakdown`, `/capacity/utilization-matrix`; `services/capacity_priority.py` | lab load by priority, booked % |
| `GET /chambers`, `/chambers/{id}`; chamber weekly occupancy | utilisation and occupancy count held weeks only |
| `GET /planning/capacity-summary`, `/planning/resource-load` | lab load |
| `/priority-board` cards; `services/project_cards.py` | per-project lab weeks |
| Dashboard lab KPIs / capacity cards | follow the served fields (no recomputation, I9) |
| `POST /whatif/estimate`, `/simulate`, `/solve`, `/ask` | before / after lab load. The BUG-2 windowing counts the held weeks inside the window (R62-10) |
| `POST /whatif/import/parse`, `/import/simulate`; saved scenarios | file projects take the hold and the C/PDD-J length from the template (R62-9) |
| Demand (`scheduling/demand.py`, I25 lab half) | `min(hold, eff)` / `min(hold, rem)` |
| Exports: register, capacity, matrix, What-if xlsx | a "Room weeks" column where lab weeks are shown; the lengths are unchanged |

**Unchanged:**

- Workspace progress weights (I12, R62-6);
- capacity supply / `efficient_lab_weeks` (R62-10);
- design load;
- elapsed steps.

## 7. Error codes and audit actions (new)

**Error codes:**

| Code | HTTP | When |
|---|---|---|
| `LAB_HOLD_NOT_LAB` | 422 | a non-null hold on a non-lab step |
| `LAB_HOLD_OUT_OF_RANGE` | 422 | a hold outside `0..weeks` |

**Audit actions:**

- `project.lab_hold_backfilled` (migration);
- reason `p62_lab_hold_defaults` on `workflow_template.applied`;
- R6 triggers `lab_hold_default` (migration) and `lab_hold_change` (apply).

## 8. Frontend (T05)

- **Room weeks control.** A "Room weeks" stepper (0..length, plus "Full") sits next to the length,
  on lab steps only. It appears in the template editor, the Timeline previews and the Matrix, and
  saves through the one apply (Admin, Super Admin).
- **Help text** on a lab step with a value: "Room weeks set: length from the template, not the lab
  figure; not skipped when certification testing is off".
- **Bars.** Preview and Gantt bars draw the held weeks (`room_start_week` onwards) distinctly from
  the rest of the lab bar.
- **Matrix D/L.** The L total is the served `lab_weeks`.
- **Capacity and chamber views** use the served fields only.
- **Never served here:** financial fields. Engineer names follow the existing Gantt rule (P3-T09).
