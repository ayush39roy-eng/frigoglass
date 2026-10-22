"""Pure, deterministic scheduling engine for the RPD Web Application.

Owned exclusively by `algorithm-engineer`. Rules enforced here are exactly
`docs/DOMAIN_RULES.md`'s "Scheduling order", "Precedence", "Booking rules",
"Per-stage progress capture", "Expected vs projected completion", "Step
timing from the Gantt" and Invariants I1-I17, I21-I22, I25-I26 (ADR 0041:
`effort_split.py` apportions a per-project effort figure, `demand.py` checks
demand and the split over live rows) (`whatif.py`, P18: pure
what-if planning on top of the greedy SGS) — implemented from that
document directly. The prototype
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
`SCHEDULABLE_STATUS_ORDER`, `HUB_LAB_REGION` and `OEM_HUBS` only (the last two
through `scheduling.hubs`, which accepts both spellings of the renamed
`OEM-Seltek` / `OEM-Seitek` hub, ADR 0041 §4). The workflow
templates, the lead-time table, the category rank and the lab-consumption
factor are defined in `scheduling.types` (transcribed from DOMAIN_RULES.md).
`scheduling.cp_sat` additionally imports `ortools.sat.python.cp_model`.
"""

from __future__ import annotations

from scheduling.cp_sat import CpSatSolveInfo, run_cp_sat
from scheduling.demand import (
    DemandLoad,
    LiveProjectRow,
    LiveStepRow,
    ServedDesignLoad,
    ServedLabLoad,
    check_i25_demand,
    check_i26_effort_split,
    compute_demand_load,
)
from scheduling.effort_split import (
    EffortSplit,
    EffortSplitRejected,
    EffortStepInput,
    ProjectEffortDerivation,
    apportion_effort,
    derive_project_effort,
    effort_target_weeks,
    round_half_up,
)
from scheduling.greedy import run_greedy_sgs
from scheduling.hubs import canonical_hub_name
from scheduling.invariants import (
    CrossCapacityHubLeader,
    InvariantViolation,
    check_scheduler_determinism,
    compute_design_load_by_capacity_hub,
    compute_design_load_by_hub,
    compute_lab_load_by_hub,
    cross_capacity_hub_leaders,
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
    StepTimingInput,
    WorkflowStepTemplate,
    default_lead_times,
    default_workflow_templates,
)
from scheduling.whatif import (
    MAX_ADDED_CHAMBERS_TOTAL,
    MAX_ADDED_DESIGNERS_TOTAL,
    MAX_ADDED_PROJECTS_TOTAL,
    MAX_REMOVED_DESIGNERS_TOTAL,
    AddChamber,
    AddEngineer,
    Additions,
    AddProject,
    AnalyticRequirements,
    ChamberDowntimeChange,
    ChamberSupplyInput,
    HubCalendarInput,
    MinimumAdditionsResult,
    RemoveEngineerCount,
    Scenario,
    SimulationResult,
    WhatIfBaseline,
    WhatIfBudgetExceeded,
    analytic_requirements,
    apply_scenario,
    build_scenario_input,
    scenario_with_additions,
    simulate,
    solve_minimum_additions,
    touched_scope,
    validate_scenario_limits,
)
from scheduling.workflow import (
    STEP_DURATION_MAX_WEEKS,
    STEP_DURATION_MIN_WEEKS,
    ProjectPlan,
    analyse_project,
    build_lead_time_table,
    build_workflows,
    canonical_step_timing,
    compute_progress_pct,
    derive_remaining,
    fte_span,
    is_step_skipped,
    is_valid_fte,
    merged_step_override,
    project_progress_pct,
    step_effective_weeks,
    unconstrained_end_week,
)

__all__ = [
    "AddChamber",
    "AddEngineer",
    "AddProject",
    "Additions",
    "AnalyticRequirements",
    "ChamberDowntimeChange",
    "ChamberSupplyInput",
    "HubCalendarInput",
    "MAX_ADDED_CHAMBERS_TOTAL",
    "MAX_ADDED_DESIGNERS_TOTAL",
    "MAX_ADDED_PROJECTS_TOTAL",
    "MAX_REMOVED_DESIGNERS_TOTAL",
    "MinimumAdditionsResult",
    "RemoveEngineerCount",
    "Scenario",
    "SimulationResult",
    "WhatIfBaseline",
    "WhatIfBudgetExceeded",
    "analytic_requirements",
    "apply_scenario",
    "build_scenario_input",
    "scenario_with_additions",
    "simulate",
    "solve_minimum_additions",
    "touched_scope",
    "validate_scenario_limits",
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
    "StepTimingInput",
    "WorkflowStepTemplate",
    "analyse_project",
    "build_lead_time_table",
    "build_workflows",
    "canonical_step_timing",
    "check_scheduler_determinism",
    "compare_solvers",
    "CrossCapacityHubLeader",
    "compute_design_load_by_capacity_hub",
    "compute_design_load_by_hub",
    "compute_lab_load_by_hub",
    "cross_capacity_hub_leaders",
    "compute_progress_pct",
    "default_lead_times",
    "default_workflow_templates",
    "derive_remaining",
    "forecast_delivery",
    "fte_span",
    "is_valid_fte",
    "format_forecast",
    "format_report",
    "project_progress_pct",
    "run_cp_sat",
    "run_greedy_sgs",
    "unconstrained_end_week",
    "validate_invariants",
    # ADR 0041 (P30-T01)
    "STEP_DURATION_MAX_WEEKS",
    "STEP_DURATION_MIN_WEEKS",
    "DemandLoad",
    "EffortSplit",
    "EffortSplitRejected",
    "EffortStepInput",
    "LiveProjectRow",
    "LiveStepRow",
    "ProjectEffortDerivation",
    "ServedDesignLoad",
    "ServedLabLoad",
    "apportion_effort",
    "canonical_hub_name",
    "check_i25_demand",
    "check_i26_effort_split",
    "compute_demand_load",
    "derive_project_effort",
    "effort_target_weeks",
    "is_step_skipped",
    "merged_step_override",
    "round_half_up",
    "step_effective_weeks",
]
