"""What-if planner HTTP shapes (P18-T02, ADR 0031, docs/API_CONTRACT_P18.md section 9).

Requests are strict and reject unknown keys. The scenario model is the ONLY
way anything (a form or the chat model) describes a change; the same classes
validate both. Responses are typed mirrors of the engine's result dataclasses
(`scheduling.whatif`), narrowed to the caller's hub scope by
`services.whatif`. Nothing here carries a financial field, a customer name or
a real engineer name.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_core import PydanticCustomError

from scheduling.whatif import (
    MAX_ADDED_CHAMBERS_TOTAL,
    MAX_ADDED_DESIGNERS_TOTAL,
    MAX_ADDED_PROJECTS_TOTAL,
    MAX_REMOVED_DESIGNERS_TOTAL,
)

HubLiteral = Literal["R&D-Greece", "R&D-India", "PD-India", "PD-Romania", "OEM-HCK", "OEM-Seitek"]
RegionLiteral = Literal["Greece", "India", "Romania"]
CategoryLiteral = Literal["A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM"]
PriorityLiteral = Literal["P1", "P2", "P3", "P4", "Q"]
SchedulableStatusLiteral = Literal[
    "In Buyoff", "Under Industrialization", "In Development", "In Queue"
]
ProjectTypeLiteral = Literal["NM", "CO", "RC", "NO", "IMP"]
WorkflowLiteral = Literal["PDD", "OEM"]
BasisLiteral = Literal["year", "remaining"]
TargetLiteral = Literal["all_new_within_year", "no_existing_slips"]
OutcomeLiteral = Literal[
    "within_year", "spillover", "left_out", "blocked", "excluded", "data_error"
]
BookingStatusLiteral = Literal["available", "near_full", "full"]

#: Per-list size limits: a scenario is a handful of lines, never a bulk import.
_MAX_LINES = 30
_StageId = Annotated[str, Field(pattern=r"^(PDD|OEM)-[A-N]$")]
_Id = Annotated[str, Field(min_length=1, max_length=64)]
_Weeks = Annotated[float, Field(ge=0, le=52, allow_inf_nan=False)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


# --- scenario (request) ----------------------------------------------------------------


class AddProjectIn(_Strict):
    hub: HubLiteral
    category: CategoryLiteral
    count: int = Field(default=1, ge=1, le=MAX_ADDED_PROJECTS_TOTAL)
    project_type: ProjectTypeLiteral | None = None
    status: SchedulableStatusLiteral = "In Queue"
    priority: PriorityLiteral | None = None
    score: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    workflow_id: WorkflowLiteral | None = None
    certification_testing_required: bool = True


class AddEngineerIn(_Strict):
    hub: HubLiteral
    fte: float = Field(default=1.0, gt=0, le=1, allow_inf_nan=False)
    count: int = Field(default=1, ge=1, le=MAX_ADDED_DESIGNERS_TOTAL)
    allowed_categories: list[CategoryLiteral] | None = Field(default=None, max_length=7)


class RemoveEngineerCountIn(_Strict):
    hub: HubLiteral
    count: int = Field(default=1, ge=1, le=MAX_REMOVED_DESIGNERS_TOTAL)


class AddChamberIn(_Strict):
    lab_region: RegionLiteral
    count: int = Field(default=1, ge=1, le=MAX_ADDED_CHAMBERS_TOTAL)
    platforms: int | None = Field(default=None, ge=1, le=20)
    efficiency: float | None = Field(default=None, ge=0, le=1.5, allow_inf_nan=False)
    maintenance_weeks: _Weeks | None = None
    breakdown_weeks: _Weeks | None = None
    calibration_weeks: _Weeks | None = None
    allowed_stages: list[_StageId] | None = Field(default=None, max_length=14)


class ChamberDowntimeIn(_Strict):
    chamber_id: _Id
    maintenance_weeks: _Weeks | None = None
    breakdown_weeks: _Weeks | None = None
    calibration_weeks: _Weeks | None = None


class PriorityOverrideIn(_Strict):
    project_id: _Id
    priority: PriorityLiteral


class ChatScenario(_Strict):
    """What the chat model may describe. No engineer ids and no project ids:
    the model never sees either, so it has no business naming them."""

    add_projects: list[AddProjectIn] = Field(default_factory=list, max_length=_MAX_LINES)
    add_engineers: list[AddEngineerIn] = Field(default_factory=list, max_length=_MAX_LINES)
    remove_engineer_counts: list[RemoveEngineerCountIn] = Field(
        default_factory=list, max_length=_MAX_LINES
    )
    add_chambers: list[AddChamberIn] = Field(default_factory=list, max_length=_MAX_LINES)
    chamber_downtime: list[ChamberDowntimeIn] = Field(default_factory=list, max_length=_MAX_LINES)

    @model_validator(mode="after")
    def _engine_caps(self) -> ChatScenario:
        """Mirror of `scheduling.whatif.validate_scenario_limits` (S18-M1): the
        TOTALS over all lines, so a request that the engine would refuse is
        refused before any baseline is loaded. Error type `scenario_limit`
        is answered as 422 with `code: INVALID_SCENARIO`."""

        removed = sum(r.count for r in self.remove_engineer_counts) + len(
            set(getattr(self, "remove_engineers", ()))
        )
        for what, got, cap in (
            ("projects can be added", sum(p.count for p in self.add_projects),
             MAX_ADDED_PROJECTS_TOTAL),
            ("designers can be added", sum(e.count for e in self.add_engineers),
             MAX_ADDED_DESIGNERS_TOTAL),
            ("designers can be removed", removed, MAX_REMOVED_DESIGNERS_TOTAL),
            ("chambers can be added", sum(c.count for c in self.add_chambers),
             MAX_ADDED_CHAMBERS_TOTAL),
        ):  # fmt: skip
            if got > cap:
                raise PydanticCustomError(
                    "scenario_limit",
                    "at most {cap} {what} in one scenario (got {got})",
                    {"cap": cap, "what": what, "got": got},
                )
        return self


class ScenarioRequest(ChatScenario):
    """The full scenario of the forms: the chat shape plus named designers to
    remove and per-project priority overrides."""

    remove_engineers: list[_Id] = Field(default_factory=list, max_length=_MAX_LINES)
    priority_overrides: list[PriorityOverrideIn] = Field(
        default_factory=list, max_length=_MAX_LINES
    )


class EstimateRequest(_Strict):
    scenario: ScenarioRequest = Field(default_factory=ScenarioRequest)
    basis: BasisLiteral = "year"
    designer_fte: float = Field(default=1.0, gt=0, le=1, allow_inf_nan=False)


class SimulateRequest(_Strict):
    scenario: ScenarioRequest = Field(default_factory=ScenarioRequest)


class SolveRequest(_Strict):
    scenario: ScenarioRequest = Field(default_factory=ScenarioRequest)
    target: TargetLiteral = "all_new_within_year"
    designer_fte: float = Field(default=1.0, gt=0, le=1, allow_inf_nan=False)
    max_runs: int = Field(default=60, ge=2, le=60)
    max_units_per_dimension: int = Field(default=25, ge=1, le=25)


# --- shared response parts --------------------------------------------------------------


class ScopeInfo(BaseModel):
    """What the figures cover. A Hub Planner sees `all_hubs=false`, their own
    hubs, and the lab regions of those hubs (region lab figures are shared by
    every hub of the region, as on the Capacity surface)."""

    all_hubs: bool
    hubs: list[str]
    lab_regions: list[str]


class HubDesignRequirementOut(BaseModel):
    hub: str
    added_projects: int
    extra_design_weeks: int
    baseline_load_weeks: float
    new_load_weeks: float
    fte_before: float
    fte_after_scenario: float
    working_weeks_per_engineer: float
    capacity_before: float
    capacity_after_scenario: float
    booked_pct_before: float | None
    booked_pct_after: float | None
    status_before: BookingStatusLiteral
    status_after: BookingStatusLiteral
    min_extra_designers: int
    min_extra_fte: float
    designer_fte: float
    reachable: bool


class LabRegionRequirementOut(BaseModel):
    lab_region: str
    added_projects: int
    extra_lab_weeks: float
    baseline_load_weeks: float
    new_load_weeks: float
    chambers_before: int
    chambers_after_scenario: int
    capacity_before: float
    capacity_after_scenario: float
    booked_pct_before: float | None
    booked_pct_after: float | None
    status_before: BookingStatusLiteral
    status_after: BookingStatusLiteral
    efficient_lab_weeks_per_new_chamber: float
    min_extra_chambers: int
    reachable: bool


class EstimateResponse(BaseModel):
    kind: Literal["estimate"] = "estimate"
    scope: ScopeInfo
    #: P18-R02 (D2b): the hubs / lab regions this scenario touches (visible to
    #: the caller only). The four headline totals sum ONLY these rows; every
    #: hub / region keeps its row in `design` / `lab`.
    touched_hubs: list[str]
    touched_lab_regions: list[str]
    basis: BasisLiteral
    target_below_pct: float
    extra_design_weeks_total: int
    extra_lab_weeks_total: float
    min_extra_designers_total: int
    min_extra_chambers_total: int
    design: list[HubDesignRequirementOut]
    lab: list[LabRegionRequirementOut]
    workings: list[str]


class ProjectResultOut(BaseModel):
    project_id: str
    name: str
    hub: str
    category: str | None
    priority: str | None
    is_new: bool
    outcome: OutcomeLiteral
    finish_week: int | None
    within_year: bool
    unconstrained_end_week: int | None


class UtilizationRowOut(BaseModel):
    scope: Literal["hub", "lab_region"]
    key: str
    load_weeks: float
    capacity_year: float
    booked_pct_year: float | None
    status_year: BookingStatusLiteral
    capacity_remaining: float
    booked_pct_remaining: float | None
    status_remaining: BookingStatusLiteral
    units: float


class ProjectChangeOut(BaseModel):
    project_id: str
    name: str
    hub: str
    kind: Literal["newly_slipping", "recovered", "moved"]
    before_outcome: OutcomeLiteral
    after_outcome: OutcomeLiteral
    before_finish_week: int | None
    after_finish_week: int | None


class ScenarioDiffOut(BaseModel):
    within_year_before: int
    within_year_after: int
    within_year_delta: int
    existing_within_year_before: int
    existing_within_year_after: int
    new_projects_total: int
    new_projects_within_year: int
    newly_slipping: list[ProjectChangeOut]
    recovered: list[ProjectChangeOut]
    moved: list[ProjectChangeOut]


class SimulateResponse(BaseModel):
    kind: Literal["simulation"] = "simulation"
    scope: ScopeInfo
    projects: list[ProjectResultOut]
    outcome_counts_before: dict[str, int]
    outcome_counts_after: dict[str, int]
    utilization_before: list[UtilizationRowOut]
    utilization_after: list[UtilizationRowOut]
    diff: ScenarioDiffOut
    new_project_ids: list[str]
    added_engineer_ids: list[str]
    added_chamber_ids: list[str]
    removed_engineer_ids: list[str]
    reassigned_project_ids: list[str]
    greedy_runs: int
    workings: list[str]


class DesignerAdditionOut(BaseModel):
    hub: str
    count: int


class ChamberAdditionOut(BaseModel):
    lab_region: str
    count: int


class AdditionsOut(BaseModel):
    designers: list[DesignerAdditionOut]
    chambers: list[ChamberAdditionOut]
    total: int


class UnattainableProjectOut(BaseModel):
    """An added project whose lead-time critical path alone ends after the
    planning year: no number of designers or chambers brings it inside
    (OQ #47)."""

    project_id: str
    name: str
    hub: str
    category: str | None
    unconstrained_end_week: int | None


#: Fixed text explaining `met` / `met_attainable` (OQ #47). Served so no
#: client has to invent its own wording.
SOLVE_SEMANTICS = (
    "met: every project of the target finishes inside the planning year. "
    "met_attainable: every project that capacity can still help does. They differ when "
    "unattainable_project_ids is not empty: those added projects cannot finish this year "
    "whatever is added (their lead-time critical path alone ends after the year), so met is "
    "false while met_attainable can be true. "
    "exact: true only when every smaller combination of designers and chambers was actually "
    "simulated and failed, so the answer is a proven minimum. When exact is false the answer "
    "is the smallest found, assuming more capacity never hurts; a smaller combination may "
    "exist that was not simulated within the run budget."
)


class SolveResponse(BaseModel):
    kind: Literal["solution"] = "solution"
    scope: ScopeInfo
    target: TargetLiteral
    met: bool
    met_attainable: bool
    unattainable_project_ids: list[str]
    unattainable_projects: list[UnattainableProjectOut]
    semantics: str = SOLVE_SEMANTICS
    capped: bool
    exact: bool
    additions: AdditionsOut
    unmet_project_ids: list[str]
    runs_used: int
    run_cap: int
    searched_designer_hubs: list[str]
    searched_chamber_regions: list[str]
    achieved: SimulateResponse | None
    workings: list[str]


# --- capacity snapshot (chat tool, also usable by the UI) --------------------------------


class SnapshotChamberOut(BaseModel):
    chamber_id: str
    code: str
    platforms: int
    efficiency: float


class SnapshotHubOut(BaseModel):
    hub: str
    lab_region: str
    engineer_fte_total: float
    design_load_weeks: float
    design_capacity_year: float
    design_capacity_remaining: float
    design_booked_pct_year: float | None
    design_booked_pct_remaining: float | None
    design_booking_status_year: BookingStatusLiteral
    lab_load_weeks: float
    lab_capacity_year: float
    lab_capacity_remaining: float
    lab_booked_pct_year: float | None
    lab_booked_pct_remaining: float | None
    lab_booking_status_year: BookingStatusLiteral
    chambers: list[SnapshotChamberOut]


class CapacitySnapshotResponse(BaseModel):
    kind: Literal["capacity_snapshot"] = "capacity_snapshot"
    scope: ScopeInfo
    current_week: int
    year_end_week: int
    near_full_threshold_pct: float
    full_threshold_pct: float
    has_active_schedule_run: bool
    hubs: list[SnapshotHubOut]


# --- chat ----------------------------------------------------------------------------------

ToolName = Literal[
    "estimate_requirements", "simulate_scenario", "find_minimum_additions", "get_capacity_snapshot"
]


class AskRequest(_Strict):
    question: str = Field(min_length=1, max_length=1000)
    #: The scenario of the previous turn, if the user is refining it. It is
    #: validated like any other scenario and is the only context carried
    #: (stateless, ADR 0014).
    prior_scenario: ChatScenario | None = None


class ToolRunOut(BaseModel):
    """One engine call the assistant made: the tool, the scenario it passed,
    and the engine's own scoped output (the numbers the answer quotes)."""

    tool: ToolName
    scenario: ChatScenario | None
    error: str | None
    result: Annotated[
        EstimateResponse | SimulateResponse | SolveResponse | CapacitySnapshotResponse | None,
        Field(discriminator="kind"),
    ]


class AskResponse(BaseModel):
    answer: str
    #: The assistant declined (question outside capacity / project scenario
    #: planning); `answer` is then the fixed refusal text.
    refused: bool
    #: Every number in `answer` appears in the engine outputs, the question or
    #: the scenario (verified on the server).
    grounded: bool
    ungrounded_numbers: list[str]
    #: The last scenario the assistant built, for the user to edit and re-run
    #: through the forms. Null when no scenario tool was called.
    scenario: ChatScenario | None
    results: list[ToolRunOut]
    workings: list[str]
    rounds_used: int
    #: The round cap ended the conversation before the model finished.
    truncated: bool
