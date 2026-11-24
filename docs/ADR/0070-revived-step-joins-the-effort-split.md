# ADR 0070 — A step revived from 0 weeks joins the project's own-effort split

- **Status:** Accepted (2026-11-24). The owner decided it ("Split the figure"). The backend-builder implemented it.
- **Amends:** ADR 0046 — R33-2 (weights are immutable), OR-4 (an apply writes no effort), I26 and I31(iii).
  Also ADR 0041 R6 (the re-derivation triggers).
- **Migration:** `p70a_effort_weight_revive` replaces the body of the trigger function only. It writes no data.

## Context

On 2026-11-24 the client changed category B (workflow PDD) in Workflow settings and applied it:

- PDD-B lead weeks 0 → 1;
- PDD-F lead weeks 0 → 3;
- PDD-H lead weeks 6 → 4.

Projects with their own effort figure for a kind did not get the change. 101 of the 158 active B
projects have a lab figure. Why:

- OR-4 flagged them `own_effort_length_not_applied`.
- The step's `effort_weight_weeks` stayed 0, because R33-2 makes weights immutable (a DB trigger
  enforces this).
- So the R2 split gave F nothing. F stayed skipped ("n/a", greyed in the register and the project
  folder).

## Decision

1. **Weight revive.** A template apply may set a step's `weeks` from 0 to N > 0. When it does and the
   stored `effort_weight_weeks` is 0, the apply also sets `effort_weight_weeks = N`. All other weights
   are left alone. Examples:
   - H 6 → 4 keeps weight 6;
   - a step whose weight is already > 0 keeps it.

   The DB trigger now allows exactly one change: `OLD.weight = 0 ∧ NEW.weeks > 0 ∧ NEW.weight = NEW.weeks`.
   Anything else is still SQLSTATE 23514 `ck_workflow_lead_times_effort_weight_immutable`.
2. **Apply (OR-4 amended).** Take a pair `(p, S)` where `S` was revived and `ownEffort(p, kind(S))` holds.
   - **When the pair is received** (`¬never(p,S)` under R33-10, automatic or selected):
     - it gets the copy `plan_weeks = N`, as a non-own-effort pair does;
     - the project's effort is re-derived in the same transaction. This uses the R6 code path the
       project PATCH uses, with audit `project.effort_rederived` and trigger `template_revive`. It
       sets `schedule_stale`.
     - The figure's total is unchanged (Σ = E + raised). It is split over the new weights. Example:
       B lab 6 with weights F 3 : H 6 gives F 2, H 4.
   - **The preview** lists S with the flag `revived` when its share is > 0. It also lists every other
     step whose `eff` the re-split changes, with no flag (R33-11 honesty).
   - **Refused (fallback to `own_effort_length_not_applied`, nothing written)** in two cases:
     - the re-split would change the `effort_weeks` of a reached step (started, or before a started
       step). The owner rule is "never touch Done / In Progress / reached steps";
     - R7 rejects the split.
   - **Never pairs** (frozen, Cancelled, Commercialized, reached) are untouched, as before.
3. **Held back (I26 amended).** A step is held out of the split when all of these hold:
   - it is Not Started;
   - it carries no share (`effort_weeks` null);
   - its kind already has own effort;
   - it has a weight > 0;
   - it is not excluded;
   - its copy `plan_weeks` is 0.

   A held-out step is outside S′, exactly like an excluded step (R35-3). The copy is the per-project
   record of "this project received the revived length". So these projects never pick up the revived
   weight in a later R6 re-derivation (stage crossing, check-in, figure edit, unfreeze):
   - a project that had reached the step;
   - a project that was not selected;
   - a frozen or closed project.

   Exceptions:
   - A kind whose S′ would become empty holds nothing back.
   - A category change or a workflow change re-derives without this rule (`hold_back=False`), as
     ADR 0041 R6 did before.

   On data that predates a revive, no step meets these conditions (I26), so nothing changes.
4. **Run input (OR-3 amended).** If an own-effort step has no share (`effort_weeks` null), the live
   builder maps it to `lead_weeks = 0`, never to its weight. So the scheduler's
   `eff = override ?? lead` is 0, which equals OR-2's `effort_weeks ?? 0`. Before this ADR, such a step
   always had weight 0, so every earlier input is byte-identical.
5. **One-time catch-up.** `POST /workflow-templates/sync-effort-weights` with `{"dry_run": bool}`.
   - Super Admin only (ADR 0058).
   - Every template row with `weeks > 0` and `effort_weight_weeks = 0` gets weight = weeks.
   - Then rule 2 runs for every own-effort pair of those rows: copy and re-derivation (trigger
     `effort_weight_sync`), with the same refusals.
   - The changed projects are marked `schedule_stale`. No run is dispatched (ADR 0069).
   - A dry run reads only.
   - It is idempotent.
   - It is not an Alembic data migration: the owner triggers it on the hosted data.
6. **Lock order (run 307 "deadlock detected").** The apply and the sync take the band-rank advisory lock
   first, before any category or project row lock (`lock_band_ranks`: 5 s, then 503 `BAND_RANK_BUSY`).
   This is the same first lock a schedule run's persistence takes (`wait_for_band_ranks`), so the two
   now serialise.

## Consequences

- **I26 (rev. 3).** S′ excludes the held-back steps. The live checker
  `scheduling.demand.check_i26_effort_split` (algorithm-engineer) does not know the rule. Code that
  builds `LiveProjectRow`s for a project with a held-back step must pass `excluded=True` for it.
- **I31(iii) (rev.).** An apply writes `effort_weeks` only through the revive re-derivation of a
  received own-effort pair, and never on a reached step.
- **Weights are no longer strictly immutable.** They still never change except 0 → N on a revive.
  "+ Add category" still copies them.
- **Coordinator's example vs this ADR.** The coordinator's example said "weights 3:4". H's weight stays 6
  (rule 1: "leave weights alone otherwise"), so the B lab-6 split is F 2, H 4, not F 3, H 3. Making
  H's weight follow its new length would be a different decision. That would be a change to R33-2
  for every step, not this revive case.
