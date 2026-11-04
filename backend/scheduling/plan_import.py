"""Plan import into the What-if planner (P32-T02, ADR 0044, docs/API_CONTRACT_P32.md B1).

`run_plan_import` takes the live plan (`WhatIfBaseline`, ADR 0031) and the
reviewed rows of a capacity-planning workbook (`PlanImportRequest`; the
service parses the `.xlsx`, this module never sees a file) and returns the full
simulated plan: per project and per step schedule, capacity per window and per
week, KPIs, the diff against the live plan and the issues found.

Two greedy runs at most (`run_greedy_sgs`, never CP-SAT): the baseline (merge
mode only) and the import. Both run with `within_year_week =
plan_year_end_week` and `horizon_weeks = plan_year_end_week + 26`, so "within
year" in every outcome means "finishes by the plan year end" and spillover is
still told apart from `LEFT_OUT` (ADR 0044 §7). Weeks are absolute (53 = the
first week of the year after the base year).

Pure and deterministic (I8): no I/O, no clock unless a `deadline_s` is given
(cooperative budget, `WhatIfBudgetExceeded`), no randomness, sorted iteration
throughout; the baseline is never mutated. No financial field is read. Engineer
and chamber *names* are never returned (ids only; the service maps them).

Modelling choices beyond the contract (recorded in docs/MEMORY.md, P32-T02):

* An edit's `duration_weeks = None` keeps the step's current duration (the
  file's weeks for a file project, the stored `user ?? effort` value for a plan
  project): the engine cannot tell a user override from an effort split in the
  merged solver input, and dropping it would silently revert an effort-split
  step to the lead-time table. Its floor and overlap are replaced as given.
* Edits follow the step-timing PATCH rules (ADR 0019 / 0043): a frozen or
  non-schedulable project, a Done step, a skipped step (incl. done before the
  import) given a value, a floor or overlap on an In Progress / Blocked step,
  and an overlap on a workflow's first step are `ValueError`s (HTTP 422).
* Designer rows report `booked_weeks` on the effort basis of the hub load
  (ADR 0028 / I6: a 0.5 FTE designer booked every week reads ~100 %, not
  200 %) and `booked_span_weeks` as the calendar weeks booked.
* A new What-if designer on a capacity hub that serves OEM hubs (R&D-Greece)
  may lead OEM categories too (ADR 0042: Greece's designers serve the OEM hubs).
* Issues are raised for file projects and for plan projects carrying an edit
  (the planner touched them); the live plan's own warnings are not repeated.
"""

from __future__ import annotations

import dataclasses
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction

import domain_constants as dc
from scheduling import hubs as hub_names
from scheduling.greedy import _sort_key, prepare_run, run_greedy_sgs
from scheduling.types import (
    OEM_CATEGORIES,
    PDD_CATEGORIES,
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepProgressInput,
    StepTimingInput,
)
from scheduling.whatif import (
    WhatIfBaseline,
    _booking,
    _Budget,
    _pick_leader,
    _round2,
    _supply,
    classify_outcome,
)
from scheduling.workflow import (
    STATUS_BLOCKED,
    STATUS_DONE,
    STATUS_IN_PROGRESS,
    STATUS_NOT_STARTED,
    ProjectPlan,
    StepPlan,
    Workflow,
    analyse_project,
    build_lead_time_table,
    build_workflows,
    is_step_skipped,
    is_valid_fte,
)

# =====================================================================================
# Constants
# =====================================================================================

#: ADR 0044 §11 caps (`ValueError` beyond them).
MAX_IMPORT_PROJECTS: int = 600
MAX_IMPORT_NEW_ENGINEERS: int = 50
MAX_IMPORT_EDITS: int = 2000

#: ADR 0044 §7: the plan year ends at W52 (base year) or W104 (the year after).
PLAN_YEAR_END_WEEKS: tuple[int, ...] = (52, 104)
#: `horizon_weeks = plan_year_end_week + SPILLOVER_MARGIN_WEEKS`.
SPILLOVER_MARGIN_WEEKS: int = 26
#: Year of weeks 1..52 (labels only; the service serves its own `base_year`).
PLAN_BASE_YEAR: int = 2026
IMPORT_MODES: tuple[str, ...] = ("merge", "file_only")

#: Rows in these statuses start their first remaining step In Progress at
#: CURRENT_WEEK (ADR 0044 §5 "Stage").
IN_PROGRESS_ON_IMPORT: frozenset[str] = frozenset({"In Development", "Under Industrialization"})
#: Every status an imported row may carry; only the schedulable ones are scheduled.
KNOWN_STATUSES: frozenset[str] = frozenset(
    {*dc.SCHEDULABLE_STATUS_ORDER, "Commercialized", "On Hold", "Cancelled", "Draft"}
)

STEP_DURATION_MAX: int = 104

_WEEKS_PER_YEAR = Fraction(dc.WITHIN_YEAR_WEEK)
_YEAR_WEEKS = dc.WITHIN_YEAR_WEEK  # 52


# =====================================================================================
# Inputs (B1, exact)
# =====================================================================================


@dataclass(frozen=True)
class ImportNewEngineer:
    key: str  # "new:<n>"; becomes the EngineerInput.engineer_id
    name: str
    hub: str  # a capacity hub (never OEM-HCK / OEM-Seitek)
    fte: float = 1.0


@dataclass(frozen=True)
class ImportProject:
    key: str  # "row-<file_row>" or "row-<file_row>-<k>" (expanded); unique
    name: str
    hub: str  # one of the 6 hubs
    category: str  # app category (base for ordering / skip rule)
    status: str  # app status; non-schedulable ones are listed, not scheduled
    priority: str  # P1..P4 | Q
    rank: int | None  # file PRIORITY rank; orders within the band (rank, then file_row)
    file_row: int
    leader: str | None  # existing engineer_id, an ImportNewEngineer.key, or None = auto
    current_step_id: str | None  # None = the workflow's first step
    step_weeks: tuple[tuple[str, int], ...]  # (step_id, weeks 0..104); () = app table
    certification_testing_required: bool = True
    replaces_project_id: str | None = None  # baseline project replaced (merge mode)


@dataclass(frozen=True)
class StepEdit:
    project_ref: str  # ImportProject.key or an existing project_id
    step_id: str
    duration_weeks: int | None  # 1..104 or None (keep the current duration)
    start_not_before_week: int | None  # 1..horizon or None
    overlap_weeks: int | None  # 1..104 or None


@dataclass(frozen=True)
class PlanImportRequest:
    projects: tuple[ImportProject, ...]
    new_engineers: tuple[ImportNewEngineer, ...] = ()
    edits: tuple[StepEdit, ...] = ()
    mode: str = "merge"  # "merge" | "file_only"
    plan_year_end_week: int = 104  # 52 or 104


# =====================================================================================
# Results (field names = the HTTP response, B3; ids instead of display names)
# =====================================================================================


@dataclass(frozen=True)
class PlanImportStep:
    step_id: str
    kind: str  # design | lab | elapsed
    sequence_order: int
    start_week: int | None  # None: not placed (excluded / data error / left out before it)
    end_week: int | None
    duration_weeks: int  # effective effort weeks (0 when skipped)
    span_weeks: int  # calendar weeks shown (end - start + 1); 0 when skipped / not placed
    skipped: bool
    done_before_import: bool
    status: str  # Not Started | In Progress | Blocked | Done
    engineer_id: str | None
    chamber_id: str | None
    # The effective timing triple fed to the scheduler (after edits).
    duration_override_weeks: int | None
    start_not_before_week: int | None
    overlap_weeks: int | None  # None when 0
    editable: str  # move_resize | resize | none


@dataclass(frozen=True)
class PlanImportProject:
    ref: str  # ImportProject.key for a file project, the project_id for a plan project
    project_id: str  # the id used in the run ("imp-…" for a file project)
    source: str  # file | plan
    file_row: int | None
    rank: int | None
    replaces_project_id: str | None
    name: str
    hub: str
    capacity_hub: str
    category: str | None
    priority: str | None
    status: str
    frozen: bool
    leader_ref: str | None
    leader_auto_assigned: bool
    outcome: str  # whatif.OUTCOME_CLASSES; within_year = finishes by plan_year_end_week
    within_plan_year: bool
    start_week: int | None
    end_week: int | None
    finish_week: int | None  # projected_end_week (end + delay)
    unconstrained_end_week: int | None
    before_outcome: str | None
    before_finish_week: int | None
    eng_conflict: bool
    lab_overlap: bool
    cat_not_allowed: bool
    no_leader: bool
    no_chamber_step_id: str | None
    data_error: str | None
    steps: tuple[PlanImportStep, ...]  # all 14, sequence order


@dataclass(frozen=True)
class CapacityWindow:
    key: str  # y0 | y1
    label: str
    from_week: int
    to_week: int


@dataclass(frozen=True)
class CapacityWindowFigure:
    key: str
    load_weeks: float
    capacity_weeks: float
    booked_pct: float | None
    status: str  # available | near_full | full (ADR 0016)


@dataclass(frozen=True)
class HubCapacityRow:
    hub: str  # a capacity hub
    fte: float  # Σ FTE of its counted designers
    windows: tuple[CapacityWindowFigure, ...]


@dataclass(frozen=True)
class LabRegionCapacityRow:
    region: str
    chambers: int
    windows: tuple[CapacityWindowFigure, ...]


@dataclass(frozen=True)
class WeeklySeries:
    load: tuple[float, ...]
    capacity: tuple[float, ...]


@dataclass(frozen=True)
class WeeklyCapacity:
    weeks: tuple[int, ...]  # current_week .. plan_year_end_week
    hubs: Mapping[str, WeeklySeries]
    lab_regions: Mapping[str, WeeklySeries]


@dataclass(frozen=True)
class DesignerWindowFigure:
    key: str
    booked_weeks: float  # effort weeks booked in the window (hub-load basis)
    booked_span_weeks: int  # calendar weeks booked in the window
    available_weeks: float
    booked_pct: float | None
    status: str


@dataclass(frozen=True)
class DesignerRow:
    ref: str  # engineer_id or ImportNewEngineer.key
    hub: str
    capacity_hub: str
    fte: float
    is_new: bool
    counts_in_capacity: bool
    windows: tuple[DesignerWindowFigure, ...]


@dataclass(frozen=True)
class PlanImportCapacity:
    windows: tuple[CapacityWindow, ...]
    hubs: tuple[HubCapacityRow, ...]
    lab_regions: tuple[LabRegionCapacityRow, ...]
    weekly: WeeklyCapacity
    designers: tuple[DesignerRow, ...]


@dataclass(frozen=True)
class PlanImportKpis:
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


@dataclass(frozen=True)
class PlanImportChange:
    ref: str
    name: str
    hub: str
    kind: str  # newly_slipping | recovered | moved
    before_outcome: str
    after_outcome: str
    before_finish_week: int | None
    after_finish_week: int | None


@dataclass(frozen=True)
class PlanImportChanges:
    newly_slipping: tuple[PlanImportChange, ...]
    recovered: tuple[PlanImportChange, ...]
    moved: tuple[PlanImportChange, ...]


@dataclass(frozen=True)
class PlanImportIssue:
    ref: str | None
    severity: str  # info | warning | error
    code: str
    message: str


@dataclass(frozen=True)
class PlanImportResult:
    current_week: int
    plan_year_end_week: int
    horizon_weeks: int
    mode: str
    projects: tuple[PlanImportProject, ...]
    capacity: PlanImportCapacity
    kpis: PlanImportKpis
    changes: PlanImportChanges
    issues: tuple[PlanImportIssue, ...]
    workings: tuple[str, ...]
    scheduling_order: tuple[str, ...]  # refs, in the import run's greedy order


# =====================================================================================
# Small helpers
# =====================================================================================


def _cap_hub(hub: str) -> str:
    """ADR 0042: the capacity hub of `hub` under the constants' spelling."""

    return dc.capacity_hub_name(hub_names.constants_hub_name(hub))


def capacity_hubs() -> tuple[str, ...]:
    """The hubs that are their own capacity hub (the capacity rows)."""

    return tuple(sorted(h for h in dc.HUB_LAB_REGION if dc.capacity_hub_name(h) == h))


def _new_engineer_categories(hub: str) -> tuple[str, ...]:
    serves_oem = any(dc.capacity_hub_name(h) == hub for h in sorted(dc.OEM_HUBS))
    return (*PDD_CATEGORIES, "OEM", *OEM_CATEGORIES) if serves_oem else PDD_CATEGORIES


def _workflow_of(hub: str) -> str:
    return "OEM" if hub_names.is_oem_hub(hub) else "PDD"


def _ancestors(wf: Workflow, step_id: str) -> frozenset[str]:
    out: set[str] = set()
    stack = list(wf.steps_by_id[step_id].predecessor_ids)
    while stack:
        sid = stack.pop()
        if sid in out:
            continue
        out.add(sid)
        stack.extend(wf.steps_by_id[sid].predecessor_ids)
    return frozenset(out)


def _overlap_of(row: StepTimingInput | None) -> int:
    return 0 if row is None else row.overlap_weeks


def _timing_row(
    step_id: str, duration: int | None, floor: int | None, overlap: int
) -> StepTimingInput:
    """A `StepTimingInput` with the ADR 0043 overlap (P32-T01); 0 = no overlap."""

    return StepTimingInput(step_id, duration, floor, overlap_weeks=overlap)


@dataclass
class _Triple:
    duration: int | None
    floor: int | None
    overlap: int


def _rows_from_triples(triples: Mapping[str, _Triple]) -> tuple[StepTimingInput, ...]:
    return tuple(
        _timing_row(sid, t.duration, t.floor, t.overlap)
        for sid, t in sorted(triples.items())
        if t.duration is not None or t.floor is not None or t.overlap
    )


def _design_weeks(
    p: ProjectInput,
    workflows: Mapping[str, Workflow],
    table: Mapping[tuple[str, str, str], int],
) -> int:
    """Σ effective design weeks of a schedulable project (leader balancing,
    as `whatif._project_design_weeks`)."""

    if p.status not in dc.SCHEDULABLE_STATUS_ORDER or p.category is None:
        return 0
    wf = workflows.get(p.workflow_id)
    if wf is None or any((p.workflow_id, p.category, s.step_id) not in table for s in wf.steps):
        return 0
    plan = analyse_project(p, wf, table)
    return sum(
        sp.duration for sp in plan.steps.values() if sp.step.kind == "design" and not sp.skipped
    )


# =====================================================================================
# Validation
# =====================================================================================


def validate_plan_import_limits(req: PlanImportRequest) -> None:
    """ADR 0044 §11 caps; `ValueError`. Cheap and independent of the baseline."""

    if len(req.projects) > MAX_IMPORT_PROJECTS:
        raise ValueError(
            f"at most {MAX_IMPORT_PROJECTS} projects can be imported (got {len(req.projects)})"
        )
    if len(req.new_engineers) > MAX_IMPORT_NEW_ENGINEERS:
        raise ValueError(
            f"at most {MAX_IMPORT_NEW_ENGINEERS} new designers can be added "
            f"(got {len(req.new_engineers)})"
        )
    if len(req.edits) > MAX_IMPORT_EDITS:
        raise ValueError(
            f"at most {MAX_IMPORT_EDITS} step edits are allowed (got {len(req.edits)})"
        )


def _validate_request(
    baseline: WhatIfBaseline,
    req: PlanImportRequest,
    workflows: Mapping[str, Workflow],
    lead_pairs: frozenset[tuple[str, str]],
) -> None:
    validate_plan_import_limits(req)
    if req.mode not in IMPORT_MODES:
        raise ValueError(f"mode must be one of {IMPORT_MODES}")
    if req.plan_year_end_week not in PLAN_YEAR_END_WEEKS:
        raise ValueError(f"plan_year_end_week must be one of {PLAN_YEAR_END_WEEKS}")
    si = baseline.schedule
    eng_ids = {e.engineer_id for e in si.engineers}
    new_keys: set[str] = set()
    cap_hubs = set(capacity_hubs())
    for ne in req.new_engineers:
        if not ne.key or ne.key in new_keys or ne.key in eng_ids:
            raise ValueError(f"new designer key {ne.key!r} is empty, duplicated or in use")
        new_keys.add(ne.key)
        if hub_names.constants_hub_name(ne.hub) not in cap_hubs:
            raise ValueError(f"new designer hub {ne.hub!r} is not a capacity hub")
        if not is_valid_fte(ne.fte) or ne.fte > 1.0:
            raise ValueError("new designer fte must be > 0 and <= 1")
    base_ids = {p.project_id for p in si.projects}
    keys: set[str] = set()
    for fp in req.projects:
        if not fp.key or fp.key in keys:
            raise ValueError(f"project key {fp.key!r} is empty or duplicated")
        keys.add(fp.key)
        where = f"row {fp.key!r}"
        if not 1 <= fp.file_row <= 99_999:
            raise ValueError(f"{where}: file_row must be 1..99999")
        if fp.rank is not None and not 1 <= fp.rank <= 9_999:
            raise ValueError(f"{where}: rank must be 1..9999")
        if not hub_names.is_known_hub(fp.hub):
            raise ValueError(f"{where}: unknown hub {fp.hub!r}")
        wf_id = _workflow_of(fp.hub)
        if (wf_id, fp.category) not in lead_pairs:
            raise ValueError(f"{where}: category {fp.category!r} is not valid for workflow {wf_id}")
        if fp.status not in KNOWN_STATUSES:
            raise ValueError(f"{where}: unknown status {fp.status!r}")
        if fp.priority not in dc.PRIORITY_ORDER:
            raise ValueError(f"{where}: unknown priority {fp.priority!r}")
        wf = workflows[wf_id]
        if fp.current_step_id is not None and fp.current_step_id not in wf.steps_by_id:
            raise ValueError(f"{where}: stage {fp.current_step_id!r} is not a step of {wf_id}")
        seen: set[str] = set()
        for sid, weeks in fp.step_weeks:
            if sid not in wf.steps_by_id or sid in seen:
                raise ValueError(f"{where}: step_weeks key {sid!r} unknown or duplicated")
            seen.add(sid)
            if isinstance(weeks, bool) or not isinstance(weeks, int):
                raise ValueError(f"{where}: step_weeks[{sid!r}] must be an integer")
            if not 0 <= weeks <= STEP_DURATION_MAX:
                raise ValueError(f"{where}: step_weeks[{sid!r}] must be 0..{STEP_DURATION_MAX}")
        if fp.leader is not None and fp.leader not in eng_ids and fp.leader not in new_keys:
            raise ValueError(f"{where}: unknown leader reference")
        if (
            req.mode == "merge"
            and fp.replaces_project_id is not None
            and fp.replaces_project_id not in base_ids
        ):
            raise ValueError(f"{where}: replaces an unknown project")
    horizon = req.plan_year_end_week + SPILLOVER_MARGIN_WEEKS
    pairs: set[tuple[str, str]] = set()
    for ed in req.edits:
        pair = (ed.project_ref, ed.step_id)
        if pair in pairs:
            raise ValueError(f"duplicate edit for {ed.project_ref!r} step {ed.step_id!r}")
        pairs.add(pair)
        if ed.duration_weeks is not None and not 1 <= ed.duration_weeks <= STEP_DURATION_MAX:
            raise ValueError(f"edit {ed.step_id!r}: duration_weeks must be 1..{STEP_DURATION_MAX}")
        if ed.start_not_before_week is not None and not 1 <= ed.start_not_before_week <= horizon:
            raise ValueError(f"edit {ed.step_id!r}: start_not_before_week must be 1..{horizon}")
        if ed.overlap_weeks is not None and not 1 <= ed.overlap_weeks <= STEP_DURATION_MAX:
            raise ValueError(f"edit {ed.step_id!r}: overlap_weeks must be 1..{STEP_DURATION_MAX}")


def _apply_edit(
    ref: str,
    ed: StepEdit,
    wf: Workflow,
    triples: dict[str, _Triple],
    *,
    lead: int,
    cert: bool,
    progress_status: str,
    frozen: bool,
    schedulable: bool,
    done_before_import: bool,
) -> None:
    """Mirror of the step-timing PATCH rules (ADR 0019 / 0043) on one edit."""

    where = f"edit {ref!r} step {ed.step_id!r}"
    any_value = (
        ed.duration_weeks is not None
        or ed.start_not_before_week is not None
        or ed.overlap_weeks is not None
    )
    t = triples.setdefault(ed.step_id, _Triple(None, None, 0))
    if frozen:
        raise ValueError(f"{where}: the project is frozen")
    if not schedulable:
        raise ValueError(f"{where}: the project is not scheduled")
    step = wf.steps_by_id[ed.step_id]
    skipped = done_before_import or is_step_skipped(
        lead_weeks=lead,
        kind=step.kind,
        certification_testing_required=cert,
        override_weeks=t.duration,
    )
    if skipped:
        if any_value:
            raise ValueError(f"{where}: the step is skipped (0 weeks) and has no timing")
        return
    if progress_status == STATUS_DONE:
        raise ValueError(f"{where}: the step is Done")
    if progress_status in (STATUS_IN_PROGRESS, STATUS_BLOCKED) and (
        ed.start_not_before_week is not None or ed.overlap_weeks is not None
    ):
        raise ValueError(f"{where}: the step has started; only its duration can change")
    if ed.overlap_weeks is not None and not step.predecessor_ids:
        raise ValueError(f"{where}: the workflow's first step cannot overlap")
    if ed.duration_weeks is not None:
        t.duration = ed.duration_weeks
    t.floor = ed.start_not_before_week
    t.overlap = ed.overlap_weeks or 0


# =====================================================================================
# Building the run
# =====================================================================================


@dataclass(frozen=True)
class _FileMeta:
    fp: ImportProject
    project_id: str
    index: int  # request order
    done_before: frozenset[str]
    not_in_category: tuple[str, ...]
    auto: bool


def _file_project_ids(projects: Sequence[ImportProject]) -> list[str]:
    seen: dict[tuple[int, int], int] = defaultdict(int)
    out: list[str] = []
    for fp in projects:
        rank = fp.rank or 9999
        seen[(rank, fp.file_row)] += 1
        out.append(f"imp-{rank:04d}-{fp.file_row:05d}-{seen[(rank, fp.file_row)]}")
    return out


@dataclass(frozen=True)
class _Built:
    run_si: ScheduleInput
    metas: tuple[_FileMeta, ...]
    auto_assigned: frozenset[str]
    new_eng_ids: frozenset[str]
    edited_plan_ids: frozenset[str]


def build_plan_import_input(baseline: WhatIfBaseline, req: PlanImportRequest) -> ScheduleInput:
    """The `ScheduleInput` the import run schedules (for validators and tests:
    `validate_invariants(build_plan_import_input(b, r), run_greedy_sgs(...))`).
    Same validation as `run_plan_import`."""

    return _build(baseline, req, _Budget(None, None)).run_si


def run_plan_import(
    baseline: WhatIfBaseline,
    req: PlanImportRequest,
    *,
    deadline_s: float | None = None,
    clock: Callable[[], float] | None = None,
) -> PlanImportResult:
    """Simulate the imported plan (ADR 0044). `ValueError` for an invalid
    request (HTTP 422 `INVALID_IMPORT`), `WhatIfBudgetExceeded` when the
    cooperative budget runs out. Pure and deterministic."""

    budget = _Budget(deadline_s, clock)
    built = _build(baseline, req, budget)
    run_si = built.run_si
    si0 = baseline.schedule
    pyew = req.plan_year_end_week

    before: Mapping[str, ProjectScheduleOutcome] = {}
    if req.mode == "merge":
        budget.check()
        base_out = run_greedy_sgs(
            dataclasses.replace(si0, horizon_weeks=run_si.horizon_weeks, within_year_week=pyew)
        )
        before = {o.project_id: o for o in base_out.project_outcomes}
    budget.check()
    out = run_greedy_sgs(run_si)
    budget.check()
    plans = prepare_run(run_si).plans
    budget.check()

    return _assemble(
        baseline=baseline,
        req=req,
        run_si=run_si,
        out=out,
        plans=plans,
        before=before,
        metas=built.metas,
        auto_assigned=set(built.auto_assigned),
        new_eng_ids=set(built.new_eng_ids),
        edited_plan_ids=built.edited_plan_ids,
    )


def _build(baseline: WhatIfBaseline, req: PlanImportRequest, budget: _Budget) -> _Built:
    si0 = baseline.schedule
    workflows = build_workflows(si0.workflow_steps)
    table = build_lead_time_table(si0.lead_times)
    lead_pairs = frozenset((wf, cat) for wf, cat, _ in table)
    _validate_request(baseline, req, workflows, lead_pairs)
    budget.check()

    pyew = req.plan_year_end_week
    horizon = pyew + SPILLOVER_MARGIN_WEEKS
    cw = si0.current_week
    merge = req.mode == "merge"

    # --- engineers -------------------------------------------------------------------
    new_eng_ids = {ne.key for ne in req.new_engineers}
    engineers = sorted(
        [
            *si0.engineers,
            *(
                EngineerInput(
                    engineer_id=ne.key,
                    name=ne.name,
                    hub=hub_names.constants_hub_name(ne.hub),
                    allowed_categories=_new_engineer_categories(
                        hub_names.constants_hub_name(ne.hub)
                    ),
                    fte=ne.fte,
                )
                for ne in req.new_engineers
            ),
        ],
        key=lambda e: e.engineer_id,
    )

    # --- edits by project --------------------------------------------------------------
    edits_by_ref: dict[str, list[StepEdit]] = defaultdict(list)
    for ed in sorted(req.edits, key=lambda e: (e.project_ref, e.step_id)):
        edits_by_ref[ed.project_ref].append(ed)
    file_keys = {fp.key for fp in req.projects}

    # --- plan projects -------------------------------------------------------------------
    replaced = (
        {fp.replaces_project_id for fp in req.projects if fp.replaces_project_id is not None}
        if merge
        else set()
    )
    plan_projects: list[ProjectInput] = []
    if merge:
        for p in sorted(si0.projects, key=lambda p: p.project_id):
            if p.project_id in replaced:
                continue
            eds = edits_by_ref.get(p.project_id, [])
            if eds and p.project_id not in file_keys:
                p = _edit_plan_project(p, eds, workflows, table)
            plan_projects.append(p)
    plan_ids = {p.project_id for p in plan_projects}
    for ref in sorted(edits_by_ref):
        if ref not in file_keys and ref not in plan_ids:
            raise ValueError(f"edit names a project that is not in the simulation: {ref!r}")

    # --- file projects ---------------------------------------------------------------
    ids = _file_project_ids(req.projects)
    metas: list[_FileMeta] = []
    file_inputs: dict[str, ProjectInput] = {}
    for idx, (fp, pid) in enumerate(zip(req.projects, ids, strict=True)):
        budget.check()
        p, meta = _build_file_project(
            fp, pid, idx, workflows, table, edits_by_ref.get(fp.key, []), cw
        )
        file_inputs[pid] = p
        metas.append(meta)

    # --- auto-assign leaders (What-if picker, scheduling order) -----------------------
    load: dict[str, float] = defaultdict(float)
    for p in [*plan_projects, *file_inputs.values()]:
        if p.leader_engineer_id is not None:
            load[p.leader_engineer_id] += _design_weeks(p, workflows, table)
    auto = sorted(
        (file_inputs[m.project_id] for m in metas if m.auto),
        key=_sort_key,
    )
    auto_assigned: set[str] = set()
    for p in auto:
        budget.check()
        leader = _pick_leader(p, engineers, load)
        if leader is None:
            continue
        load[leader.engineer_id] += _design_weeks(p, workflows, table)
        file_inputs[p.project_id] = dataclasses.replace(p, leader_engineer_id=leader.engineer_id)
        auto_assigned.add(p.project_id)

    run_si = dataclasses.replace(
        si0,
        projects=tuple(sorted([*plan_projects, *file_inputs.values()], key=lambda p: p.project_id)),
        engineers=tuple(engineers),
        horizon_weeks=horizon,
        within_year_week=pyew,
    )

    return _Built(
        run_si=run_si,
        metas=tuple(metas),
        auto_assigned=frozenset(auto_assigned),
        new_eng_ids=frozenset(new_eng_ids),
        edited_plan_ids=frozenset(r for r in edits_by_ref if r in plan_ids),
    )


def _edit_plan_project(
    p: ProjectInput,
    eds: Sequence[StepEdit],
    workflows: Mapping[str, Workflow],
    table: Mapping[tuple[str, str, str], int],
) -> ProjectInput:
    wf = workflows.get(p.workflow_id)
    if wf is None or p.category is None:
        raise ValueError(f"edit {p.project_id!r}: the project is not scheduled")
    triples: dict[str, _Triple] = {
        r.step_id: _Triple(r.duration_override_weeks, r.start_not_before_week, _overlap_of(r))
        for r in sorted(p.step_timing, key=lambda r: r.step_id)
    }
    progress = {r.step_id: r.status for r in p.step_progress}
    for ed in eds:
        if ed.step_id not in wf.steps_by_id:
            raise ValueError(f"edit {p.project_id!r}: unknown step {ed.step_id!r}")
        _apply_edit(
            p.project_id,
            ed,
            wf,
            triples,
            lead=table.get((p.workflow_id, p.category, ed.step_id), 0),
            cert=p.certification_testing_required,
            progress_status=progress.get(ed.step_id, STATUS_NOT_STARTED),
            frozen=p.frozen,
            schedulable=p.status in dc.SCHEDULABLE_STATUS_ORDER,
            done_before_import=False,
        )
    return dataclasses.replace(p, step_timing=_rows_from_triples(triples))


def _build_file_project(
    fp: ImportProject,
    pid: str,
    idx: int,
    workflows: Mapping[str, Workflow],
    table: Mapping[tuple[str, str, str], int],
    eds: Sequence[StepEdit],
    cw: int,
) -> tuple[ProjectInput, _FileMeta]:
    wf_id = _workflow_of(fp.hub)
    wf = workflows[wf_id]
    done_before = (
        _ancestors(wf, fp.current_step_id) if fp.current_step_id is not None else frozenset()
    )
    weeks = dict(fp.step_weeks)
    triples: dict[str, _Triple] = {}
    not_in_cat: list[str] = []
    for step in wf.steps:
        sid = step.step_id
        lead = table[(wf_id, fp.category, sid)]
        if sid in done_before:
            triples[sid] = _Triple(0, None, 0)
            continue
        if sid in weeks:
            triples[sid] = _Triple(weeks[sid], None, 0)
            if weeks[sid] > 0 and lead == 0:
                not_in_cat.append(sid)

    def skipped(sid: str) -> bool:
        t = triples.get(sid)
        return sid in done_before or is_step_skipped(
            lead_weeks=table[(wf_id, fp.category, sid)],
            kind=wf.steps_by_id[sid].kind,
            certification_testing_required=fp.certification_testing_required,
            override_weeks=None if t is None else t.duration,
        )

    schedulable = fp.status in dc.SCHEDULABLE_STATUS_ORDER
    in_progress: str | None = None
    if schedulable and fp.status in IN_PROGRESS_ON_IMPORT:
        in_progress = next((s for s in wf.walk_order if not skipped(s)), None)

    for ed in eds:
        if ed.step_id not in wf.steps_by_id:
            raise ValueError(f"edit {fp.key!r}: unknown step {ed.step_id!r}")
        _apply_edit(
            fp.key,
            ed,
            wf,
            triples,
            lead=table[(wf_id, fp.category, ed.step_id)],
            cert=fp.certification_testing_required,
            progress_status=STATUS_IN_PROGRESS if ed.step_id == in_progress else STATUS_NOT_STARTED,
            frozen=False,
            schedulable=schedulable,
            done_before_import=ed.step_id in done_before,
        )

    progress: tuple[StepProgressInput, ...] = ()
    if in_progress is not None:
        progress = (StepProgressInput(in_progress, STATUS_IN_PROGRESS, 0, cw, None, None),)

    p = ProjectInput(
        project_id=pid,
        name=fp.name,
        hub=fp.hub,
        status=fp.status,
        category=fp.category,
        priority=fp.priority,
        frozen=False,
        leader_engineer_id=fp.leader,
        actual_start_week=None,
        workflow_id=wf_id,
        certification_testing_required=fp.certification_testing_required,
        step_progress=progress,
        step_timing=_rows_from_triples(triples),
        capacity_hub=_cap_hub(fp.hub),
    )
    meta = _FileMeta(
        fp=fp,
        project_id=pid,
        index=idx,
        done_before=done_before,
        not_in_category=tuple(not_in_cat),
        auto=fp.leader is None and schedulable,
    )
    return p, meta


# =====================================================================================
# Assembling the result
# =====================================================================================


def _booked_weeks(
    st_start: int, st_end: int, sp: StepPlan, frozen: bool, cw: int
) -> tuple[range, Fraction]:
    """(weeks the step books from CURRENT_WEEK on, effort per booked week).

    Not Started / Done / frozen: `[max(start, cw), end]`, effort `duration /
    (end - start + 1)` (`duration / span` for a placed design step, so Σ over
    the full span = duration). In Progress / Blocked tails: the last
    `remaining_span` weeks, effort `remaining / remaining_span`."""

    if not frozen and sp.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
        if sp.remaining_span <= 0:
            return range(0), Fraction(0)
        return (
            range(max(st_end - sp.remaining_span + 1, cw), st_end + 1),
            Fraction(sp.remaining, sp.remaining_span),
        )
    length = st_end - st_start + 1
    if length <= 0:
        return range(0), Fraction(0)
    return range(max(st_start, cw), st_end + 1), Fraction(sp.duration, length)


def _windows(cw: int, pyew: int) -> tuple[CapacityWindow, ...]:
    out = [
        CapacityWindow(
            "y0",
            f"{PLAN_BASE_YEAR} W{cw}–W{min(_YEAR_WEEKS, pyew)}",
            cw,
            min(_YEAR_WEEKS, pyew),
        )
    ]
    if pyew == 2 * _YEAR_WEEKS:
        out.append(CapacityWindow("y1", f"{PLAN_BASE_YEAR + 1}", _YEAR_WEEKS + 1, pyew))
    return tuple(out)


def _figure(key: str, load: Fraction, cap: Fraction) -> CapacityWindowFigure:
    lf, cf = float(load), float(cap)
    pct, status = _booking(lf, cf)
    return CapacityWindowFigure(key, _round2(lf), _round2(cf), pct, status)


def _capacity(
    baseline: WhatIfBaseline,
    si: ScheduleInput,
    out: ScheduleOutput,
    plans: Mapping[str, ProjectPlan],
    new_eng_ids: frozenset[str] | set[str],
    pyew: int,
) -> PlanImportCapacity:
    cw = si.current_week
    weeks = tuple(range(cw, pyew + 1))
    first = cw
    n = len(weeks)
    windows = _windows(cw, pyew)
    proj = {p.project_id: p for p in si.projects}

    cap_hubs = capacity_hubs()
    regions = tuple(sorted(set(dc.HUB_LAB_REGION.values())))
    d_load: dict[str, list[Fraction]] = {h: [Fraction(0)] * n for h in cap_hubs}
    l_load: dict[str, list[Fraction]] = {r: [Fraction(0)] * n for r in regions}
    e_effort: dict[str, list[Fraction]] = defaultdict(lambda: [Fraction(0)] * n)
    e_span: dict[str, list[int]] = defaultdict(lambda: [0] * n)

    for o in out.project_outcomes:
        p = proj[o.project_id]
        plan = plans.get(o.project_id)
        if plan is None or o.excluded or o.data_error is not None:
            continue
        chub = _cap_hub(p.capacity_hub)
        region = hub_names.HUB_LAB_REGION.get(p.hub)
        for st in o.steps:
            if st.skipped or st.step_id in plan.held_step_ids:
                continue
            sp = plan.steps[st.step_id]
            if st.kind not in ("design", "lab"):
                continue
            wk_range, per = _booked_weeks(st.start_week, st.end_week, sp, p.frozen, cw)
            if st.kind == "lab":
                per = Fraction(dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK)
            for wk in wk_range:
                if not first <= wk <= pyew:
                    continue
                i = wk - first
                if st.kind == "design":
                    if chub in d_load:
                        d_load[chub][i] += per
                    if st.assigned_engineer_id is not None:
                        e_effort[st.assigned_engineer_id][i] += per
                        e_span[st.assigned_engineer_id][i] += 1
                elif region is not None:
                    l_load[region][i] += per

    sup = _supply(si.engineers, si.chambers, baseline.calendars, baseline.chamber_supply, cw)
    fte_by_cap: dict[str, Fraction] = defaultdict(Fraction)
    for e in si.engineers:
        if e.counts_in_capacity:
            fte_by_cap[_cap_hub(e.hub)] += Fraction(e.fte)
    wwpe = {h: Fraction(sup.wwpe_by_hub.get(h, float(_YEAR_WEEKS))) for h in dc.HUB_LAB_REGION}

    def win_idx(w: CapacityWindow) -> range:
        return range(w.from_week - first, w.to_week - first + 1)

    hub_rows: list[HubCapacityRow] = []
    weekly_hubs: dict[str, WeeklySeries] = {}
    for h in cap_hubs:
        per_week = fte_by_cap.get(h, Fraction(0)) * wwpe[h] / _WEEKS_PER_YEAR
        figs = tuple(
            _figure(
                w.key,
                sum((d_load[h][i] for i in win_idx(w)), Fraction(0)),
                per_week * len(win_idx(w)),
            )
            for w in windows
        )
        hub_rows.append(HubCapacityRow(h, _round2(float(fte_by_cap.get(h, 0))), figs))
        weekly_hubs[h] = WeeklySeries(
            tuple(_round2(float(x)) for x in d_load[h]), tuple([_round2(float(per_week))] * n)
        )

    lab_rows: list[LabRegionCapacityRow] = []
    weekly_labs: dict[str, WeeklySeries] = {}
    for r in regions:
        per_week = Fraction(sup.lab_year_by_region.get(r, 0.0)) / _WEEKS_PER_YEAR
        figs = tuple(
            _figure(
                w.key,
                sum((l_load[r][i] for i in win_idx(w)), Fraction(0)),
                per_week * len(win_idx(w)),
            )
            for w in windows
        )
        lab_rows.append(LabRegionCapacityRow(r, int(sup.chambers_by_region.get(r, 0)), figs))
        weekly_labs[r] = WeeklySeries(
            tuple(_round2(float(x)) for x in l_load[r]), tuple([_round2(float(per_week))] * n)
        )

    designers: list[DesignerRow] = []
    for e in si.engineers:
        if e.engineer_id not in e_span and not e.counts_in_capacity:
            continue
        chub = _cap_hub(e.hub)
        per_avail = Fraction(e.fte) * wwpe.get(chub, Fraction(_YEAR_WEEKS)) / _WEEKS_PER_YEAR
        eff = e_effort.get(e.engineer_id, [Fraction(0)] * n)
        spn = e_span.get(e.engineer_id, [0] * n)
        dfigs: list[DesignerWindowFigure] = []
        for w in windows:
            idx = win_idx(w)
            booked = sum((eff[i] for i in idx), Fraction(0))
            avail = per_avail * len(idx)
            pct, status = _booking(float(booked), float(avail))
            dfigs.append(
                DesignerWindowFigure(
                    w.key,
                    _round2(float(booked)),
                    sum(spn[i] for i in idx),
                    _round2(float(avail)),
                    pct,
                    status,
                )
            )
        designers.append(
            DesignerRow(
                ref=e.engineer_id,
                hub=e.hub,
                capacity_hub=chub,
                fte=e.fte,
                is_new=e.engineer_id in new_eng_ids,
                counts_in_capacity=e.counts_in_capacity,
                windows=tuple(dfigs),
            )
        )

    return PlanImportCapacity(
        windows=windows,
        hubs=tuple(hub_rows),
        lab_regions=tuple(lab_rows),
        weekly=WeeklyCapacity(weeks=weeks, hubs=weekly_hubs, lab_regions=weekly_labs),
        designers=tuple(designers),
    )


def _steps(
    p: ProjectInput,
    o: ProjectScheduleOutcome,
    plan: ProjectPlan | None,
    wf: Workflow,
    done_before: frozenset[str],
) -> tuple[PlanImportStep, ...]:
    rows = {r.step_id: r for r in o.steps}
    timing = {r.step_id: r for r in sorted(p.step_timing, key=lambda r: r.step_id)}
    progress = {r.step_id: r.status for r in p.step_progress}
    project_editable = (
        p.status in dc.SCHEDULABLE_STATUS_ORDER
        and not p.frozen
        and not o.excluded
        and o.data_error is None
    )
    out: list[PlanImportStep] = []
    for step in wf.steps:
        sid = step.step_id
        sp = plan.steps.get(sid) if plan is not None else None
        row = rows.get(sid)
        t = timing.get(sid)
        dbi = sid in done_before
        skipped = row.skipped if row is not None else (sp.skipped if sp is not None else dbi)
        if dbi:
            status = STATUS_DONE
        elif p.frozen:
            status = STATUS_NOT_STARTED
        else:
            status = progress.get(sid, STATUS_NOT_STARTED)
        if not project_editable or skipped or dbi or status == STATUS_DONE:
            editable = "none"
        elif status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
            editable = "resize"
        else:
            editable = "move_resize"
        if row is not None:
            duration = row.duration_weeks
            span = 0 if row.skipped else row.end_week - row.start_week + 1
        else:
            duration = 0 if skipped or sp is None else sp.duration
            span = 0
        ov = _overlap_of(t)
        out.append(
            PlanImportStep(
                step_id=sid,
                kind=step.kind,
                sequence_order=step.sequence_order,
                start_week=None if row is None else row.start_week,
                end_week=None if row is None else row.end_week,
                duration_weeks=duration,
                span_weeks=span,
                skipped=skipped,
                done_before_import=dbi,
                status=status,
                engineer_id=None if row is None else row.assigned_engineer_id,
                chamber_id=None if row is None else row.assigned_chamber_id,
                duration_override_weeks=None if t is None else t.duration_override_weeks,
                start_not_before_week=None if t is None else t.start_not_before_week,
                overlap_weeks=ov or None,
                editable=editable,
            )
        )
    return tuple(out)


def _project_row(
    *,
    p: ProjectInput,
    o: ProjectScheduleOutcome,
    plan: ProjectPlan | None,
    wf: Workflow,
    ref: str,
    source: str,
    meta: _FileMeta | None,
    auto: bool,
    before: ProjectScheduleOutcome | None,
) -> PlanImportProject:
    return PlanImportProject(
        ref=ref,
        project_id=p.project_id,
        source=source,
        file_row=None if meta is None else meta.fp.file_row,
        rank=None if meta is None else meta.fp.rank,
        replaces_project_id=None if meta is None else meta.fp.replaces_project_id,
        name=p.name,
        hub=p.hub,
        capacity_hub=p.capacity_hub,
        category=p.category,
        priority=p.priority,
        status=p.status,
        frozen=p.frozen,
        leader_ref=p.leader_engineer_id,
        leader_auto_assigned=auto,
        outcome=classify_outcome(o),
        within_plan_year=bool(o.within_year) and classify_outcome(o) == "within_year",
        start_week=o.start_week,
        end_week=o.end_week,
        finish_week=o.projected_end_week,
        unconstrained_end_week=o.unconstrained_end_week,
        before_outcome=None if before is None else classify_outcome(before),
        before_finish_week=None if before is None else before.projected_end_week,
        eng_conflict=o.eng_conflict,
        lab_overlap=o.overlap,
        cat_not_allowed=o.cat_not_allowed,
        no_leader=o.no_leader,
        no_chamber_step_id=o.no_chamber_step_id,
        data_error=o.data_error,
        steps=_steps(p, o, plan, wf, frozenset() if meta is None else meta.done_before),
    )


def _project_issues(
    row: PlanImportProject, meta: _FileMeta | None, pyew: int
) -> list[PlanImportIssue]:
    ref = row.ref
    out: list[PlanImportIssue] = []
    if row.leader_auto_assigned:
        out.append(
            PlanImportIssue(
                ref,
                "warning",
                "LEADER_AUTO_ASSIGNED",
                f"No engineer given: auto-assigned the {row.capacity_hub} designer with the "
                "least led design work. Replace if needed.",
            )
        )
    if meta is not None:
        for sid in meta.not_in_category:
            out.append(
                PlanImportIssue(
                    ref,
                    "warning",
                    "STEP_NOT_IN_CATEGORY",
                    f"The file gives weeks for {sid}, but the step is not part of category "
                    f"{row.category}; it stays skipped.",
                )
            )
    if row.outcome == "data_error":
        out.append(
            PlanImportIssue(ref, "error", "DATA_ERROR", "The project could not be scheduled.")
        )
    if row.outcome == "left_out":
        if row.no_leader:
            why = "no designer leads it"
        elif row.no_chamber_step_id is not None:
            why = f"no chamber can host step {row.no_chamber_step_id}"
        else:
            why = f"no free window before week {pyew + SPILLOVER_MARGIN_WEEKS}"
        out.append(PlanImportIssue(ref, "warning", "LEFT_OUT", f"Left out: {why}."))
    if row.eng_conflict:
        out.append(
            PlanImportIssue(
                ref,
                "warning",
                "ENG_CONFLICT",
                "Its designer is double-booked by work already in progress.",
            )
        )
    if row.lab_overlap:
        out.append(
            PlanImportIssue(
                ref, "warning", "LAB_OVERLAP", "A lab chamber is over capacity for this project."
            )
        )
    if row.cat_not_allowed:
        out.append(
            PlanImportIssue(
                ref,
                "warning",
                "CAT_NOT_ALLOWED",
                f"The designer is not listed for category {row.category}.",
            )
        )
    if (
        row.outcome not in ("excluded", "data_error")
        and row.unconstrained_end_week is not None
        and row.unconstrained_end_week > pyew
    ):
        out.append(
            PlanImportIssue(
                ref,
                "warning",
                "UNREACHABLE_IN_YEAR",
                f"Even with unlimited capacity it ends in week {row.unconstrained_end_week}, "
                f"after the plan year (week {pyew}).",
            )
        )
    return out


def _assemble(
    *,
    baseline: WhatIfBaseline,
    req: PlanImportRequest,
    run_si: ScheduleInput,
    out: ScheduleOutput,
    plans: Mapping[str, ProjectPlan],
    before: Mapping[str, ProjectScheduleOutcome],
    metas: Sequence[_FileMeta],
    auto_assigned: set[str],
    new_eng_ids: set[str],
    edited_plan_ids: frozenset[str],
) -> PlanImportResult:
    pyew = req.plan_year_end_week
    merge = req.mode == "merge"
    workflows = build_workflows(run_si.workflow_steps)
    proj = {p.project_id: p for p in run_si.projects}
    by_id = {o.project_id: o for o in out.project_outcomes}
    meta_by_pid = {m.project_id: m for m in metas}
    ref_of = {pid: (m.fp.key if (m := meta_by_pid.get(pid)) else pid) for pid in proj}

    file_rows: list[PlanImportProject] = []
    issues: list[PlanImportIssue] = []
    for m in sorted(metas, key=lambda m: (m.fp.file_row, m.index)):
        p = proj[m.project_id]
        b = before.get(m.fp.replaces_project_id) if m.fp.replaces_project_id else None
        row = _project_row(
            p=p,
            o=by_id[m.project_id],
            plan=plans.get(m.project_id),
            wf=workflows[p.workflow_id],
            ref=m.fp.key,
            source="file",
            meta=m,
            auto=m.project_id in auto_assigned,
            before=b,
        )
        file_rows.append(row)
        if m.fp.leader is not None and m.fp.leader in new_eng_ids:
            issues.append(
                PlanImportIssue(
                    m.fp.key,
                    "info",
                    "NEW_DESIGNER",
                    "Led by a new What-if designer (not on the roster).",
                )
            )
        issues.extend(_project_issues(row, m, pyew))

    plan_rows: list[PlanImportProject] = []
    for pid in sorted(proj):
        if pid in meta_by_pid:
            continue
        p = proj[pid]
        o = by_id[pid]
        if o.excluded:
            continue
        row = _project_row(
            p=p,
            o=o,
            plan=plans.get(pid),
            wf=workflows[p.workflow_id],
            ref=pid,
            source="plan",
            meta=None,
            auto=False,
            before=before.get(pid),
        )
        plan_rows.append(row)
    plan_rows.sort(key=lambda r: (r.finish_week is None, r.finish_week or 0, r.name, r.project_id))
    for row in plan_rows:
        if row.project_id in edited_plan_ids:
            issues.extend(_project_issues(row, None, pyew))

    # --- changes ------------------------------------------------------------------------
    slipping: list[PlanImportChange] = []
    recovered: list[PlanImportChange] = []
    moved: list[PlanImportChange] = []
    existing = [pid for pid in sorted(proj) if pid not in meta_by_pid]
    if merge:
        for pid in existing:
            o, b = by_id[pid], before.get(pid)
            if b is None:
                continue
            if (
                b.projected_end_week == o.projected_end_week
                and b.within_year == o.within_year
                and b.left_out == o.left_out
                and b.blocked == o.blocked
                and b.excluded == o.excluded
            ):
                continue
            kind = "moved"
            if b.within_year and not o.within_year:
                kind = "newly_slipping"
            elif o.within_year and not b.within_year:
                kind = "recovered"
            ch = PlanImportChange(
                ref=pid,
                name=proj[pid].name,
                hub=proj[pid].hub,
                kind=kind,
                before_outcome=classify_outcome(b),
                after_outcome=classify_outcome(o),
                before_finish_week=b.projected_end_week,
                after_finish_week=o.projected_end_week,
            )
            {"newly_slipping": slipping, "recovered": recovered, "moved": moved}[kind].append(ch)

    # --- KPIs ---------------------------------------------------------------------------
    counts = {
        k: 0 for k in ("within_year", "spillover", "left_out", "blocked", "excluded", "data_error")
    }
    for o in out.project_outcomes:
        counts[classify_outcome(o)] += 1
    file_pids = [m.project_id for m in metas]
    kpis = PlanImportKpis(
        projects_total=len(out.project_outcomes),
        file_projects=len(file_pids),
        plan_projects=len(existing),
        within_plan_year=counts["within_year"],
        spillover=counts["spillover"],
        left_out=counts["left_out"],
        blocked=counts["blocked"],
        excluded=counts["excluded"],
        data_error=counts["data_error"],
        file_within_plan_year=sum(
            1 for pid in file_pids if classify_outcome(by_id[pid]) == "within_year"
        ),
        file_scheduled=sum(1 for pid in file_pids if not by_id[pid].excluded),
        before_within_plan_year=(
            sum(
                1
                for pid in existing
                if (b := before.get(pid)) is not None and classify_outcome(b) == "within_year"
            )
            if merge
            else None
        ),
        after_within_plan_year_existing=(
            sum(1 for pid in existing if classify_outcome(by_id[pid]) == "within_year")
            if merge
            else None
        ),
        newly_slipping=len(slipping),
        recovered=len(recovered),
    )

    capacity = _capacity(baseline, run_si, out, plans, new_eng_ids, pyew)

    n_auto = len(auto_assigned)
    workings = (
        f"Mode {req.mode}: {kpis.file_projects} file project(s)"
        + (
            f" merged with {kpis.plan_projects} plan project(s), "
            f"{len({m.fp.replaces_project_id for m in metas if m.fp.replaces_project_id})} "
            "replaced by a file row."
            if merge
            else " scheduled alone on the live designers and chambers."
        ),
        f"Plan year ends week {pyew}; search horizon week {pyew + SPILLOVER_MARGIN_WEEKS}; "
        f"today is week {run_si.current_week}.",
        f"Greedy SGS: {len(run_si.projects)} project(s), {len(run_si.engineers)} designer(s) "
        f"({len(new_eng_ids)} new), {len(run_si.chambers)} chamber(s); "
        f"{n_auto} leader(s) auto-assigned.",
        f"Finishing within the plan year: {kpis.within_plan_year} "
        f"(file {kpis.file_within_plan_year} of {kpis.file_scheduled} scheduled)"
        + (
            f"; existing {kpis.before_within_plan_year} -> {kpis.after_within_plan_year_existing}."
            if merge
            else "."
        ),
    )

    return PlanImportResult(
        current_week=run_si.current_week,
        plan_year_end_week=pyew,
        horizon_weeks=pyew + SPILLOVER_MARGIN_WEEKS,
        mode=req.mode,
        projects=tuple(file_rows + plan_rows),
        capacity=capacity,
        kpis=kpis,
        changes=PlanImportChanges(tuple(slipping), tuple(recovered), tuple(moved)),
        issues=tuple(issues),
        workings=workings,
        scheduling_order=tuple(ref_of[pid] for pid in out.scheduling_order),
    )


__all__ = (
    "MAX_IMPORT_EDITS",
    "MAX_IMPORT_NEW_ENGINEERS",
    "MAX_IMPORT_PROJECTS",
    "PLAN_YEAR_END_WEEKS",
    "SPILLOVER_MARGIN_WEEKS",
    "CapacityWindow",
    "CapacityWindowFigure",
    "DesignerRow",
    "DesignerWindowFigure",
    "HubCapacityRow",
    "ImportNewEngineer",
    "ImportProject",
    "LabRegionCapacityRow",
    "PlanImportCapacity",
    "PlanImportChange",
    "PlanImportChanges",
    "PlanImportIssue",
    "PlanImportKpis",
    "PlanImportProject",
    "PlanImportRequest",
    "PlanImportResult",
    "PlanImportStep",
    "StepEdit",
    "WeeklyCapacity",
    "WeeklySeries",
    "build_plan_import_input",
    "capacity_hubs",
    "run_plan_import",
    "validate_plan_import_limits",
)
