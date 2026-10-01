# ADR 0009: Workflow precedence is a configurable DAG; strict sequence is only the default

## Status

Accepted (2026-09-27). Supersedes Invariant I3's "strictly sequential" wording in
`docs/DOMAIN_RULES.md`; answers `docs/OPEN_QUESTIONS.md` #1 in part (the client says *some* steps
can run in parallel and wants to choose which).

## Context

I3 forced `step[n].start ≥ step[n−1].end + 1` for all fourteen steps. The client has now said that
some steps may overlap — for example certification testing (a chamber) can run while TF-1 tooling
work (an engineer) proceeds — and asked for an option to set that, rather than a fixed answer.

## Decision

1. Each `WorkflowStepTemplate` carries `predecessor_ids` (a list of step IDs in the same workflow).
   The seeded default for both workflows is the strict chain (`PDD-B` ← `PDD-A`, …), so behaviour is
   unchanged until someone edits it.
2. **Workflow Settings** (new surface; Super Admin write, Admin read) edits predecessors per step.
   The server rejects a cycle, a self-reference, a cross-workflow reference and an empty
   predecessor set on any step but the first. A change is audit-logged and marks every schedulable
   project `schedule_stale`; it never auto-solves.
3. Scheduler rule (greedy and CP-SAT alike): `step.start ≥ max(pred.end for pred in
   predecessors) + 1`; a `skipped` step's `end` is `max(pred.end)` so it is transparent to its
   successors. Project `end_week` = max over non-skipped steps. The project's earliest feasible
   frontier for a `Blocked` stage (ADR 0006) holds every *successor* of that stage, not "every
   downstream step in sequence order".
4. **Two design steps of the same project never overlap in practice** even when the DAG allows it:
   both book the project leader, and I1 (one design step per engineer-week) still holds, so the
   greedy scheduler simply places the second one after the first. Parallelism therefore buys
   lab ∥ design and elapsed ∥ anything, which is what the client described. A per-project override
   of the template DAG is deliberately not offered (OPEN_QUESTIONS #17).
5. Precedence is part of the hashed solver input (I8) and is snapshotted onto the `ScheduleRun`
   (`workflow_snapshot` JSON: steps, kinds, predecessors, lead times) so historical runs remain
   explainable after a settings change (I14).

## Consequences

- I3 becomes "every step starts after all its predecessors end"; new I15 asserts the stored DAG is
  acyclic and every run respects it.
- `sequence_order` is retained as the display order and as the deterministic tie-break when the
  scheduler walks steps; it is no longer a dependency statement.
- The Gantt gains nothing new visually from this ADR — bars already come from the run — but the
  step rows of an expanded project may now overlap horizontally.
