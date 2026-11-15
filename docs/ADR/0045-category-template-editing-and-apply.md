# ADR 0045: Category template editing with buttons, and the rules for applying it to projects

## Status

Accepted (2026-11-13), in full since P33-T01. The workflow-auditor's ruling (ADR 0046 "Ruling
(P33-T00)", R33-10 stage rule) and the owner's answer to OQ #76/#77 (ADR 0046 "Owner ruling") amend
§2–§4. See "Amendment (P33-T01)" at the end, which wins over the text above it. Part of P33.
Amends ADR 0007 (lead times), ADR 0010 (permission table, §7 below) and ADR 0013/P13-T16
(category timeline previews become editable). Contract: `docs/API_CONTRACT_P33.md`.

## Context

Owner change request 2026-11-13, with answers to our clarifying questions. Workflow Settings →
Workflow templates → "Timeline previews" shows one read-only timeline per category (rows PDD-A …
PDD-N). The bars come from the lead-time table and the precedence DAG, with no capacity. Only Super
Admin can edit the lead-time table, and only as numbers on the Lead times tab.

The client's older tool shows a GAP badge before each step's bar:
- "0w": the step starts right after its predecessor;
- "−3w": it overlaps its predecessor by 3 weeks (runs in parallel), flagged "Overlap";
- "3w": it waits 3 weeks after its predecessor (a hatched gap).

The owner wants this on our category timelines, edited with buttons, applied to projects by a clear
stage rule. Per-project timing editing (Gantt drag) is retired (ADR 0048), so the category template
becomes the only way timing is shaped.

## Decision

1. **Editing with buttons, not drag.** Each step row of a category timeline gets two pairs of
   buttons:
   - **Move** `−` / `+`: changes the step's signed gap `g` by −1 / +1 week. Negative means overlap
     (parallel), 0 means right after, positive means wait.
   - **Length** `−` / `+`: changes the step's length by −1 / +1 week. This is the same value as the
     Lead times tab cell for that (workflow, category, step).
   - Ranges: length 0..104, gap −104..104. The first step of a workflow has no gap: it shows "—"
     and has no Move buttons.
   - The preview redraws after every click from a stateless server preview (the browser never
     computes a week; I9/I16 spirit). Edits stay local until **Save**. **Discard** drops them, and
     each row has a reset to the saved value.
   - The badge shows `0w`, `−Nw Overlap` or `Nw` (hatched). An overlap between two design steps
     shows "Overlap — same leader, runs back-to-back", because the preview applies the one-leader
     rule (ADR 0046 §5) instead of pretending they run in parallel.
   - A permanent note says: "Template view: lead times and gaps only. Real projects also wait for
     their engineer and a test chamber."

2. **What Save does: one apply, with a stage rule per changed step.** A save is a set of changed
   steps `S`, each with a new length and/or gap, for one or more (workflow, category) pairs. The
   Lead times tab saves through the same flow (decision 5). For each project `p` of that workflow
   and category, and each changed step `S`:

   | Project / stage state | Rule for `S` |
   |---|---|
   | `p.frozen` | **never** (I10) |
   | status `Cancelled` or `Commercialized` | **never** |
   | stage `S` is `Done`, `In Progress` or `Blocked` (shown "On Hold") | **never**: the project has reached or passed `S` |
   | every stage of `p` is `Not Started` (not progress-tracked), any other status incl. `On Hold`, `In Queue`, `Draft` | **automatic** |
   | `p` is progress-tracked and stage `S` is `Not Started` | **choosable** |

   - Choosable projects are listed in a dialog: name, hub, status, current stage, and which of the
     changed steps each would receive. The user either picks **"Apply to all N projects that have
     not reached these stages"** or ticks projects one by one. Ticking none is allowed; then only
     the automatic projects change.
   - A ticked project receives every changed step that is choosable for it. It never receives a
     step it has reached.
   - The rule is evaluated again on the server at apply time. A ticked project that has since
     reached `S` is not changed, and the response reports it with its reason. Automatic projects
     are always taken from the server's evaluation, never from the client's list.

3. **What "apply" writes.** Applying copies the template's new values onto the project's own step
   row (ADR 0046 §1): `plan_weeks` when the length changed, `plan_gap_weeks` when the gap changed.
   When the length changed, the copy is marked `length_pinned` (ADR 0046 §3).
   - Projects not changed keep their copies. A later template edit never reaches them unless it is
     applied to them.
   - The template itself (`workflow_lead_times`, ADR 0046 §1) is always updated. It is what new
     projects and category changes copy from (decision 4).

4. **Later projects and category changes.**
   - A project **registered** after the edit copies its category's template at registration, so
     it starts from the edited template.
   - A project whose **category changes** copies the new category's template onto every step whose
     stage is `Not Started`. Steps it has reached keep their copies, by the same stage rule. A
     frozen project's category cannot change (unchanged rule).
   - A project whose **hub moves PDD ↔ OEM** changes workflow and category together, and is
     treated as a category change.

5. **The Lead times tab uses the same apply flow.** `PUT /workflow-settings/lead-times` is retired
   (410 `USE_TEMPLATE_APPLY`). Cell edits are collected and saved through the same apply preview,
   dialog and apply as the timeline editor. The table can no longer change a project without the
   stage rule.

6. **After applying: one recalculation, audit-logged.**
   - In one transaction: write the template, write the per-project copies, re-derive effort for the
     changed projects (ADR 0046 §3, R6), set `schedule_stale` on them, and write the audit rows.
   - The audit rows are one summary row (`workflow_template.applied`: the changes before and after,
     the selection mode, and the lists of automatic, selected, never and not-applied project ids
     with reasons) plus one `project.template_applied` row per changed project.
   - Then exactly one greedy run is dispatched with the priority-move lifecycle (ADR 0015/0023):
     `queued`, `deferred` (a coalesced follow-up) or `not_needed` (no schedulable project changed),
     with `trigger_reason="template_apply"`.
   - A template edit that changes no project (for example only cancelled projects in the category)
     writes the template and the summary row and dispatches nothing.
   - Saves are guarded by a per-category `template_version`: a save based on an old version is
     rejected with 409 `TEMPLATE_CHANGED`. The apply endpoint is rate-limited (lesson of S32-M2).

7. **Permissions (amends ADR 0010).** Owner decision: Admin and Super Admin may edit category
   timelines (moves and lengths), edit the Lead times tab and add categories (ADR 0047). Steps &
   precedence, Hub calendars and Chambers stay Super Admin only. Implementation: a new RBAC surface
   `workflow_templates`, Admin RW and Super Admin RW. Every other role gets the read access it has
   on `workflow_settings` today, which is none. `workflow_settings` keeps Admin R and Super Admin RW
   for the remaining tabs. `GET /me` publishes both surfaces. The frontend gates the buttons on
   `workflow_templates.write`, and the server enforces it on every P33 write endpoint.

## Consequences

- Timing is now shaped per category, and reaches projects only through a stated rule. Everything
  that happens is audit-logged with the affected project list.
- For effort-carrying projects (275 of 330), an applied length replaces that step's effort share
  (ADR 0046 §3). One `+` can therefore move a project by more than one week. The apply preview shows
  the per-project before/after length of each changed step.
- Admin gains a write that changes the plan. It is the same scale of write as a priority move, and
  is audited and recalculated the same way.

## Alternatives rejected

- *Drag on the category timeline.* The owner asked for buttons. Buttons are also exact and
  keyboard-accessible.
- *Apply every template edit to every project (today's behaviour).* This would silently re-time
  started projects, which is what the owner ruled out.
- *Ask per changed step in separate dialogs.* One list with per-row "receives E, H" is simpler and
  carries the same information.

## Amendment (P33-T01, 2026-11-13) — ruling R33-10 and the owner's answer to OQ #76/#77

- **Stage rule (R33-10).** It is evaluated on stored stage statuses, and "reached" includes
  successors:
  - `reached(p,S)` ⟺ `stage(S) ∈ {In Progress, Blocked, Done}`, or any transitive successor of `S`
    in the DAG in force is not Not Started.
  - `never` = frozen, Cancelled, Commercialized, or reached.
  - `automatic` = not never, and every stored stage is Not Started.
  - `choosable` = otherwise.
  - The project rows are locked `FOR UPDATE` in `project_id` order before the rule is evaluated.
    The stage PATCH and the check-in paths take the same lock.
- **Lengths vs a project's own effort figure (owner).** A length change (Length ±, Lead times tab)
  is **not applied** to a project's steps of a kind (design / lab) for which the project has its own
  effort figure. Its weeks for that kind stay its own. The dialog lists it as "uses its own effort
  figure — length not applied". **Gap changes (Move ±) apply to every project** under the stage
  rule. Elapsed steps take length changes on every project.
- **§3 "what apply writes".** `plan_gap_weeks` on every receiving pair; `plan_weeks` only where the
  project has no own effort for the step's kind. There is no `length_pinned` and no `length_set`. No
  `effort_weeks` is written and nothing is re-derived (R33-2).
- **§4.** Registration and category change copy the template's weeks and gaps (category change: the
  not-reached steps only). An own effort figure, if entered, governs its kind. Clearing a project's
  figure makes that kind follow the template: the current weeks are re-copied onto the not-reached
  steps. That answers OQ #77; there is no unpin control.
- **§6.** "Exactly one greedy run" applies when a copy was written on a schedulable project.
  Copies only on non-schedulable projects give `not_needed`; demand still moves at commit.
- **Consequences.** "One `+` can move a project by more than one week" no longer applies: a
  template length now changes only projects without a figure for that kind, by exactly the template
  difference.
