---
name: scheduling-algorithms
description: CP-SAT modelling patterns for this RCPSP-shaped scheduling problem, the greedy SGS reference implementation approach, determinism requirements, and the golden-file harness. Load before touching backend/scheduling/.
---

# Scheduling algorithms — greedy SGS and CP-SAT

This problem is a resource-constrained project scheduling problem (RCPSP) variant: 14 sequential
steps per project, engineers as unary resources (design steps), chambers as capacitated resources
(lab steps, 0.5 consumption per project-week), a 78-week horizon, with frozen-project date locking
and left-out handling. All rule detail lives in `docs/DOMAIN_RULES.md` — this skill covers *how* to
implement it, not *what* the rules are.

## Greedy SGS (serial schedule-generation scheme)

Implement the scheduling order from `docs/DOMAIN_RULES.md` exactly: sort by `frozen` descending,
then priority (P1→P2→P3→P4→Q), then status, then category. For each project in that order, walk its
14 steps in sequence, and for each step find the earliest feasible window per the booking rules
(engineer free for the full window on design steps; chamber with region + `allowed_stages` match and
capacity headroom on lab steps). This is a greedy construction heuristic, not an optimizer — it
produces *a* feasible schedule, fast, used as a baseline and as CP-SAT's warm start.

Structure as pure functions:

```python
@dataclass(frozen=True)
class ScheduleInput:
    projects: tuple[Project, ...]
    engineers: tuple[Engineer, ...]
    chambers: tuple[Chamber, ...]
    current_week: int = 31

@dataclass(frozen=True)
class ScheduleOutput:
    project_schedules: tuple[ProjectSchedule, ...]
    conflicts: tuple[Conflict, ...]  # ENG_CONFLICT, OVERLAP entries

def run_greedy_sgs(input: ScheduleInput) -> ScheduleOutput: ...
```

No DB session, no HTTP client, no filesystem access inside this function or anything it calls.

## Determinism — non-negotiable (Invariant I8)

- Fixed seeds wherever randomness appears (Monte Carlo forecaster only — the greedy scheduler itself
  should have *no* randomness).
- Sort before iterating over any collection whose input order isn't already the canonical scheduling
  order (e.g., don't iterate a `dict` or `set` of engineers when checking availability — sort by
  engineer ID first).
- Never rely on Python's dict insertion order as an implicit sort — make every ordering explicit
  and named, so a future reader doesn't need to trust incidental behavior.
- Test determinism directly: run the same input twice, assert byte-identical serialized output, as
  part of every golden-file test run, not as a separate occasional check.

## CP-SAT model (OR-Tools)

- **Interval variables**: `NewIntervalVar(start, duration, end, name)` per project-step. Use
  `NewOptionalIntervalVar` for steps that might not be scheduled at all (the left-out/deferred
  decision) — the presence literal becomes part of the objective.
- **Engineers (unary resources)**: `AddNoOverlap` over each engineer's design-step intervals.
- **Chambers (capacitated resources)**: `AddCumulative` per chamber, with demand `1` per
  project-week interval (or model the `0.5` consumption by doubling the chamber's effective capacity
  units — pick one convention and document it in an ADR since half-unit consumption isn't natively
  expressible in `AddCumulative`'s integer demand model).
- **Precedence**: `model.Add(start[i+1] >= end[i])` per project's step sequence (matches Invariant
  I3 — strictly sequential, non-overlapping).
- **Left-out/deferred decision**: model via the optional interval's presence literal; a step (and
  by extension its project, if any step is absent) not scheduled within the horizon is `LEFT_OUT`.
- **Objective**: maximise weighted value of projects completing within year
  (`WITHIN_YEAR_WEEK = 52`) — weight by the project's priority band or normalised score from
  `docs/DOMAIN_RULES.md`'s prioritization scoring, summed over presence literals gated by a
  within-year completion indicator.
- **Solution hinting**: feed the greedy SGS result in as a hint (`AddHint`) — CP-SAT converges
  faster from a known-feasible starting point on a problem this size (236 projects × 14 steps).
- **Tuning**: set `max_time_in_seconds` explicitly (bounded, since this must run in a Celery worker
  with a practical timeout) and `num_search_workers` to use available cores — but always inside
  `solver-worker`, never inside the FastAPI process (Standing Decision).
- **Infeasibility**: CP-SAT will not report infeasibility for this model in practice (optional
  intervals mean "don't schedule it" is always a valid fallback) — if you do hit `INFEASIBLE`, it
  means a hard constraint (like frozen-project overlap) was modelled as non-optional when it should
  allow a conflict flag instead. Treat `INFEASIBLE` as a modelling bug, not a valid domain outcome.

## Golden-file test harness

Each golden-file test case: a small, hand-constructed `ScheduleInput` (per P2-T05: single engineer
contention, chamber saturation, frozen conflict, left-out at horizon, category mismatch, spillover
boundary at week 52) plus the expected `ScheduleOutput`, stored as a fixture. The harness runs the
scheduler against the input and asserts structural equality against the expected output — not just
"no exception raised." When a fixture changes because a rule was intentionally corrected, the ADR
that authorized the correction is referenced in the fixture's accompanying comment or commit
message, and the change is itself a MEMORY.md entry.

Keep golden-file fixtures small and rule-focused (one rule exercised per fixture, not a monolithic
"realistic" 236-project fixture) — small fixtures make failures diagnosable at a glance; large
"realistic" fixtures are what the (now-deleted) oracle-derived tests in `tests/oracle/` were, and
they hide *which* rule broke.
