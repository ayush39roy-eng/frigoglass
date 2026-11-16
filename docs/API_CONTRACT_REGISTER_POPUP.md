# API contract — Projects register Edit popup (P35-T05 + owner request 2026-11-17)

Binding for the backend and the frontend. Sources: owner request 2026-11-17 (row "Edit" opens a
popup; one Save, one recalculation; End wk read-only; Current step marks earlier steps Done),
ADR 0049 as ruled at P35-T03 (R35-1..R35-12, I33–I36, DOMAIN_RULES "Per-project step exclusion"),
P35-T01 (`POST /projects/register-edits`). Backend: `api/routers/projects.py`,
`services/register_steps.py`, `schemas/project.py`. Migration `p35b_step_excluded` (revises
`p33c_clear_step_timing`).

## 1. Vocabulary

- **`step_code`** is the workflow step id, e.g. `"PDD-E"`, `"OEM-B"` — the same value the register
  list already serves as `current_step_code` (`GET /dashboard/projects`). Not the client short code
  (`MKTG_BRF`).
- **`kind`**: `"design" | "lab" | "elapsed"` (`WorkflowStepKind`). *Deviation:* the request listed
  design/lab only; both workflows have elapsed steps (PDD-C/G/L/N), so `elapsed` is served too.
- **Stage `status`** on the read: `"Not Started" | "In Progress" | "Blocked" | "Done" | "Skipped"`.
  The first four are the stored `WorkflowStepStatus` wire values (`"Blocked"` is shown to users as
  "On Hold", ADR 0017 — the wire value stays `Blocked`). `"Skipped"` means the step's effective
  duration is 0 by the one service predicate (R35-1): excluded, a 0-week template copy, a lab step
  with certification testing off, or an own-effort step the split gave 0 weeks. A skipped step
  counts as complete for the scheduler and **cannot be the current step**. *Deviation:* `Blocked`
  added to the requested list.
- The DB column is `project_workflow_steps.excluded`; every wire field is `step_excluded`.

## 2. `POST /projects/register-edits` — new optional patch fields

`RegisterEditsRequest { edits: RegisterEditPatch[1..100] }`, unchanged envelope, `extra="forbid"`.
`RegisterEditPatch` gains (all optional, PATCH semantics — only keys sent are applied):

| Field | Type | Rules |
|---|---|---|
| `hub_id` | uuid | As `PATCH /projects/{id}`: `null` → per-row 422 `NULL_NOT_ALLOWED`; a change needs the caller's hub scope on **both** the old and the new hub, else the whole batch is **403 `REGISTER_EDITS_FORBIDDEN`** with that row as `FORBIDDEN_PROJECT` (an unknown or foreign hub is never revealed to a hub-scoped caller). A global-scope caller naming an unknown hub gets per-row 422 `UNKNOWN_HUB`. A project-level Admin grant alone does not move a project between hubs (stricter than the single PATCH). PDD↔OEM moves re-point the 14 steps (refused once any stage has progress: `WORKFLOW_CHANGE_WITH_PROGRESS`) and clear their exclusions (R35-11). Audited in `project.update`. |
| `certification_testing_required` | bool (strict) | As the PATCH: `false` skips every lab step (ADR 0007); re-derives the effort (R6). `null` → `NULL_NOT_ALLOWED`. |
| `step_exclusions` | `StepExclusionEdit[]`, max 14, unique `step_code` | `StepExclusionEdit { step_code: string(1..10), step_excluded: bool (strict) }`. Sending a step's current value is a no-op. `null` = no change. |
| `current_step_code` | string(1..10) | See §2.2. `null` = no change (there is no "clear"). |

Order inside one patch: project fields → `step_exclusions` → `current_step_code` → R35-5 guards on
the final state. Everything in one transaction with the rest of the batch; any row error rolls the
whole batch back (422 `REGISTER_EDITS_INVALID`, `detail.errors = [{project_id, code, message}]`).
The per-row `code` carries the refusal below; the HTTP status of the batch is 422 (or 403 for the
authorisation failures) — the 409s named by R35-2/R35-5 are the codes' status on their own, not
the batch's status.

### 2.1 `step_exclusions` (R35-2, R35-4, R35-6, R35-10)

A change is refused, per row:

| Code | When |
|---|---|
| `UNKNOWN_STEP` (422) | the code is not a step of the project's workflow **after** this patch's hub move |
| `PROJECT_FROZEN` (409) | the project is frozen (I10 / I36: no flag changes while frozen) |
| `PROJECT_CLOSED` (409) | the project's status (after this patch) is Cancelled or Commercialized |
| `STEP_NOT_APPLICABLE` (409) | excluding a step that is not `applicable` (R35-2, the "N/A" chip) |
| `STEP_DONE` (409) | excluding a stored Done step |
| `EFFORT_SPLIT_REJECTED` (422) | the re-split over the remaining steps puts a step above 104 weeks (R7) |

Re-including (`step_excluded: false` on an excluded step) is always allowed under the frozen /
closed rule. A write sets only `excluded` (R35-4: no status, percent, actual week, remaining
override or hold reason), `schedule_stale`, and re-derives the effort over S′ (R35-3,
`project.effort_rederived` when a share changes). Audit: one `project.step_excluded` /
`project.step_included` row per changed step: `{project_id, step_id, step_row_id, step_excluded,
stage_status, eff: {step_id: weeks}}` before/after (the `eff` of every step of that kind whose `eff`
changed; revived steps are visible), plus `kind` and `reason: "register_edit"` after. No financial
field.

### 2.2 `current_step_code` (owner decision 2026-11-17 — new domain behaviour, see §6)

Let C be the requested step and "skipped" the R35-1 predicate evaluated **after** this patch's
exclusions and **before** the progress write. Walking the project's steps in workflow order
(`sequence_order`):

- every not-skipped step **before** C → **Done**: `percent_complete = 100`, `actual_end_week =
  CURRENT_WEEK`, `actual_start_week` kept or `CURRENT_WEEK` when empty, hold reason cleared. An
  already Done step is untouched.
- **C** → **In Progress** with `actual_start_week = CURRENT_WEEK` when it was Not Started. An In
  Progress or on-hold (`Blocked`) C is kept as it is. A Done C is reopened: In Progress, start kept,
  end cleared, `percent_complete = 0`, remaining override cleared.
- every not-skipped step **after** C → **Not Started** (percent 0, both actual weeks, remaining
  override and hold reason cleared). An already Not Started step is untouched.
- skipped steps are never written (R35-4 / I34).

Weeks are recorded as a weekly check-in at the current plan week would (`CURRENT_WEEK`, read at
call time), validated by the check-in's own consistency check (`merge_stage_update`). No
`stage_checkins` row is written (it is not a check-in; see §6).

Refusals, per row: `UNKNOWN_STEP` (422); `STEP_NOT_APPLICABLE` (422) when C is skipped/excluded;
`PROJECT_FROZEN` (409) when it would change anything on a frozen project; `INCONSISTENT_PROGRESS`
(422) if a stored week makes the result inconsistent (e.g. a start after `CURRENT_WEEK`). Picking
the step that is already current with nothing to change is a no-op (no audit, no stale).

Audit: one `project.current_step_set` row: before `{project_id, current_step_code, stages[]}`,
after `{project_id, current_step_code, requested_step_code, week, stages[]}`, where `stages` holds
the changed stages' `{step_id, status, percent_complete, actual_start_week, actual_end_week,
remaining_weeks_override, blocked_reason_length}` (the hold reason by length only). A stage that
crosses Not Started re-derives the effort (R3).

### 2.3 Guards on the final state (R35-5)

| Code | When |
|---|---|
| `EFFORT_NEEDS_A_STEP` (409) | a design/lab figure in force whose every weighted step is excluded (S′ empty). The message names the kind and says to clear the figure or keep one step. |
| `NO_STEPS_LEFT` (409) | no step of the project keeps `eff > 0` |

Also enforced on the other writers: `PATCH /projects/{id}` (figure entry, category change,
certification toggle, hub move) answers **409 `EFFORT_NEEDS_A_STEP`** / `NO_STEPS_LEFT` itself.

### 2.4 Recalculation (R35-7)

Hub, certification, exclusion and current-step changes are scheduler inputs: the batch's one greedy
run (`trigger_reason="register_edit"`) follows the existing rule (`not_needed` unless a scheduler
input changed on a project schedulable before or after its edit; `deferred` / `queued` /
`dispatch_failed`). Never solved in-process.

### 2.5 Response: `RegisterEditsResponse` gains `eff_changes` (R35-7) — *addition*

```
eff_changes: RegisterEditEffChange[]   // default []
RegisterEditEffChange {
  project_id: uuid
  step_code: string
  eff_before: int
  eff_after: int
  revived: bool        // eff_before == 0 && eff_after > 0
  skipped_now: bool    // eff_before > 0 && eff_after == 0
}
```

Every step whose effective duration changed with this Save (figures, certification, exclusions,
current step), ordered by project id then workflow order. A PDD↔OEM move lists nothing for the
re-pointed steps (different step ids). The popup renders these served values ("D now runs 1 wk")
and never re-splits in the browser.

## 3. `GET /projects/{id}/register-steps`

Permission and scope exactly as `GET /projects/{id}` (Project Registration READ, hub scope with
the project-grant fallback; 404 when out of scope or unknown). Read-only. A constant number of
statements (no N+1).

```
RegisterStepsRead {
  project_id: uuid
  current_step_code: string | null   // = the register list's current_step_code; null when every step is Done or skipped
  end_week: int | null               // = the register list's end_week (active run's projected end); read-only
  design_weeks_calculated: int       // = the register list row's value (D35-1, R35-12: excluded steps add 0)
  lab_weeks_calculated: int          // idem, lab; the green "calculated" figure beside the effort figures
  steps: RegisterStepRead[14]        // workflow order
}
RegisterStepRead {
  step_code: string                  // "PDD-A"
  step_name: string
  kind: "design" | "lab" | "elapsed"
  status: "Not Started" | "In Progress" | "Blocked" | "Done" | "Skipped"
  step_excluded: bool
  applicable: bool                   // R35-2, from the template copy, ignoring the step's own exclusion
  excludable: bool                   // applicable && status-stored != Done && project not frozen / Cancelled / Commercialized
  is_current: bool                   // step_code == current_step_code
}
```

- `applicable` (R35-2): not (lab with certification testing off), and the step's R2 weight > 0
  when its kind's figure is in force, else its template copy (`plan_weeks`) > 0. A step the split
  gave 0 weeks is applicable (`status: "Skipped"`, chip "0 wk (split)"); a 0-week copy is not (N/A).
- `excludable`: *deviation* — the request said "applicable and not Done"; it also requires the
  project to be editable (not frozen, not Cancelled/Commercialized), so a chip is never offered
  that the Save would refuse. Re-including an excluded step needs only the project condition (the
  chip is excluded, so `step_excluded: true` tells the UI the click means "include").
- Current-step choices: the steps whose `status` is not `"Skipped"` (§2.2).
- `design_weeks_calculated` / `lab_weeks_calculated` *(added 2026-11-17 at the frontend's request)*:
  Σ over the kind's steps of `eff` with the project's own figure ignored (excluded steps and lab
  steps without certification testing add 0); the same values and the same predicate
  (`row_calculated_weeks`, via `build_project_cards`) as `GET /dashboard/projects` rows.

## 4. Other surfaces (no wire change)

- Every reader takes `excluded` through the one predicate (R35-1): Workspace stages (`skipped`,
  `duration_weeks` 0), stage PATCH (`STAGE_SKIPPED`), check-in (an excluded stage is never due),
  tracking, cards, Gantt, ask-agent context, demand load (I25), register `design_weeks_calculated`
  / `lab_weeks_calculated` (R35-12: excluded steps add 0).
- The live builder maps an excluded step to `lead_weeks = 0` (None when the table value is 0) and
  no override (R35-9); no new scheduler field or snapshot key. With nothing excluded every input
  hash / golden / stored run is byte-identical (I36).
- Template apply preview/apply (P33 E2/E3): a new step flag **`excluded_no_effect`** (R35-8) on a
  written pair whose step is excluded; the copy is still written. Frontend
  `surfaces/workflow-settings` needs the label (its `StepFlag` union).

## 5. Frontend mirror (contract test rows)

`backend/tests/test_openapi_frontend_contract.py` pins, in
`frontend/src/surfaces/projects/api/register-edits.ts`, exact field sets for `RegisterEditPatch`
(+ `hub_id`, `certification_testing_required`, `step_exclusions`, `current_step_code`),
`RegisterEditsResponse` (+ `eff_changes`), and the new `StepExclusionEdit`,
`RegisterEditEffChange`, `RegisterStepsResponse` (backend `RegisterStepsRead`) and `RegisterStep`
(backend `RegisterStepRead`). Those rows stay red until the TS types match. As of this writing the
TS mirror still needs: `RegisterStep.kind` to admit `'elapsed'`, `RegisterStep.status` to be the
§1 union including `'Skipped'` (not `WorkflowStepStatus`), and `RegisterEditsResponse.eff_changes`
+ an exported `RegisterEditEffChange`.

## 6. Assumptions needing a workflow-auditor ruling

1. "Before / after C" is `sequence_order`, not the precedence DAG (ADR 0009). With parallel
   steps the DAG may differ.
2. A Blocked (on hold) C is kept Blocked, not forced to In Progress (DOMAIN_RULES: Blocked is "as
   In Progress, but held"); a Done step before C stays Done with its recorded weeks.
3. Steps after C are reset to Not Started even when they hold recorded progress (Done weeks are
   erased; the audit row keeps them). This follows the owner's wording; it is destructive.
4. A reopened Done C restarts at 0 % (100 % In Progress would finish at once).
5. "Skipped" for the choice of C is evaluated before the progress write: a step the split gave 0
   cannot be picked, although marking it In Progress would raise it to 1 week under R3.
6. No `stage_checkins` row is written, so the check-in page's "checked in this week" and tracking
   status are not changed by a register Save.
7. A current-step change on a Cancelled / Commercialized (non-frozen) project is allowed.
8. `excludable` also requires an editable project (§3).
