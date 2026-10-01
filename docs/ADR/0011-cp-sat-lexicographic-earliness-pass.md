# ADR 0011: CP-SAT gets a second, lexicographic earliness pass after the ADR 0005 objective

## Status

Accepted (2026-09-27). Extends ADR 0005 (does not supersede it). Raised by `algorithm-engineer` in
P9-T02; see the `docs/MEMORY.md` entry "[2026-09-27] P9-T02 — algorithm-engineer".

## Context

ADR 0005's objective is `Σ band_weight × within_year`. It is indifferent to *when* a project finishes
as long as its within-year / left-out outcome is unchanged. Under the P9 lead-time table and DAG,
CP-SAT therefore returned needlessly late placements (a project finishing week 40 scored the same
as week 50), which failed two P2 CP-SAT tests and would put visibly odd bars on the Gantt and odd
"Will be completed" lines (DOMAIN_RULES "Expected vs projected completion").

## Decision

CP-SAT solves in two passes:

1. The ADR 0005 objective, unchanged.
2. With every project's `left_out` and `within_year` fixed to the pass-1 values, minimise
   `Σ project end_week` under a deterministic time limit (`earliness_deterministic_time`, default
   5.0) so the result is reproducible (I8).

Pass 2 can never lower the pass-1 objective, because the outcomes it scores are frozen.

## Consequences

- CP-SAT wall time on the 46-project seed rose from about 1 s (P2) to about 44 s, of which about 12 s
  is pass 2. That still fits the 60 s solver budget and runs only in Celery (never in FastAPI). At
  the full 236-project portfolio it may need a larger budget or accepting FEASIBLE. That is tracked
  for P9-T06 / P7 load testing, not decided here.
- OPEN_QUESTIONS #10 (CP-SAT may drop a P1 project for portfolio gain) is unaffected. Pass 2 cannot
  re-admit a project that pass 1 left out.
- Greedy is unaffected. It already places every step at its earliest feasible window.

## Amendment (2026-09-27, P9 gate)

The "about 44 s" figure was measured on the self-test seed with the prototype chambers. On the real
DB seed with the ten workbook chambers, workflow-auditor measured 74–103 s. In that run pass 1 hit
its 60 s wall-clock limit, returned FEASIBLE rather than OPTIMAL (objective 31, bound 34), and so
depended on machine speed. Ruling: both passes use **deterministic-time** limits (DOMAIN_RULES
"Gate remediation rulings" #6), and the solver status is stored on the run. Measuring at 236
projects stays a P7 load-test item.
