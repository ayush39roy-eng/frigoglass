"""Pure, deterministic scheduling engine for the RPD Web Application.

Owned exclusively by `algorithm-engineer` (P2). Rules enforced here are exactly
`docs/DOMAIN_RULES.md`'s "Scheduling order", "Booking rules", and Invariants
I1-I10 — implemented from that document directly, not by transliterating
`reference/rpd-platform-prototype.html` (that file was read only to resolve
genuine ambiguities DOMAIN_RULES.md leaves open; each such resolution is
recorded in `docs/MEMORY.md`, P2-T01 entry).

Purity contract (P2-T01 acceptance criteria):
  - No DB session, no network client, no filesystem access anywhere in this
    package or anything it calls.
  - No import of `backend/models/` (the SQLAlchemy layer) or `backend/api/`
    from anywhere in this package.
  - Every public entry point is a pure function: `ScheduleInput -> ScheduleOutput`
    (dataclass in, dataclass out), safe to call from a Celery worker, a script,
    or a unit test with zero side effects and no shared mutable state between
    calls.
  - Deterministic (Invariant I8): identical input always produces a
    structurally-identical output. No dependence on dict/set iteration order,
    no wall-clock/random dependence in the greedy scheduler.

This package *does* import `backend/domain_constants.py` — that module is pure
data (stdlib `typing` only, no DB/model/network dependency of its own), so
depending on it does not violate the purity contract above. See the
`docs/MEMORY.md` P2-T01 entry for the explicit reasoning.

`scheduling.cp_sat` (P2-T06) additionally imports `ortools.sat.python.cp_model`
— a pure numerical constraint-solver library with no DB/network/filesystem
dependency of its own, same purity category as `domain_constants`. See the
`docs/MEMORY.md` P2-T06 entry for `run_cp_sat`'s determinism caveat (I8, as
literally worded, is scoped to "the greedy scheduler" specifically).
"""

from __future__ import annotations

from scheduling.cp_sat import CpSatSolveInfo, run_cp_sat
from scheduling.greedy import run_greedy_sgs
from scheduling.invariants import (
    InvariantViolation,
    check_scheduler_determinism,
    compute_design_load_by_hub,
    compute_lab_load_by_hub,
    validate_invariants,
)
from scheduling.monte_carlo import (
    DeliveryForecast,
    PerturbationParams,
    ProjectDeliveryForecast,
    forecast_delivery,
    format_forecast,
)
from scheduling.solver_comparison import (
    FieldDivergence,
    ProjectDivergence,
    SolverComparisonReport,
    compare_solvers,
    format_report,
)
from scheduling.types import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
    WorkflowStepTemplate,
    default_workflow_template,
)

__all__ = [
    "ChamberInput",
    "CpSatSolveInfo",
    "DeliveryForecast",
    "EngineerInput",
    "FieldDivergence",
    "InvariantViolation",
    "PerturbationParams",
    "ProjectDeliveryForecast",
    "ProjectDivergence",
    "ProjectInput",
    "ProjectScheduleOutcome",
    "ScheduleInput",
    "ScheduleOutput",
    "SolverComparisonReport",
    "StepSchedule",
    "WorkflowStepTemplate",
    "check_scheduler_determinism",
    "compare_solvers",
    "compute_design_load_by_hub",
    "compute_lab_load_by_hub",
    "default_workflow_template",
    "forecast_delivery",
    "format_forecast",
    "format_report",
    "run_cp_sat",
    "run_greedy_sgs",
    "validate_invariants",
]
