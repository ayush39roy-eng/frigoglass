"""Pure, deterministic scheduling engine for the RPD Web Application.

Owned exclusively by `algorithm-engineer`. Rules enforced here are exactly
`docs/DOMAIN_RULES.md`'s "Scheduling order", "Precedence", "Booking rules",
"Per-stage progress capture", "Expected vs projected completion" and
Invariants I1-I17 — implemented from that document directly. The prototype
oracle was retired at P2 close.

Purity contract:
  - No DB session, no network client, no filesystem access anywhere in this
    package or anything it calls (the `_selftest*` scripts read the seed JSON
    only from their own script entry points).
  - No import of `backend/models/` or `backend/api/` from anywhere here.
  - Every public entry point is a pure function: `ScheduleInput -> ScheduleOutput`.
  - Deterministic (Invariant I8): identical input always produces
    byte-identical output. No dependence on dict/set iteration order.

This package imports `backend/domain_constants.py` (pure data) for
`CURRENT_WEEK`, `HORIZON_WEEKS`, `WITHIN_YEAR_WEEK`, `PRIORITY_ORDER`,
`SCHEDULABLE_STATUS_ORDER`, `HUB_LAB_REGION` and `OEM_HUBS` only. The workflow
templates, the lead-time table, the category rank and the lab-consumption
factor are defined in `scheduling.types` (transcribed from DOMAIN_RULES.md).
`scheduling.cp_sat` additionally imports `ortools.sat.python.cp_model`.
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
    CATEGORY_RANK,
    LAB_CONSUMPTION_PER_PROJECT_WEEK,
    ChamberInput,
    EngineerInput,
    LeadTime,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepProgressInput,
    StepSchedule,
    WorkflowStepTemplate,
    default_lead_times,
    default_workflow_templates,
)
from scheduling.workflow import (
    ProjectPlan,
    analyse_project,
    build_lead_time_table,
    build_workflows,
    compute_progress_pct,
    derive_remaining,
    project_progress_pct,
    unconstrained_end_week,
)

__all__ = [
    "CATEGORY_RANK",
    "LAB_CONSUMPTION_PER_PROJECT_WEEK",
    "ChamberInput",
    "CpSatSolveInfo",
    "DeliveryForecast",
    "EngineerInput",
    "FieldDivergence",
    "InvariantViolation",
    "LeadTime",
    "PerturbationParams",
    "ProjectDeliveryForecast",
    "ProjectDivergence",
    "ProjectInput",
    "ProjectPlan",
    "ProjectScheduleOutcome",
    "ScheduleInput",
    "ScheduleOutput",
    "SolverComparisonReport",
    "StepProgressInput",
    "StepSchedule",
    "WorkflowStepTemplate",
    "analyse_project",
    "build_lead_time_table",
    "build_workflows",
    "check_scheduler_determinism",
    "compare_solvers",
    "compute_design_load_by_hub",
    "compute_lab_load_by_hub",
    "compute_progress_pct",
    "default_lead_times",
    "default_workflow_templates",
    "derive_remaining",
    "forecast_delivery",
    "format_forecast",
    "format_report",
    "project_progress_pct",
    "run_cp_sat",
    "run_greedy_sgs",
    "unconstrained_end_week",
    "validate_invariants",
]
