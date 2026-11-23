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

from schemas.delivery import DeliveryByYearOut, DeliveryUnavailable, LeftOutReason
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
#: ADR 0055 D2 / API_CONTRACT_P41 B.
MAX_EXCLUDED_PLAN_PROJECTS = 2000

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


class ImportRowChange(_Strict):
    """P58-B: one cell of a re-uploaded Projects list that differs from the
    project as served. `field` is the Projects table column id."""

    field: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=40)
    before: str | None = Field(default=None, max_length=200)
    after: str | None = Field(default=None, max_length=200)
    #: False for a column that is not a scheduling input (code, type, dates).
    simulated: bool = True


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
    #: 1..9999 from PRIORITY; 0 = "Running" (scheduled first, P32-R06).
    rank: int | None = Field(default=None, ge=0, le=9999)
    priority: PriorityLiteral
    #: ADR 0061 (R49-3): "band" = from the band columns ("Must Do" …).
    priority_source: Literal["band", "rank", "running", "matched", "default"] = "default"
    engineer_raw: _Raw | None = None
    leader: Leader
    matched_project_id: _Id | None = None
    matched_project_name: str | None = Field(default=None, max_length=300)
    match_by: Literal["name", "code", "id"] | None = None
    num_projects: int | None = Field(default=None, ge=1, le=MAX_NUM_PROJECTS)
    must_do: bool | None = None
    spillover_from_previous: bool | None = None
    complexity: str | None = Field(default=None, max_length=20)
    est_duration_months: str | None = Field(default=None, max_length=40)
    certification_testing_required: bool = True
    step_weeks: dict[_StepId, _Weeks] = Field(max_length=14)
    include: bool = True
    #: ADR 0061 (R49-2, R49-6): the most urgent band column saying Yes, for
    #: display and audit only. Simulate never re-derives `priority` from it.
    file_band: Literal["P1", "P2", "P3", "P4"] | None = None
    #: P58-B (a Projects list file only; null for the capacity-planning
    #: format): "unchanged" = no scheduling input differs from the plan
    #: project, so in merge mode the row is NOT a file project (the plan
    #: project stays as it is); "changed" = it replaces its plan project;
    #: "new" = no project matched.
    change_kind: Literal["new", "changed", "unchanged"] | None = None
    changes: list[ImportRowChange] = Field(default_factory=list, max_length=30)


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
    #: Rows whose status was derived (no Status cell): from PRIORITY "Running",
    #: the matched plan project or "Spillover from …" = Yes (P32-R06).
    derived_status: int
    #: Rows excluded as budget lines, `NOT_A_PROJECT` (P32-R06).
    not_a_project: int
    #: P58-B (a Projects list file): matched rows with / without a
    #: scheduling change. 0 for the capacity-planning format.
    changed: int = 0
    unchanged: int = 0


class PlanWeekChoiceOut(BaseModel):
    """ADR 0061 (R49-7, I40): an absolute week the "Plan from" / "Plan until"
    pickers may offer, with its server-made label ("W1 2027 (4 Jan 2027)")."""

    week: int
    label: str


class PlanUntilPresetOut(BaseModel):
    """P53 (R53-4): a "Plan until" preset, the end of one calendar year
    within the search limit."""

    year: int
    week: int
    label: str


class ImportParseResponse(BaseModel):
    file_name: str
    #: P58-B: "plan" = the capacity-planning workbook; "projects_list" = a
    #: Projects page download (rows carry `change_kind` / `changes`).
    file_format: Literal["plan", "projects_list"] = "plan"
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
    #: ADR 0061 (R49-7): the earliest "Plan from" week (= `current_week`, the
    #: default) and every week the pickers may offer (`current_week`..104),
    #: labelled by the server (the browser derives no dates, I40).
    plan_from_min_week: int
    plan_week_choices: list[PlanWeekChoiceOut]
    #: P53 (R53-4): year-end presets within the search limit.
    plan_until_presets: list[PlanUntilPresetOut] = Field(default_factory=list)


# --- simulate ---------------------------------------------------------------------------------


class StepEditIn(_Strict):
    #: An `ImportRow.key` or an existing project id.
    project_ref: _Id
    step_id: _StepId
    duration_weeks: int | None = Field(default=None, ge=1, le=104)
    #: P53 (R53-4, R53-8): an absolute week; `<= H` is checked by the service.
    start_not_before_week: int | None = Field(default=None, ge=1, le=5200)
    overlap_weeks: int | None = Field(default=None, ge=1, le=104)


class ImportSimulateRequest(_Strict):
    mode: Literal["merge", "file_only"] = "merge"
    #: P53 (R53-4): a year end (a multiple of 52) within `cw..H`; null =
    #: `year_end(year_of(cw))`. Checked by the service (422 `INVALID_IMPORT`).
    plan_year_end_week: int | None = Field(default=None, ge=52, le=5200)
    #: Owner rule 2026-11-04: `Num of Projects` n >= 2 is n projects by
    #: default; `false` keeps one project per row.
    expand_multi: bool = True
    rows: list[ImportRow] = Field(max_length=MAX_IMPORT_ROWS)
    edits: list[StepEditIn] = Field(default_factory=list, max_length=MAX_EDITS)
    #: ADR 0055 D2: unticked plan projects, taken out of both runs (merge
    #: only; unique; each must be an in-scope plan project of the baseline).
    exclude_plan_project_ids: list[_Id] = Field(
        default_factory=list, max_length=MAX_EXCLUDED_PLAN_PROJECTS
    )
    #: ADR 0061 (R49-7): the week the file projects start from (absolute; 53 =
    #: W1 of the next year). None = the calendar week. Valid
    #: `current_week <= f <= plan_until_week`, else 422 `INVALID_IMPORT`.
    plan_from_week: int | None = Field(default=None, ge=1, le=5200)
    #: ADR 0061 amendment (R49-15): the plan window's last week u. None = the
    #: `plan_year_end_week` preset. Valid `f <= u <= H` (P53 R53-4), else 422.
    plan_until_week: int | None = Field(default=None, ge=1, le=5200)
    #: R49-13 / R49-19 "Re-run on today's plan": raise a stored f below
    #: today's week to it (`PLAN_FROM_RAISED`), then u to f when below it
    #: (`PLAN_UNTIL_RAISED`), instead of answering 422.
    plan_window_rerun: bool = False


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
    #: ADR 0055 D2: plan projects taken out by `exclude_plan_project_ids`.
    plan_excluded: int = 0
    # --- P42 (ADR 0056 R42-6, docs/API_CONTRACT_P42.md §9). The four year
    # counts above hold counting outcomes only (the classes are exclusive).
    # Defaults 0 so a P41 saved snapshot (taken before P42) still reads. ---
    #: Outcome class `queued` (P3 In Queue: spare capacity only).
    queued: int = 0
    #: Outcome class `not_scheduled_priority` (non-frozen P4/Q), including
    #: the plan projects not served as rows (the engine hides excluded ones).
    not_scheduled_priority: int = 0


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
    #: ADR 0067: the effective band (null for Commercialized / Cancelled).
    priority: str | None
    #: ADR 0067: false for a Commercialized / Cancelled project.
    priority_applicable: bool = True
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
    #: P42 (R42-4): the engine's flags. Defaults keep P41 snapshots readable.
    counts_toward_year: bool = True
    not_scheduled_priority: bool = False
    #: Audit M1 (I58): why the project was not placed, the same value the
    #: What-if `ProjectResultOut` and the live run serve (`no_leader` /
    #: `no_chamber` / `data_error` / `beyond_horizon`); null when placed.
    left_out_reason: LeftOutReason | None = None
    #: The reason in words (`delivery_serving.left_out_reason_label`).
    left_out_reason_label: str | None = None


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
    #: P42 (R42-6). Defaults keep P41 snapshots readable.
    queued: int = 0
    not_scheduled_priority: int = 0


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
    #: P42 (R42-6): outcome class `queued` (never in the three above). In a
    #: finish-year block a placed queued project sits here, not in
    #: `within_year`; a queued project with no slot is in the `not_placed`
    #: block. Default keeps P41 snapshots readable.
    queued: int = 0


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


class PlanProjectOut(BaseModel):
    """ADR 0055 D2: an in-scope plan project that could be in the run (the
    tick list of a hand-picked scenario)."""

    id: str
    name: str
    hub: str
    category: str | None
    priority: str | None
    status: str


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
    #: ADR 0055 D2: merge mode only, before exclusion; `[]` in file_only.
    plan_projects: list[PlanProjectOut] = Field(default_factory=list)
    # --- ADR 0061 (R49-7, R49-15). None only in a snapshot saved before
    # P49 (the saved-scenario read fills them from the stored weeks). ---
    #: The resolved "Plan from" week f (file projects start from it).
    plan_from_week: int | None = None
    #: The earliest allowed f (= `current_week`).
    plan_from_min_week: int | None = None
    #: f as a server-made label, e.g. "W1 2027 (4 Jan 2027)".
    plan_from_label: str | None = None
    #: The resolved plan window end u: the cut-off of every "within" figure.
    plan_until_week: int | None = None
    #: "W48 2026 – W20 2027" when the request set `plan_until_week`, else None
    #: (the plan-year wording stays, R49-18).
    plan_window_label: str | None = None
    #: The weeks the pickers may offer (`current_week`..H), labelled.
    plan_week_choices: list[PlanWeekChoiceOut] = Field(default_factory=list)
    #: P53 (R53-4): year-end presets within the search limit.
    plan_until_presets: list[PlanUntilPresetOut] = Field(default_factory=list)
    #: P53 (R53-3, I59): the delivery table over exactly `projects`; null on a
    #: scenario saved before P53 (`delivery_by_year_unavailable`).
    delivery_by_year: DeliveryByYearOut | None = None
    delivery_by_year_unavailable: DeliveryUnavailable | None = None
