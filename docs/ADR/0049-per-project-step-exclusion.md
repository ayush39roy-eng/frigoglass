# ADR 0049: Per-project step exclusion

## Status

**Accepted with changes (2026-11-13, P35-T03).** The workflow-auditor's ruling R35-1..R35-12 and
invariants I33–I36 (MEMORY "[2026-11-13] P35-T03") override §1–§6 where they differ. In particular:
§4's "eff > 0" test is replaced by applicability from the template copy (R35-2), because the split
can revive a zeroed step; exclusion is refused when it would leave a kind with a figure no step
(`EFFORT_NEEDS_A_STEP`) or the project no step (`NO_STEPS_LEFT`) (R35-5); the builder maps an
excluded step to `lead_weeks = 0`, so there is no new scheduler field or snapshot key (R35-9). The
step payload field must not be named bare `excluded` (clashes with `ProjectScheduleOutcome.excluded`).
Originally: Proposed (2026-11-13), P35. Binding only after the workflow-auditor's ruling (P35-T03). Lands after
P33-T02 / P33-T08 (same skip predicate and effort split). Amends DOMAIN_RULES §B (`eff`, skip
predicate) and ADR 0041 R2/R3.

## Context

The client's old tool lets a user switch off steps per project from step chips on the registration
grid ("Steps (click to exclude)", `disabledStages`). Owner answers 2026-11-13: OQ #81 exclude only
(no including a 0-week step); OQ #82 Not Started **and In Progress** steps may be excluded, Done
steps may not ("the one completed has no significance"); OQ #83 a Save recalculates at once.
ADR 0048 retired per-project step *timing*; exclusion changes no length or gap, it switches a step
off, so it is a separate, narrower per-project input.

## Decision

1. **Storage.** `project_workflow_steps.excluded` (bool, not null, default false). Audit action
   `project.step_excluded` / `project.step_included` with the step id.
2. **Effective duration.** `eff(p,s) = 0 if p.step(s).excluded`, evaluated before every other branch.
   `skipped(p,s) ⟺ eff(p,s) = 0` is unchanged in form, so every reader (scheduler, validator I5,
   load, Gantt, cards, tracking) follows. The 14-row shape stays (I5).
3. **Effort split (R2).** `S` = the kind's steps with `lead > 0` **and not excluded**. A project with
   a design figure of 4 keeps 4 weeks of design when a step is excluded; the remaining steps
   stretch. With no figure the total shrinks by the excluded step's length.
4. **Which steps.** Only steps whose effective duration is > 0 can be excluded (exclude only, OQ
   #81). Not Started and In Progress: allowed. Excluding an In Progress step drops its remaining
   time and its load; the stage status is set to a terminal "Skipped"-equivalent per the auditor's
   ruling (Q2). Done: 409 `STEP_DONE`. Re-including restores the step (re-split, stale).
5. **Recalculation.** An exclude/include is saved through the register batch (P35-T01) and
   dispatches one greedy run per Save (OQ #83), like a priority move.
6. **Frozen projects (I10).** Exclusion is refused (409 `PROJECT_FROZEN`).

## Questions for the ruling (P35-T03)

- Q1: R3 (recorded work never erased) vs excluding an In Progress step: does R3's `max(1, share)`
  floor yield to the exclusion, and how is I26 restated?
- Q2: the stage status of an excluded In Progress step (keep In Progress but eff 0, or a new status);
  effect on "current step" and progress weights.
- Q3: excluding the step that is the only remaining non-zero step of a kind with a figure (R7:
  `T = 0` → not applied) — allowed, or 409?
- Q4: interaction with P33 gaps: a gap on an excluded step is ignored (as for a 0-week step, OQ #80)?
- Q5: canonical input form / snapshot key only when any step is excluded, so golden files and stored
  hashes stay byte-identical.
