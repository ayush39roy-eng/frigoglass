# ADR 0006: Per-stage progress capture is the primary schedule-anchoring mechanism; `frozen` is retained but deprecated

## Status

Accepted (2026-09-08). Scopes the Project Workspace surface (`docs/PROJECT_AND_STACK.md` §2,
Surface #7) and the new "Per-stage progress capture" section of `docs/DOMAIN_RULES.md`.

Supersedes nothing outright. Interacts with ADR 0004 (delay is terminal — unchanged here).

## Context

The tool goes live at `CURRENT_WEEK = 31`. Most real projects will be part-way through a PDD stage
on the first data load. Before this ADR the scheduler had exactly two anchoring modes for a project:

1. schedule all 14 steps from scratch, or
2. `project.frozen == true` — lock all 14 steps from `actual_start`, consume capacity regardless of
   conflict, raise `ENG_CONFLICT` / `OVERLAP` (`docs/DOMAIN_RULES.md` Booking rules, Invariant I10).

`frozen` is all-or-nothing and carries no notion of *how far* a project has progressed. Freezing a
project that is 60% through Design Detailing tells the scheduler the whole project is immovable,
which is wrong; not freezing it tells the scheduler to re-plan work that is already done, which is
also wrong. The first real data load under either choice produces a visibly incorrect schedule, and
the documented product risk is that planners stop trusting the tool immediately.

The Project Workspace surface introduces per-stage progress fields (`status`, `percent_complete`,
`actual_start_week`, `actual_end_week`, `remaining_weeks_override`, `blocked_reason`) that let a
planner record reality at stage granularity.

## Decision

**Per-stage progress capture becomes the primary way a partially-executed project is anchored in the
schedule.** The scheduler resolves anchoring in this precedence order (also in `docs/DOMAIN_RULES.md`):

1. `project.frozen == true` → existing frozen rules apply unchanged. `frozen` still wins.
2. else project is *progress-tracked* (any stage `status != Not Started`) → the per-stage rules in
   `docs/DOMAIN_RULES.md` apply: `Done` stages are fixed history and are never re-placed (I11);
   `In Progress` / `Blocked` stages schedule only their derived `remaining` weeks forward from
   `CURRENT_WEEK`; `Not Started` stages schedule normally.
3. else → schedule from scratch, unchanged.

**`frozen` is retained but deprecated.** It is not removed in v1 (existing seed data and the Gantt
freeze toggle continue to work), but:

- the Project Workspace UI does not offer `frozen` alongside stage-level progress;
- guidance and docs steer planners to progress capture;
- `frozen` is expected to fall to near-zero use once real progress data is loaded, and is a
  candidate for removal in a later version.

**Rescheduling stays explicit.** A progress edit never triggers a solve — it sets `schedule_stale`
and the planner runs "Recalculate schedule", which writes a new immutable `ScheduleRun` version
(I14). Progress edits are cheap and frequent; solves are expensive and rare; they are not coupled.

**The prototype is not an oracle for any of this.** It has no progress-capture behaviour. The P2
differential-oracle process is closed and does not apply.

## Consequences

- `ProjectWorkflowStep` gains `status`, `percent_complete`, `remaining_weeks_override`,
  `blocked_reason` (a new `WorkflowStepStatus` enum). `actual_start_week` / `actual_end_week` already
  exist. A migration is required (P8-T01).
- Both solvers (greedy SGS and CP-SAT) gain the four-way per-stage handling (P8-T02). The greedy
  scheduler's "earliest-start floor" decision (P2-T01) already starts non-frozen search at
  `CURRENT_WEEK`, which is consistent with "schedule remaining weeks forward from the current week".
- Four new invariants — I11 (Done stages immutable), I12 (duration-weighted roll-up), I13 (health
  badge derived from the active run only), I14 (recalculate creates, never mutates, a run) — join
  the permanent correctness contract. The workflow-auditor asserts them on every progress-aware run.
- Capacity is tracked only for weeks `>= CURRENT_WEEK`; already-executed work is displayed but does
  not consume schedulable capacity. This is a deliberate simplification — historical capacity
  contention is not re-litigated.
- `@mention` notifications, comment authorship, and the (display-only) named engineer on the
  Progress panel add personal data to project records — folded into `docs/OPEN_QUESTIONS.md` #8
  (GDPR), which remains hard-blocking for the personal-data-exposing parts of the surface.
- If a future client answer requires progress edits to auto-reschedule, or requires `frozen` removed
  in v1, or requires historical-week capacity contention, this ADR is revisited.
