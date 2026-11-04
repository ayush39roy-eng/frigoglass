"""HTTP shapes of the What-if plan import (P32-T04, ADR 0044, docs/API_CONTRACT_P32.md B2/B3).

`ImportRow` is both the `/whatif/import/parse` output and the
`/whatif/import/simulate` input (the browser edits it in between), so it is
strict and capped. Nothing here carries a financial field, a customer or a
free-text column of the workbook (ADR 0044 §5): only the columns listed in
the contract are read at all.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from schemas.whatif import (
    BookingStatusLiteral,
    CategoryLiteral,
    HubLiteral,
    OutcomeLiteral,
    PriorityLiteral,
    WorkflowLiteral,
)

#: The statuses a file row may carry (Draft is retired, ADR 0034).
ImportStatusLiteral = Literal[
    "In Buyoff",
    "Under Industrialization",
    "In Development",
    "In Queue",
    "Commercialized",
    "On Hold",
    "Cancelled",
]
SeverityLiteral = Literal["info", "warning", "error"]
StepStatusLiteral = Literal["Not Started", "In Progress", "Blocked", "Done"]
EditableLiteral = Literal["move_resize", "resize", "none"]

#: ADR 0044 §11.
MAX_IMPORT_ROWS = 2000
MAX_SIMULATED_FILE_PROJECTS = 600
MAX_EDITS = 2000
MAX_NUM_PROJECTS = 100

_RowKey = Annotated[str, Field(pattern=r"^row-\d{1,7}$")]
_StepId = Annotated[str, Field(pattern=r"^(PDD|OEM)-[A-N]$")]
_Id = Annotated[str, Field(min_length=1, max_length=64)]
_Raw = Annotated[str, Field(max_length=200)]
_Weeks = Annotated[int, Field(ge=0, le=104)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


# --- the row (parse output, simulate input) -------------------------------------------------


class LeaderExisting(_Strict):
    kind: Literal["existing"]
    engineer_id: _Id
    name: str = Field(default="", max_length=200)


class LeaderNew(_Strict):
    kind: Literal["new"]
    name: str = Field(min_length=1, max_length=100)


class LeaderAuto(_Strict):
    kind: Literal["auto"]


Leader = Annotated[LeaderExisting | LeaderNew | LeaderAuto, Field(discriminator="kind")]


class ImportRow(_Strict):
    key: _RowKey
    file_row: int = Field(ge=1, le=99_999)
    sn: str | None = Field(default=None, max_length=20)
    code: str | None = Field(default=None, max_length=64)
    plant: _Raw | None = None
    name: str = Field(min_length=1, max_length=300)
    hub: HubLiteral
    hub_raw: _Raw | None = None
    category: CategoryLiteral
    category_raw: _Raw | None = None
    lead_time_label: str = Field(min_length=1, max_length=100)
    status: ImportStatusLiteral
    status_raw: _Raw | None = None
    stage_step_id: _StepId | None = None
    stage_raw: _Raw | None = None
    rank: int | None = Field(default=None, ge=1, le=9999)
    priority: PriorityLiteral
    priority_source: Literal["rank", "matched", "default"] = "default"
    engineer_raw: _Raw | None = None
    leader: Leader
    matched_project_id: _Id | None = None
    matched_project_name: str | None = Field(default=None, max_length=300)
    match_by: Literal["name", "code"] | None = None
    num_projects: int | None = Field(default=None, ge=1, le=MAX_NUM_PROJECTS)
    must_do: bool | None = None
    spillover_from_previous: bool | None = None
    complexity: str | None = Field(default=None, max_length=20)
    est_duration_months: str | None = Field(default=None, max_length=40)
    certification_testing_required: bool = True
    step_weeks: dict[_StepId, _Weeks] = Field(max_length=14)
    include: bool = True


class ImportIssue(BaseModel):
    row_key: str | None
    file_row: int | None
    field: str | None
    severity: SeverityLiteral
    code: str
    message: str


class LeadTimeRowOut(BaseModel):
    workflow: WorkflowLiteral
    label: str
    weeks: dict[str, int]


class StepMetaOut(BaseModel):
    workflow: WorkflowLiteral
    step_id: str
    name: str
    kind: Literal["design", "lab", "elapsed"]
    sequence_order: int
    predecessor_ids: list[str]


class RosterEntryOut(BaseModel):
    engineer_id: str
    name: str
    hub: str
    capacity_hub: str
    fte: float


class ImportCounts(BaseModel):
    rows: int
    schedulable: int
    not_scheduled: int
    matched: int
    new: int
    auto_assign: int
    new_designers: int
    #: Σ max(1, num_projects) over the schedulable included rows: the file
    #: projects a simulate with the default `expand_multi=true` builds.
    projects_after_expansion: int


class ImportParseResponse(BaseModel):
    file_name: str
    projects_sheet: str
    steps_sheet: str | None
    base_year: int
    current_week: int
    lead_times: list[LeadTimeRowOut]
    steps_meta: list[StepMetaOut]
    roster: list[RosterEntryOut]
    rows: list[ImportRow]
    issues: list[ImportIssue]
    counts: ImportCounts


# --- simulate ---------------------------------------------------------------------------------


class StepEditIn(_Strict):
    #: An `ImportRow.key` or an existing project id.
    project_ref: _Id
    step_id: _StepId
    duration_weeks: int | None = Field(default=None, ge=1, le=104)
    start_not_before_week: int | None = Field(default=None, ge=1, le=130)
    overlap_weeks: int | None = Field(default=None, ge=1, le=104)


class ImportSimulateRequest(_Strict):
    mode: Literal["merge", "file_only"] = "merge"
    plan_year_end_week: Literal[52, 104] = 104
    #: Owner rule 2026-11-04: `Num of Projects` n >= 2 is n projects by
    #: default; `false` keeps one project per row.
    expand_multi: bool = True
    rows: list[ImportRow] = Field(max_length=MAX_IMPORT_ROWS)
    edits: list[StepEditIn] = Field(default_factory=list, max_length=MAX_EDITS)


class ImportKpisOut(BaseModel):
    projects_total: int
    file_projects: int
    plan_projects: int
    within_plan_year: int
    spillover: int
    left_out: int
    blocked: int
    excluded: int
    data_error: int
    file_within_plan_year: int
    file_scheduled: int
    before_within_plan_year: int | None
    after_within_plan_year_existing: int | None
    newly_slipping: int
    recovered: int


class ImportStepOut(BaseModel):
    step_id: str
    kind: Literal["design", "lab", "elapsed"]
    sequence_order: int
    start_week: int | None
    end_week: int | None
    duration_weeks: int
    span_weeks: int
    skipped: bool
    done_before_import: bool
    status: StepStatusLiteral
    engineer_name: str | None
    chamber_code: str | None
    duration_override_weeks: int | None
    start_not_before_week: int | None
    overlap_weeks: int | None
    editable: EditableLiteral


class ImportProjectOut(BaseModel):
    ref: str
    source: Literal["file", "plan"]
    file_row: int | None
    replaces_project_id: str | None
    name: str
    hub: str
    capacity_hub: str
    category: str | None
    priority: str | None
    status: str
    leader_name: str | None
    leader_ref: str | None
    leader_auto_assigned: bool
    outcome: OutcomeLiteral
    #: Finishes by `plan_year_end_week` (outcome class `within_year`).
    within_plan_year: bool
    start_week: int | None
    end_week: int | None
    finish_week: int | None
    unconstrained_end_week: int | None
    before_outcome: OutcomeLiteral | None
    before_finish_week: int | None
    eng_conflict: bool
    cat_not_allowed: bool
    lab_overlap: bool
    no_leader: bool
    no_chamber_step_id: str | None
    data_error: str | None
    steps: list[ImportStepOut]


class CapacityWindowOut(BaseModel):
    key: str
    label: str
    from_week: int
    to_week: int


class WindowLoadOut(BaseModel):
    key: str
    load_weeks: float
    capacity_weeks: float
    booked_pct: float | None
    status: BookingStatusLiteral


class HubCapacityOut(BaseModel):
    hub: str
    fte: float
    windows: list[WindowLoadOut]


class LabRegionCapacityOut(BaseModel):
    region: str
    chambers: int
    windows: list[WindowLoadOut]


class WeeklySeriesOut(BaseModel):
    load: list[float]
    capacity: list[float]


class WeeklyCapacityOut(BaseModel):
    weeks: list[int]
    hubs: dict[str, WeeklySeriesOut]
    lab_regions: dict[str, WeeklySeriesOut]


class DesignerWindowOut(BaseModel):
    key: str
    #: Effort weeks booked in the window (the hub-load basis, ADR 0028).
    booked_weeks: float
    #: Calendar weeks the designer is booked in the window.
    booked_span_weeks: int
    available_weeks: float
    booked_pct: float | None
    status: BookingStatusLiteral


class DesignerCapacityOut(BaseModel):
    ref: str
    name: str
    hub: str
    fte: float
    is_new: bool
    windows: list[DesignerWindowOut]


class ImportCapacityOut(BaseModel):
    windows: list[CapacityWindowOut]
    hubs: list[HubCapacityOut]
    lab_regions: list[LabRegionCapacityOut]
    weekly: WeeklyCapacityOut
    designers: list[DesignerCapacityOut]


class ImportChangeOut(BaseModel):
    ref: str
    name: str
    hub: str
    before_finish_week: int | None
    after_finish_week: int | None


class ImportChangesOut(BaseModel):
    newly_slipping: list[ImportChangeOut]
    recovered: list[ImportChangeOut]
    moved: list[ImportChangeOut]


class SimIssueOut(BaseModel):
    ref: str | None
    severity: SeverityLiteral
    code: str
    message: str


# --- served breakdowns (P32-R05, docs/API_CONTRACT_P32.md C1) ---------------------------------

#: `all`, `<base year>`, `<base year + 1>`, `later`, `not_placed`.
BreakdownYearKey = Annotated[str, Field(pattern=r"^(all|\d{4}|later|not_placed)$")]


class BreakdownYearOut(_Strict):
    key: BreakdownYearKey
    label: str


class BreakdownOutcomesOut(_Strict):
    within_year: int
    spillover: int
    left_out: int
    blocked: int
    data_error: int
    excluded: int


class BreakdownBucketOut(_Strict):
    #: The category / hub / priority / status / source value; `unknown` when
    #: the project carries none (a data-error file row).
    key: str
    total: int
    #: Finishes by the plan year end (`within_plan_year`).
    within_year: int
    #: Placed but finishes after the plan year end.
    spillover: int
    #: left_out + blocked + data_error.
    not_placed: int


class FinishQuarterOut(_Strict):
    key: Annotated[str, Field(pattern=r"^\d{4}-Q[1-4]$")]
    label: str
    count: int


class BreakdownOut(_Strict):
    total: int
    file: int
    plan: int
    outcomes: BreakdownOutcomesOut
    by_category: list[BreakdownBucketOut]
    by_hub: list[BreakdownBucketOut]
    by_priority: list[BreakdownBucketOut]
    by_status: list[BreakdownBucketOut]
    by_source: list[BreakdownBucketOut]
    #: Placed projects only, chronological.
    by_finish_quarter: list[FinishQuarterOut]


class ImportBreakdownsOut(_Strict):
    years: list[BreakdownYearOut]
    #: One block per `years[].key`, always all five (an empty block has total 0).
    by_year: dict[str, BreakdownOut]


class ImportSimulateResponse(BaseModel):
    base_year: int
    current_week: int
    plan_year_end_week: int
    horizon_weeks: int
    mode: Literal["merge", "file_only"]
    kpis: ImportKpisOut
    steps_meta: list[StepMetaOut]
    projects: list[ImportProjectOut]
    capacity: ImportCapacityOut
    changes: ImportChangesOut
    issues: list[SimIssueOut]
    workings: list[str]
    #: Chart figures over exactly `projects` (P32-R05, C1).
    breakdowns: ImportBreakdownsOut
