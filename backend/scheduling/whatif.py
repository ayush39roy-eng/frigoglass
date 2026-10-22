"""What-if planning engine (P18-T01, ADR 0031, docs/API_CONTRACT_P18.md).

Answers "what if we add these projects / designers / chambers?" in two ways:

* `analytic_requirements` is the instant formula path. It uses the DOMAIN_RULES
  "Capacity supply" and "Lead times" formulas to say how many design-weeks and
  lab-weeks the added projects need, what that does to booked % per hub and per
  lab region (ADR 0016 thresholds), and the smallest number of extra designers
  and chambers that keeps booked % below `BOOKING_FULL_PCT`. No scheduling.
* `simulate` runs the REAL greedy SGS (`scheduling.greedy.run_greedy_sgs`, the
  scheduler the priority-move preview uses) on a copy of the baseline input with
  the scenario applied, and diffs it against the greedy run of the untouched
  baseline. `solve_minimum_additions` searches the smallest additions that meet
  a target by repeated simulation, with a hard cap on greedy runs.

Pure and deterministic (I8): no I/O, no clock, no randomness, no DB, no LLM,
and never CP-SAT. Sorted iteration everywhere; the baseline is never mutated
(every dataclass is frozen and the baseline `ScheduleInput` is only read).
No financial field, customer name or engineer name is read or returned.
Hypothetical engineers are labelled "What-if designer N".

Modelling choices (each is an assumption recorded in docs/OPEN_QUESTIONS.md #43-#47):

* Scheduling takes a leader per project, so a hypothetical project is given one
  deterministically: the eligible engineer of its *capacity* hub (ADR 0042,
  P29: R&D-Greece for an OEM-hub project; `ProjectInput.capacity_hub`) with the
  smallest led design-weeks per FTE (ties by engineer id). Added engineers
  start at zero, so they absorb new projects. Existing projects keep their
  leaders, except the projects of a removed engineer, which are re-assigned
  the same way. Design-side figures (hub rows, designer search dimensions,
  touched hubs) are per capacity hub, so an OEM project's design weeks land on
  Greece's row and designers for it are added to R&D-Greece; lab figures stay
  per the hub's lab region (Greece either way).
* Counted designers (ADR 0042 §5–6, P29-T05): design supply (`_supply`, hence
  every booked %, capacity, FTE column and the minimum-additions search) sums
  only engineers with `counts_in_capacity`. A non-counted engineer stays the
  leader of the projects they already lead and is booked for them, but is never
  picked for a new or re-assigned project, never removed by a
  `RemoveEngineerCount` (which removes counted designers, so supply always
  drops by what was removed; an explicit `remove_engineers` id still works),
  and does not set the fastest-designer speed of the unattainable-project
  test. Hypothetical (`AddEngineer`) designers always count.
* Chamber downtime never gates booking (DOMAIN_RULES "Capacity supply"), so a
  downtime change moves supply and booked % only; the greedy placement is the
  same as the baseline's.
* A hypothetical project defaults to priority P3 and status "In Queue".
* Booked % uses the served rule: 2-dp rounded load / capacity, status from
  `BOOKING_NEAR_FULL_PCT` / `BOOKING_FULL_PCT`. "Below BOOKING_FULL_PCT" means
  the status is not `full` (strictly less than 100 %).
"""

from __future__ import annotations

import dataclasses
import math
import time
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

import domain_constants as dc
from scheduling import hubs as hub_names
from scheduling.greedy import _cat_not_allowed, run_greedy_sgs
from scheduling.invariants import compute_design_load_by_capacity_hub
from scheduling.types import (
    OEM_CATEGORIES,
    PDD_CATEGORIES,
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
)
from scheduling.workflow import (
    analyse_project,
    build_lead_time_table,
    build_workflows,
    is_valid_fte,
    unconstrained_end_week,
)

#: The most greedy runs one `solve_minimum_additions` call may spend (baseline
#: run and zero-addition run included). A caller may ask for fewer, never more.
HARD_MAX_RUNS: int = 60
#: Upper bound on `count` for added projects / engineers / chambers in one entry.
MAX_COUNT: int = 500
#: Priority given to an added project that sets neither `priority` nor `score`.
DEFAULT_ADDED_PRIORITY: str = "P3"
#: Engine-level cost caps on ONE scenario (S18-M1). Sums over all lines of the
#: scenario; exceeding any raises `ValueError` (HTTP 422). The API request
#: models and the frontend schema mirror these numbers.
MAX_ADDED_PROJECTS_TOTAL: int = 200
MAX_ADDED_DESIGNERS_TOTAL: int = 50
MAX_REMOVED_DESIGNERS_TOTAL: int = 50
MAX_ADDED_CHAMBERS_TOTAL: int = 20


class WhatIfBudgetExceeded(Exception):
    """The cooperative time budget (`deadline_s`) ran out. Raised by
    `simulate`, `analytic_requirements` and `solve_minimum_additions` between
    greedy runs and inside the scenario-building loops, so a worker thread
    stops itself instead of running on after the caller gave up (S18-M1)."""


class _Budget:
    """Cooperative deadline. `deadline_s` seconds from construction, read from
    `clock` (default `time.monotonic`; inject a fake in tests). With no
    deadline `check` is a no-op and the engine never reads a clock."""

    def __init__(self, deadline_s: float | None, clock: Callable[[], float] | None) -> None:
        self._clock = clock if clock is not None else time.monotonic
        self._end: float | None = None
        if deadline_s is not None:
            if not deadline_s > 0:
                raise ValueError("deadline_s must be > 0")
            self._end = self._clock() + float(deadline_s)

    def check(self) -> None:
        if self._end is not None and self._clock() >= self._end:
            raise WhatIfBudgetExceeded("what-if time budget exceeded")


_NO_BUDGET = _Budget(None, None)

Target = Literal["all_new_within_year", "no_existing_slips"]
Basis = Literal["year", "remaining"]
TARGETS: tuple[str, ...] = ("all_new_within_year", "no_existing_slips")

OUTCOME_CLASSES: tuple[str, ...] = (
    "within_year",
    "spillover",
    "left_out",
    "blocked",
    "excluded",
    "data_error",
)

_ALL_HUBS: tuple[str, ...] = tuple(sorted(dc.HUB_LAB_REGION))
_ALL_REGIONS: tuple[str, ...] = tuple(sorted(set(dc.HUB_LAB_REGION.values())))


# =====================================================================================
# Inputs
# =====================================================================================


@dataclass(frozen=True)
class HubCalendarInput:
    """`HubWorkCalendar` as plain data (DOMAIN_RULES "Capacity supply")."""

    hub: str
    weekdays_per_week: int = 5
    national_holiday_days: float = 0.0
    medical_leave_days: float = 0.0
    casual_leave_days: float = 0.0
    annual_leave_days: float = 0.0
    weeks_in_year: int = 52


@dataclass(frozen=True)
class ChamberSupplyInput:
    """The supply-side fields of one chamber. A chamber without a row here is
    treated as `platforms = max_concurrent`, its own `efficiency`, zero downtime."""

    chamber_id: str
    lab_region: str
    platforms: int
    efficiency: float = 1.0
    maintenance_weeks: float = 0.0
    breakdown_weeks: float = 0.0
    calibration_weeks: float = 0.0


@dataclass(frozen=True)
class WhatIfBaseline:
    """The current plan: the scheduler input plus the supply inputs the
    scheduler itself does not need (calendars, chamber downtime).
    `schedule.current_week` fixes the "remaining" capacity basis."""

    schedule: ScheduleInput
    calendars: tuple[HubCalendarInput, ...] = ()
    chamber_supply: tuple[ChamberSupplyInput, ...] = ()


@dataclass(frozen=True)
class AddProject:
    """`count` identical hypothetical projects in `hub`.

    `workflow_id` is optional and, if given, must be the hub's workflow (a
    project's workflow is a function of its hub). `priority` wins over `score`
    (a normalised 0..100 score mapped with the DOMAIN_RULES bands).
    `project_type` is a display label only; it never affects scheduling.

    `capacity_hub` (ADR 0042): the hub whose designers lead the new projects
    and whose supply their design load counts against. `None` (the default)
    takes the capacity hub the baseline's projects on `hub` already carry
    (so an `OEM-HCK` project resolves to `R&D-Greece` once the baseline does),
    else `hub` itself.
    """

    hub: str
    category: str
    count: int = 1
    project_type: str | None = None
    status: str = "In Queue"
    priority: str | None = None
    score: float | None = None
    workflow_id: str | None = None
    certification_testing_required: bool = True
    capacity_hub: str | None = None


@dataclass(frozen=True)
class AddEngineer:
    """`count` hypothetical designers in `hub`. Their FTE feeds supply and gates
    speed: a design step they lead books `ceil(duration / fte)` weeks (ADR
    0032). `allowed_categories` defaults to every category of the hub's
    workflow. They always count in capacity (`counts_in_capacity=True`)."""

    hub: str
    fte: float = 1.0
    count: int = 1
    allowed_categories: tuple[str, ...] | None = None


@dataclass(frozen=True)
class RemoveEngineerCount:
    """Remove `count` engineers from `hub`: the ones leading the least design
    work first (ties by engineer id), to disturb the plan least. Only counted
    designers (`counts_in_capacity`, ADR 0042) are candidates, so the hub's
    supply always drops by the removed designers' FTE."""

    hub: str
    count: int = 1


@dataclass(frozen=True)
class AddChamber:
    """`count` hypothetical chambers in `lab_region`. Every field left `None`
    takes the region's existing norm (see `chamber_norm`)."""

    lab_region: str
    count: int = 1
    platforms: int | None = None
    efficiency: float | None = None
    maintenance_weeks: float | None = None
    breakdown_weeks: float | None = None
    calibration_weeks: float | None = None
    allowed_stages: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ChamberDowntimeChange:
    """Replace the downtime weeks of an existing chamber (`None` = keep)."""

    chamber_id: str
    maintenance_weeks: float | None = None
    breakdown_weeks: float | None = None
    calibration_weeks: float | None = None


@dataclass(frozen=True)
class Scenario:
    """A what-if change set. The plan-year horizon is never changed."""

    add_projects: tuple[AddProject, ...] = ()
    add_engineers: tuple[AddEngineer, ...] = ()
    remove_engineers: tuple[str, ...] = ()  # engineer ids
    remove_engineer_counts: tuple[RemoveEngineerCount, ...] = ()
    add_chambers: tuple[AddChamber, ...] = ()
    chamber_downtime: tuple[ChamberDowntimeChange, ...] = ()
    priority_overrides: tuple[tuple[str, str], ...] = ()  # (project_id, priority)

    def is_empty(self) -> bool:
        return not (
            self.add_projects
            or self.add_engineers
            or self.remove_engineers
            or self.remove_engineer_counts
            or self.add_chambers
            or self.chamber_downtime
            or self.priority_overrides
        )


# =====================================================================================
# Small pure helpers: supply and booked %
# =====================================================================================


def _round2(value: float) -> float:
    return round(value, 2) + 0.0


def booked_pct(load: float, capacity: float) -> float | None:
    """ADR 0016: `load / capacity x 100` to 2 dp, `None` when capacity is 0."""

    if capacity == 0:
        return None
    return _round2(load / capacity * 100)


def booking_status(load: float, capacity: float, pct: float | None) -> str:
    """`full` / `near_full` / `available` (ADR 0016 section 2)."""

    if pct is None:
        return "full" if capacity == 0 and load > 0 else "available"
    if pct >= dc.BOOKING_FULL_PCT:
        return "full"
    if pct >= dc.BOOKING_NEAR_FULL_PCT:
        return "near_full"
    return "available"


def _booking(load: float, capacity: float) -> tuple[float | None, str]:
    """On served (2 dp) figures, so I19 holds on what is returned."""

    load2, cap2 = _round2(load), _round2(capacity)
    pct = booked_pct(load2, cap2)
    return pct, booking_status(load2, cap2, pct)


def _lab_region_of(hub: str) -> str:
    return hub_names.HUB_LAB_REGION[hub]


def _calendar_map(cals: Iterable[HubCalendarInput]) -> dict[str, HubCalendarInput]:
    # ADR 0041 §4: a calendar under either spelling of a renamed hub is found
    # under the spelling of the canonical hub list (`_ALL_HUBS`).
    return {hub_names.constants_hub_name(c.hub): c for c in sorted(cals, key=lambda c: c.hub)}


@dataclass(frozen=True)
class _HubFigures:
    deduction_weeks: float
    working_weeks_per_engineer: float
    remaining_working_weeks: float  # per engineer


def _hub_figures(cal: HubCalendarInput | None, current_week: int) -> _HubFigures:
    wiy = float(cal.weeks_in_year) if cal is not None else 52.0
    if cal is None:
        deduction = 0.0
    else:
        deduction = (
            cal.national_holiday_days
            + cal.medical_leave_days
            + cal.casual_leave_days
            + cal.annual_leave_days
        ) / float(cal.weekdays_per_week)
    remaining_weeks = max(0.0, wiy - current_week)
    fraction = remaining_weeks / wiy
    return _HubFigures(
        deduction_weeks=deduction,
        working_weeks_per_engineer=wiy - deduction,
        remaining_working_weeks=remaining_weeks - deduction * fraction,
    )


def _region_holiday_weeks(cals: Mapping[str, HubCalendarInput], region: str) -> float:
    vals = [
        c.national_holiday_days / float(c.weekdays_per_week)
        for hub, c in sorted(cals.items())
        if hub in hub_names.HUB_LAB_REGION and hub_names.HUB_LAB_REGION[hub] == region
    ]
    return max(vals) if vals else 0.0


def _efficient_lab_weeks(
    platforms: int,
    efficiency: float,
    maintenance: float,
    breakdown: float,
    calibration: float,
    region_holidays: float,
) -> float:
    working = float(dc.WITHIN_YEAR_WEEK) - region_holidays - maintenance - breakdown - calibration
    return working * efficiency * platforms


# =====================================================================================
# Applying a scenario
# =====================================================================================


@dataclass(frozen=True)
class AppliedScenario:
    """A scenario applied to a baseline: the scheduler input plus the supply
    inputs of the changed world, and the ids the scenario created."""

    schedule_input: ScheduleInput
    calendars: tuple[HubCalendarInput, ...]
    chamber_supply: tuple[ChamberSupplyInput, ...]
    new_project_ids: tuple[str, ...]
    added_engineer_ids: tuple[str, ...]
    added_chamber_ids: tuple[str, ...]
    removed_engineer_ids: tuple[str, ...]
    reassigned_project_ids: tuple[str, ...]
    #: project_id -> (hub, category, project_type) for each hypothetical project
    new_project_labels: Mapping[str, tuple[str, str, str | None]] = field(default_factory=dict)


def _priority_from(spec: AddProject) -> str:
    if spec.priority is not None:
        return spec.priority
    if spec.score is not None:
        s = spec.score
        if s >= 70:
            return "P1"
        if s >= 55:
            return "P2"
        if s >= 40:
            return "P3"
        return "P4"
    return DEFAULT_ADDED_PRIORITY


def _default_allowed_categories(hub: str) -> tuple[str, ...]:
    return ("OEM", *OEM_CATEGORIES) if hub in hub_names.OEM_HUBS else PDD_CATEGORIES


def chamber_norm(
    baseline: WhatIfBaseline, lab_region: str
) -> tuple[int, float, float, float, float, tuple[str, ...]]:
    """The region's norm for a new chamber:
    `(platforms, efficiency, maintenance, breakdown, calibration, allowed_stages)`.

    platforms is the lower median of the region's chambers (1 if none),
    efficiency and downtime are their means rounded to 3 / 2 dp (1.0 / 0.0 if
    none) and allowed stages the sorted union of their allowed stages (every
    `lab`-kind step of every workflow if none).
    """

    supply = {s.chamber_id: s for s in baseline.chamber_supply}
    rows: list[tuple[ChamberInput, ChamberSupplyInput]] = []
    for ch in sorted(baseline.schedule.chambers, key=lambda c: c.chamber_id):
        if ch.lab_region != lab_region:
            continue
        rows.append(
            (
                ch,
                supply.get(
                    ch.chamber_id,
                    ChamberSupplyInput(
                        ch.chamber_id, ch.lab_region, ch.max_concurrent, ch.efficiency
                    ),
                ),
            )
        )
    if not rows:
        lab_steps = tuple(
            sorted(t.step_id for t in baseline.schedule.workflow_steps if t.kind == "lab")
        )
        return 1, 1.0, 0.0, 0.0, 0.0, lab_steps
    plats = sorted(s.platforms for _, s in rows)
    n = len(rows)
    stages = tuple(sorted({st for ch, _ in rows for st in ch.allowed_stages}))
    return (
        plats[(n - 1) // 2],
        round(sum(s.efficiency for _, s in rows) / n, 3),
        round(sum(s.maintenance_weeks for _, s in rows) / n, 2),
        round(sum(s.breakdown_weeks for _, s in rows) / n, 2),
        round(sum(s.calibration_weeks for _, s in rows) / n, 2),
        stages,
    )


def validate_scenario_limits(scenario: Scenario) -> None:
    """Engine cost caps (S18-M1): total added projects <= 200, added designers
    <= 50, removed designers <= 50, added chambers <= 20 (sums over all lines).
    Raises `ValueError`. Cheap and independent of the baseline."""

    n_proj = sum(ap.count for ap in scenario.add_projects)
    if n_proj > MAX_ADDED_PROJECTS_TOTAL:
        raise ValueError(
            f"at most {MAX_ADDED_PROJECTS_TOTAL} projects can be added in one scenario "
            f"(got {n_proj})"
        )
    n_des = sum(ae.count for ae in scenario.add_engineers)
    if n_des > MAX_ADDED_DESIGNERS_TOTAL:
        raise ValueError(
            f"at most {MAX_ADDED_DESIGNERS_TOTAL} designers can be added in one scenario "
            f"(got {n_des})"
        )
    n_rem = sum(rc.count for rc in scenario.remove_engineer_counts) + len(
        set(scenario.remove_engineers)
    )
    if n_rem > MAX_REMOVED_DESIGNERS_TOTAL:
        raise ValueError(
            f"at most {MAX_REMOVED_DESIGNERS_TOTAL} designers can be removed in one scenario "
            f"(got {n_rem})"
        )
    n_ch = sum(ac.count for ac in scenario.add_chambers)
    if n_ch > MAX_ADDED_CHAMBERS_TOTAL:
        raise ValueError(
            f"at most {MAX_ADDED_CHAMBERS_TOTAL} chambers can be added in one scenario (got {n_ch})"
        )


def _validate_scenario(
    baseline: WhatIfBaseline, scenario: Scenario, *, check_limits: bool = True
) -> None:
    if check_limits:
        validate_scenario_limits(scenario)
    si = baseline.schedule
    lead = {(lt.workflow_id, lt.category) for lt in si.lead_times}
    for ap in scenario.add_projects:
        if ap.hub not in hub_names.HUB_LAB_REGION:
            raise ValueError(f"unknown hub {ap.hub!r}")
        if ap.capacity_hub is not None and ap.capacity_hub not in hub_names.HUB_LAB_REGION:
            raise ValueError(f"unknown capacity hub {ap.capacity_hub!r}")
        wf = "OEM" if ap.hub in hub_names.OEM_HUBS else "PDD"
        if ap.workflow_id is not None and ap.workflow_id != wf:
            raise ValueError(f"hub {ap.hub!r} uses workflow {wf!r}, not {ap.workflow_id!r}")
        if (wf, ap.category) not in lead:
            raise ValueError(f"category {ap.category!r} is not valid for workflow {wf!r}")
        if not 1 <= ap.count <= MAX_COUNT:
            raise ValueError(f"project count must be 1..{MAX_COUNT}")
        if ap.status not in dc.SCHEDULABLE_STATUS_ORDER:
            raise ValueError(f"status {ap.status!r} is not schedulable")
        if ap.priority is not None and ap.priority not in dc.PRIORITY_ORDER:
            raise ValueError(f"unknown priority {ap.priority!r}")
        if ap.score is not None and not 0 <= ap.score <= 100:
            raise ValueError("score must be 0..100")
    for ae in scenario.add_engineers:
        if ae.hub not in hub_names.HUB_LAB_REGION:
            raise ValueError(f"unknown hub {ae.hub!r}")
        if not 1 <= ae.count <= MAX_COUNT:
            raise ValueError(f"engineer count must be 1..{MAX_COUNT}")
        if not ae.fte > 0:
            raise ValueError("fte must be > 0")
    for rc in scenario.remove_engineer_counts:
        if rc.hub not in hub_names.HUB_LAB_REGION:
            raise ValueError(f"unknown hub {rc.hub!r}")
        if rc.count < 1:
            raise ValueError("remove count must be >= 1")
    known_eng = {e.engineer_id for e in si.engineers}
    for eid in scenario.remove_engineers:
        if eid not in known_eng:
            raise ValueError(f"unknown engineer id {eid!r}")
    for ac in scenario.add_chambers:
        if ac.lab_region not in _ALL_REGIONS:
            raise ValueError(f"unknown lab region {ac.lab_region!r}")
        if not 1 <= ac.count <= MAX_COUNT:
            raise ValueError(f"chamber count must be 1..{MAX_COUNT}")
        if ac.platforms is not None and ac.platforms < 1:
            raise ValueError("platforms must be >= 1")
        for v in (ac.efficiency, ac.maintenance_weeks, ac.breakdown_weeks, ac.calibration_weeks):
            if v is not None and v < 0:
                raise ValueError("chamber efficiency and downtime must be >= 0")
    known_ch = {c.chamber_id for c in si.chambers}
    for dt in scenario.chamber_downtime:
        if dt.chamber_id not in known_ch:
            raise ValueError(f"unknown chamber id {dt.chamber_id!r}")
        for v in (dt.maintenance_weeks, dt.breakdown_weeks, dt.calibration_weeks):
            if v is not None and v < 0:
                raise ValueError("downtime weeks must be >= 0")
    known_proj = {p.project_id for p in si.projects}
    for pid, prio in scenario.priority_overrides:
        if pid not in known_proj:
            raise ValueError(f"unknown project id {pid!r}")
        if prio not in dc.PRIORITY_ORDER:
            raise ValueError(f"unknown priority {prio!r}")


def _project_design_weeks(si: ScheduleInput) -> dict[str, int]:
    """Σ design-kind effective duration per schedulable project (used only to
    balance leader assignment)."""

    workflows = build_workflows(si.workflow_steps)
    table = build_lead_time_table(si.lead_times)
    out: dict[str, int] = {}
    for p in sorted(si.projects, key=lambda p: p.project_id):
        if p.status not in dc.SCHEDULABLE_STATUS_ORDER or p.category is None:
            continue
        wf = workflows.get(p.workflow_id)
        if wf is None or any((p.workflow_id, p.category, s.step_id) not in table for s in wf.steps):
            continue
        plan = analyse_project(p, wf, table)
        out[p.project_id] = sum(
            sp.duration for sp in plan.steps.values() if sp.step.kind == "design" and not sp.skipped
        )
    return out


def _capacity_hub_for(si: ScheduleInput, hub: str, explicit: str | None) -> str:
    """ADR 0042: the capacity hub of a hypothetical project on `hub` — the
    explicit value if given, else what the baseline's own projects on that hub
    carry (first by `project_id`), else `hub` (its own capacity hub)."""

    if explicit is not None:
        return explicit
    for p in sorted(si.projects, key=lambda p: p.project_id):
        if p.hub == hub:
            return p.capacity_hub
    return hub


def _pick_leader(
    project: ProjectInput,
    engineers: Sequence[EngineerInput],
    load: Mapping[str, float],
) -> EngineerInput | None:
    # ADR 0032: a designer at FTE <= 0 cannot lead design work (and would
    # divide by zero below), so they are never picked.
    # ADR 0042: the pool is the project's *capacity* hub (R&D-Greece for an
    # OEM-hub project), not its own hub, and only counted designers are ever
    # chosen (P29-T05: a non-counted leader keeps their own projects only).
    hub_engs = sorted(
        (
            e
            for e in engineers
            if e.hub == project.capacity_hub and e.counts_in_capacity and is_valid_fte(e.fte)
        ),
        key=lambda e: e.engineer_id,
    )
    if not hub_engs:
        return None
    eligible = [e for e in hub_engs if not _cat_not_allowed(project, e)] or hub_engs
    return min(eligible, key=lambda e: (load.get(e.engineer_id, 0.0) / e.fte, e.engineer_id))


def apply_scenario(
    baseline: WhatIfBaseline,
    scenario: Scenario,
    *,
    _budget: _Budget = _NO_BUDGET,
    _check_limits: bool = True,
) -> AppliedScenario:
    """Pure: build the changed world. The baseline is not modified. Raises
    `ValueError` for an invalid scenario or one beyond the cost caps."""

    _validate_scenario(baseline, scenario, check_limits=_check_limits)
    _budget.check()
    si = baseline.schedule
    weeks_by_project = _project_design_weeks(si)

    # --- engineers --------------------------------------------------------------
    led: dict[str, float] = defaultdict(float)
    for p in si.projects:
        if p.leader_engineer_id is not None:
            led[p.leader_engineer_id] += weeks_by_project.get(p.project_id, 0)

    removed: set[str] = set(scenario.remove_engineers)
    for rc in sorted(scenario.remove_engineer_counts, key=lambda r: r.hub):
        pool = sorted(
            (
                e
                for e in si.engineers
                if e.hub == rc.hub and e.counts_in_capacity and e.engineer_id not in removed
            ),
            key=lambda e: (led.get(e.engineer_id, 0.0), e.engineer_id),
        )
        for e in pool[: rc.count]:
            removed.add(e.engineer_id)

    engineers: list[EngineerInput] = [e for e in si.engineers if e.engineer_id not in removed]
    added_eng_ids: list[str] = []
    seq = 0
    for ae in scenario.add_engineers:
        cats = ae.allowed_categories or _default_allowed_categories(ae.hub)
        for _ in range(ae.count):
            seq += 1
            eid = f"whatif-eng-{seq:03d}"
            engineers.append(
                EngineerInput(
                    engineer_id=eid,
                    name=f"What-if designer {seq}",
                    hub=ae.hub,
                    allowed_categories=tuple(cats),
                    fte=ae.fte,
                )
            )
            added_eng_ids.append(eid)
    engineers.sort(key=lambda e: e.engineer_id)

    # --- chambers ---------------------------------------------------------------
    supply = {s.chamber_id: s for s in baseline.chamber_supply}
    chambers: list[ChamberInput] = list(si.chambers)
    supply_out: dict[str, ChamberSupplyInput] = {}
    for ch in chambers:
        supply_out[ch.chamber_id] = supply.get(
            ch.chamber_id,
            ChamberSupplyInput(ch.chamber_id, ch.lab_region, ch.max_concurrent, ch.efficiency),
        )
    for dt in sorted(scenario.chamber_downtime, key=lambda d: d.chamber_id):
        cur = supply_out[dt.chamber_id]
        supply_out[dt.chamber_id] = dataclasses.replace(
            cur,
            maintenance_weeks=(
                cur.maintenance_weeks if dt.maintenance_weeks is None else dt.maintenance_weeks
            ),
            breakdown_weeks=(
                cur.breakdown_weeks if dt.breakdown_weeks is None else dt.breakdown_weeks
            ),
            calibration_weeks=(
                cur.calibration_weeks if dt.calibration_weeks is None else dt.calibration_weeks
            ),
        )
    added_ch_ids: list[str] = []
    cseq = 0
    for ac in scenario.add_chambers:
        n_plat, n_eff, n_m, n_b, n_c, n_stages = chamber_norm(baseline, ac.lab_region)
        plat = ac.platforms if ac.platforms is not None else n_plat
        eff = ac.efficiency if ac.efficiency is not None else n_eff
        for _ in range(ac.count):
            cseq += 1
            cid = f"whatif-ch-{cseq:03d}"
            chambers.append(
                ChamberInput(
                    chamber_id=cid,
                    code=f"WHATIF-{ac.lab_region[:3].upper()}-{cseq}",
                    lab_region=ac.lab_region,
                    max_concurrent=plat,
                    allowed_stages=tuple(ac.allowed_stages)
                    if ac.allowed_stages is not None
                    else n_stages,
                    efficiency=eff,
                )
            )
            supply_out[cid] = ChamberSupplyInput(
                chamber_id=cid,
                lab_region=ac.lab_region,
                platforms=plat,
                efficiency=eff,
                maintenance_weeks=ac.maintenance_weeks if ac.maintenance_weeks is not None else n_m,
                breakdown_weeks=ac.breakdown_weeks if ac.breakdown_weeks is not None else n_b,
                calibration_weeks=(
                    ac.calibration_weeks if ac.calibration_weeks is not None else n_c
                ),
            )
            added_ch_ids.append(cid)
    chambers.sort(key=lambda c: c.chamber_id)

    # --- projects ---------------------------------------------------------------
    overrides = dict(scenario.priority_overrides)
    projects: list[ProjectInput] = []
    reassigned: list[str] = []
    # Load per engineer among the surviving leaders (removed engineers' projects
    # are re-assigned below, then new projects).
    load: dict[str, float] = defaultdict(float)
    for p in si.projects:
        if p.leader_engineer_id is not None and p.leader_engineer_id not in removed:
            load[p.leader_engineer_id] += weeks_by_project.get(p.project_id, 0)
    orphans: list[ProjectInput] = []
    for p in sorted(si.projects, key=lambda p: p.project_id):
        if p.project_id in overrides:
            p = dataclasses.replace(p, priority=overrides[p.project_id])
        if p.leader_engineer_id is not None and p.leader_engineer_id in removed:
            orphans.append(p)
        else:
            projects.append(p)
    for p in orphans:
        leader = _pick_leader(p, engineers, load)
        if leader is not None:
            load[leader.engineer_id] += weeks_by_project.get(p.project_id, 0)
        projects.append(
            dataclasses.replace(p, leader_engineer_id=leader.engineer_id if leader else None)
        )
        reassigned.append(p.project_id)

    new_ids: list[str] = []
    labels: dict[str, tuple[str, str, str | None]] = {}
    workflows = build_workflows(si.workflow_steps)
    table = build_lead_time_table(si.lead_times)
    n_new = 0
    for idx, ap in enumerate(scenario.add_projects, start=1):
        wf_id = "OEM" if ap.hub in hub_names.OEM_HUBS else "PDD"
        for k in range(1, ap.count + 1):
            _budget.check()
            n_new += 1
            pid = f"whatif-p{idx:03d}-{k:03d}"
            proto = ProjectInput(
                project_id=pid,
                name=f"What-if project {n_new}",
                hub=ap.hub,
                status=ap.status,
                category=ap.category,
                priority=_priority_from(ap),
                frozen=False,
                leader_engineer_id=None,
                workflow_id=wf_id,
                certification_testing_required=ap.certification_testing_required,
                capacity_hub=_capacity_hub_for(si, ap.hub, ap.capacity_hub),
            )
            leader = _pick_leader(proto, engineers, load)
            if leader is not None:
                plan = analyse_project(proto, workflows[wf_id], table)
                load[leader.engineer_id] += sum(
                    sp.duration
                    for sp in plan.steps.values()
                    if sp.step.kind == "design" and not sp.skipped
                )
            projects.append(
                dataclasses.replace(
                    proto, leader_engineer_id=leader.engineer_id if leader else None
                )
            )
            new_ids.append(pid)
            labels[pid] = (ap.hub, ap.category, ap.project_type)
    projects.sort(key=lambda p: p.project_id)

    new_si = dataclasses.replace(
        si,
        projects=tuple(projects),
        engineers=tuple(engineers),
        chambers=tuple(chambers),
    )
    return AppliedScenario(
        schedule_input=new_si,
        calendars=tuple(sorted(baseline.calendars, key=lambda c: c.hub)),
        chamber_supply=tuple(supply_out[k] for k in sorted(supply_out)),
        new_project_ids=tuple(new_ids),
        added_engineer_ids=tuple(added_eng_ids),
        added_chamber_ids=tuple(added_ch_ids),
        removed_engineer_ids=tuple(sorted(removed)),
        reassigned_project_ids=tuple(reassigned),
        new_project_labels=labels,
    )


def build_scenario_input(baseline: WhatIfBaseline, scenario: Scenario) -> ScheduleInput:
    """The `ScheduleInput` a simulation schedules (for validators and tests)."""

    return apply_scenario(baseline, scenario).schedule_input


# =====================================================================================
# Load and supply figures (shared by the analytic and simulated paths)
# =====================================================================================


def _plan_loads(
    si: ScheduleInput,
) -> tuple[dict[str, float], dict[str, float], dict[str, tuple[int, int]]]:
    """(design weeks by capacity hub, lab weeks by lab region, per-project
    (design, lab)) from the lead-time plan of every schedulable project. This
    is the I6/I7 demand without running the scheduler. Design weeks are keyed
    by `capacity_hub` (ADR 0042 §3: an OEM project's design work is Greece's
    load); lab weeks by the hub's lab region as before."""

    workflows = build_workflows(si.workflow_steps)
    table = build_lead_time_table(si.lead_times)
    by_hub: dict[str, float] = defaultdict(float)
    by_region: dict[str, float] = defaultdict(float)
    per_project: dict[str, tuple[int, int]] = {}
    for p in sorted(si.projects, key=lambda p: p.project_id):
        if p.status not in dc.SCHEDULABLE_STATUS_ORDER or p.category is None:
            continue
        if p.hub not in hub_names.HUB_LAB_REGION:
            continue
        wf = workflows.get(p.workflow_id)
        if wf is None or any((p.workflow_id, p.category, s.step_id) not in table for s in wf.steps):
            continue
        plan = analyse_project(p, wf, table)
        if plan.data_error is not None:
            continue
        d = sum(
            sp.duration for sp in plan.steps.values() if sp.step.kind == "design" and not sp.skipped
        )
        lab = sum(
            sp.duration for sp in plan.steps.values() if sp.step.kind == "lab" and not sp.skipped
        )
        by_hub[p.capacity_hub] += d
        by_region[hub_names.HUB_LAB_REGION[p.hub]] += lab * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
        per_project[p.project_id] = (d, lab)
    return dict(by_hub), dict(by_region), per_project


@dataclass(frozen=True)
class _Supply:
    fte_by_hub: Mapping[str, float]
    wwpe_by_hub: Mapping[str, float]
    remaining_wwpe_by_hub: Mapping[str, float]
    lab_year_by_region: Mapping[str, float]
    lab_remaining_fraction: float
    chambers_by_region: Mapping[str, int]
    region_holidays: Mapping[str, float]


def _supply(
    engineers: Iterable[EngineerInput],
    chambers: Iterable[ChamberInput],
    calendars: Iterable[HubCalendarInput],
    chamber_supply: Iterable[ChamberSupplyInput],
    current_week: int,
) -> _Supply:
    cals = _calendar_map(calendars)
    fte: dict[str, float] = defaultdict(float)
    for e in engineers:
        # ADR 0042 §5: supply is Σ fte over *counted* engineers only; a
        # non-counted leader is booked but never supply.
        if e.counts_in_capacity:
            fte[e.hub] += e.fte
    wwpe: dict[str, float] = {}
    rem: dict[str, float] = {}
    for hub in _ALL_HUBS:
        f = _hub_figures(cals.get(hub), current_week)
        wwpe[hub] = f.working_weeks_per_engineer
        rem[hub] = f.remaining_working_weeks
    holidays = {r: _region_holiday_weeks(cals, r) for r in _ALL_REGIONS}
    sup = {s.chamber_id: s for s in chamber_supply}
    lab_year: dict[str, float] = defaultdict(float)
    n_ch: dict[str, int] = defaultdict(int)
    for ch in sorted(chambers, key=lambda c: c.chamber_id):
        s = sup.get(
            ch.chamber_id,
            ChamberSupplyInput(ch.chamber_id, ch.lab_region, ch.max_concurrent, ch.efficiency),
        )
        lab_year[ch.lab_region] += _efficient_lab_weeks(
            s.platforms,
            s.efficiency,
            s.maintenance_weeks,
            s.breakdown_weeks,
            s.calibration_weeks,
            holidays.get(ch.lab_region, 0.0),
        )
        n_ch[ch.lab_region] += 1
    year = float(dc.WITHIN_YEAR_WEEK)
    return _Supply(
        fte_by_hub=dict(fte),
        wwpe_by_hub=wwpe,
        remaining_wwpe_by_hub=rem,
        lab_year_by_region=dict(lab_year),
        lab_remaining_fraction=max(0.0, year - current_week) / year,
        chambers_by_region=dict(n_ch),
        region_holidays=holidays,
    )


def _design_capacity(sup: _Supply, hub: str, basis: str) -> float:
    per = sup.wwpe_by_hub[hub] if basis == "year" else sup.remaining_wwpe_by_hub[hub]
    return per * sup.fte_by_hub.get(hub, 0.0)


def _lab_capacity(sup: _Supply, region: str, basis: str) -> float:
    y = sup.lab_year_by_region.get(region, 0.0)
    return y if basis == "year" else y * sup.lab_remaining_fraction


# =====================================================================================
# 1. Analytic path
# =====================================================================================


@dataclass(frozen=True)
class HubDesignRequirement:
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
    status_before: str
    status_after: str
    min_extra_designers: int
    min_extra_fte: float
    designer_fte: float
    reachable: bool


@dataclass(frozen=True)
class LabRegionRequirement:
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
    status_before: str
    status_after: str
    efficient_lab_weeks_per_new_chamber: float
    min_extra_chambers: int
    reachable: bool


@dataclass(frozen=True)
class AnalyticRequirements:
    basis: str
    target_below_pct: float
    extra_design_weeks_total: int
    extra_lab_weeks_total: float
    min_extra_designers_total: int
    min_extra_chambers_total: int
    design: tuple[HubDesignRequirement, ...]
    lab: tuple[LabRegionRequirement, ...]
    #: Human-readable arithmetic, one step per line, in reading order.
    workings: tuple[str, ...]
    #: Hubs / lab regions the scenario names (D2b). The four headline totals
    #: above sum ONLY the rows of these hubs and regions; `design` / `lab` keep
    #: every row. Empty for the zero scenario (all totals are then 0).
    touched_hubs: tuple[str, ...] = ()
    touched_lab_regions: tuple[str, ...] = ()


def _fmt(x: float) -> str:
    return f"{x:.2f}".rstrip("0").rstrip(".") if x != int(x) else str(int(x))


def _min_units(
    load: float, base_capacity: float, per_unit: float, target_below_pct: float
) -> tuple[int, bool]:
    """Smallest n >= 0 so the served booked % of `load` against
    `base_capacity + n * per_unit` is below `target_below_pct`. Second value is
    False when no n can do it (a unit adds no capacity)."""

    def ok(n: int) -> bool:
        cap = base_capacity + n * per_unit
        pct, _ = _booking(load, cap)
        if pct is None:
            return load <= 0
        return pct < target_below_pct

    if ok(0):
        return 0, True
    if per_unit <= 0:
        return 0, False
    # closed form first, then settle against the served rounding.
    needed = load * 100.0 / target_below_pct
    n = max(1, math.ceil((needed - base_capacity) / per_unit - 1e-9))
    while not ok(n):
        n += 1
        if n > 100000:
            return 0, False
    while n > 0 and ok(n - 1):
        n -= 1
    return n, True


def touched_scope(
    baseline: WhatIfBaseline, scenario: Scenario
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """`(hubs, lab regions)` the scenario names: hubs of added projects, added
    or removed designers (by count or id) and priority-overridden projects;
    lab regions of added chambers and of chambers with changed downtime; plus
    the lab region of every touched hub. Sorted. Unknown ids are ignored here
    (validation reports them)."""

    si = baseline.schedule
    hubs: set[str] = set()
    regions: set[str] = set()
    # ADR 0042: design-side scope is in capacity hubs (an added OEM-HCK
    # project touches R&D-Greece's designers); its lab region is still the
    # hub's own (Greece either way).
    added_hubs = {ap.hub for ap in scenario.add_projects if ap.hub in hub_names.HUB_LAB_REGION}
    hubs.update(
        _capacity_hub_for(si, ap.hub, ap.capacity_hub)
        for ap in scenario.add_projects
        if ap.hub in hub_names.HUB_LAB_REGION
    )
    hubs.update(ae.hub for ae in scenario.add_engineers)
    hubs.update(rc.hub for rc in scenario.remove_engineer_counts)
    eng_hub = {e.engineer_id: e.hub for e in si.engineers}
    hubs.update(eng_hub[i] for i in scenario.remove_engineers if i in eng_hub)
    proj_cap = {p.project_id: p.capacity_hub for p in si.projects}
    proj_hub = {p.project_id: p.hub for p in si.projects}
    overridden = [i for i, _ in scenario.priority_overrides if i in proj_hub]
    hubs.update(proj_cap[i] for i in overridden)
    regions.update(ac.lab_region for ac in scenario.add_chambers)
    ch_region = {c.chamber_id: c.lab_region for c in si.chambers}
    regions.update(
        ch_region[d.chamber_id] for d in scenario.chamber_downtime if d.chamber_id in ch_region
    )
    regions.update(hub_names.HUB_LAB_REGION[h] for h in hubs if h in hub_names.HUB_LAB_REGION)
    regions.update(hub_names.HUB_LAB_REGION[h] for h in added_hubs)
    regions.update(hub_names.HUB_LAB_REGION[proj_hub[i]] for i in overridden)
    return tuple(sorted(h for h in hubs if h in hub_names.HUB_LAB_REGION)), tuple(sorted(regions))


def analytic_requirements(
    baseline: WhatIfBaseline,
    scenario: Scenario,
    *,
    basis: Basis = "year",
    designer_fte: float = 1.0,
    target_below_pct: float = float(dc.BOOKING_FULL_PCT),
    deadline_s: float | None = None,
    clock: Callable[[], float] | None = None,
    _base_run: _BaselineRun | None = None,
    _budget: _Budget | None = None,
    _check_limits: bool = True,
) -> AnalyticRequirements:
    """Instant formula path (no scheduling).

    For every hub: `new_load = baseline_load + extra_design_weeks`;
    `capacity = working_weeks_per_engineer x FTE` (year) or the remaining-weeks
    variant; booked % before / after the scenario's supply changes; the integer
    ceiling of designers (each `designer_fte` FTE) to add on top of the
    scenario so booked % stays below `target_below_pct`. For every lab region:
    the same with `efficient_lab_weeks` per chamber and the integer ceiling of
    chambers of the region's norm (or the scenario's first added chamber).

    The "before" load is the ACTIVE RUN's load: the I6 design-week and I7
    lab-week sums of one greedy run of the unmodified baseline (the same sums
    the Capacity surface and `simulate`'s `utilization_before` use), so
    `booked_pct_before` equals them to 2 dp on both bases. The scenario adds
    lead-time demand for the NEW projects only (`extra_*`). One greedy run
    (about 20 ms); the engine stays pure and DB-free, which is why the run is
    made here instead of taking DB sums as an input. `deadline_s` / `clock`
    give a cooperative time budget (`WhatIfBudgetExceeded`).

    The headline totals (`min_extra_*_total`, `extra_*_total`) sum only the
    hubs and lab regions the scenario touches (`touched_hubs`,
    `touched_lab_regions`); every hub / region keeps its row.
    """

    if basis not in ("year", "remaining"):
        raise ValueError("basis must be 'year' or 'remaining'")
    if not designer_fte > 0:
        raise ValueError("designer_fte must be > 0")
    budget = _budget if _budget is not None else _Budget(deadline_s, clock)
    applied = apply_scenario(baseline, scenario, _budget=budget, _check_limits=_check_limits)
    si = baseline.schedule
    cw = si.current_week
    touched_hubs, touched_regions = touched_scope(baseline, scenario)

    base_run = _base_run if _base_run is not None else _run_baseline(baseline, budget)
    base_hub_load = {u.key: u.load_weeks for u in base_run.utilization if u.scope == "hub"}
    base_region_load = {
        u.key: u.load_weeks for u in base_run.utilization if u.scope == "lab_region"
    }
    new_only = dataclasses.replace(
        applied.schedule_input,
        projects=tuple(
            p
            for p in applied.schedule_input.projects
            if p.project_id in set(applied.new_project_ids)
        ),
    )
    add_hub_load, add_region_load, add_per_project = _plan_loads(new_only)

    sup_before = _supply(si.engineers, si.chambers, baseline.calendars, baseline.chamber_supply, cw)
    sup_after = _supply(
        applied.schedule_input.engineers,
        applied.schedule_input.chambers,
        applied.calendars,
        applied.chamber_supply,
        cw,
    )
    # After removing engineers the surviving projects keep their load; the
    # re-assigned ones only change leader, never demand.
    # ADR 0042: a new project's design weeks and designer count go to its
    # capacity hub's row; its lab weeks to its own hub's lab region.
    cap_of = {p.project_id: p.capacity_hub for p in applied.schedule_input.projects}
    n_added_by_hub: dict[str, int] = defaultdict(int)
    n_added_by_region: dict[str, int] = defaultdict(int)
    for pid in applied.new_project_ids:
        hub = applied.new_project_labels[pid][0]
        n_added_by_hub[cap_of[pid]] += 1
        n_added_by_region[_lab_region_of(hub)] += 1

    workings: list[str] = []
    basis_label = "year" if basis == "year" else f"remaining (W{cw + 1}-W{dc.WITHIN_YEAR_WEEK})"
    workings.append(
        f"Capacity basis: {basis_label}. A hub or lab region counts as safe while booked % "
        f"is below {_fmt(target_below_pct)} % (served rule: load and capacity rounded to 2 dp)."
    )
    workings.append(
        "Load before the scenario is the active run's booked design/lab weeks (as on Capacity); "
        "the scenario adds the lead-time demand of the new projects only."
    )
    if touched_hubs or touched_regions:
        workings.append(
            "Headline totals cover the hubs and lab regions this scenario touches: hubs "
            f"{list(touched_hubs) or 'none'}, lab regions {list(touched_regions) or 'none'}."
        )
    else:
        workings.append("The scenario changes nothing, so there is nothing extra to add.")

    # Group added projects per (capacity hub, hub, category) for the arithmetic
    # lines. For a non-OEM hub the first two are equal, so the order and text
    # of the lines are exactly the pre-ADR-0042 ones.
    groups: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    for pid in applied.new_project_ids:
        hub, cat, _ = applied.new_project_labels[pid]
        groups[(cap_of[pid], hub, cat)].append(pid)

    design_rows: list[HubDesignRequirement] = []
    for hub in _ALL_HUBS:
        relevant = (
            n_added_by_hub.get(hub, 0) > 0
            or sup_before.fte_by_hub.get(hub, 0.0) != sup_after.fte_by_hub.get(hub, 0.0)
            or base_hub_load.get(hub, 0.0) > 0
        )
        if not relevant:
            continue
        extra = int(add_hub_load.get(hub, 0))
        base_load = base_hub_load.get(hub, 0.0)
        new_load = base_load + extra
        cap_b = _design_capacity(sup_before, hub, basis)
        cap_a = _design_capacity(sup_after, hub, basis)
        pct_b, st_b = _booking(base_load, cap_b)
        pct_a, st_a = _booking(new_load, cap_a)
        per_fte = (
            sup_after.wwpe_by_hub[hub] if basis == "year" else sup_after.remaining_wwpe_by_hub[hub]
        )
        per_designer = per_fte * designer_fte
        n_des, reachable = _min_units(new_load, cap_a, per_designer, target_below_pct)

        if n_added_by_hub.get(hub, 0) > 0:
            parts = []
            for (g_cap, g_hub, cat), pids in sorted(groups.items()):
                if g_cap != hub:
                    continue
                d = add_per_project[pids[0]][0]
                member = "" if g_hub == g_cap else f", {g_hub}"
                parts.append(f"{len(pids)} x {d} wk ({cat}{member})")
            workings.append(f"{hub}: extra design weeks = " + " + ".join(parts) + f" = {extra}.")
        workings.append(
            f"{hub}: load {_fmt(base_load)} + {extra} = {_fmt(new_load)} wk; capacity = "
            f"{_fmt(_round2(per_fte))} wk/FTE x "
            f"{_fmt(_round2(sup_after.fte_by_hub.get(hub, 0.0)))} "
            f"FTE = {_fmt(_round2(cap_a))} wk; booked "
            f"{'n/a' if pct_a is None else _fmt(pct_a) + ' %'} ({st_a}); was "
            f"{'n/a' if pct_b is None else _fmt(pct_b) + ' %'} ({st_b})."
        )
        if n_des == 0 and reachable:
            workings.append(
                f"{hub}: no extra designers needed to stay below {_fmt(target_below_pct)} %."
            )
        elif not reachable:
            workings.append(
                f"{hub}: adding designers cannot reach the target (no capacity per designer)."
            )
        else:
            need_fte = (
                new_load * 100.0 / target_below_pct / per_fte if per_fte > 0 else float("inf")
            )
            workings.append(
                f"{hub}: need capacity > {_fmt(_round2(new_load * 100.0 / target_below_pct))} wk, "
                f"i.e. > {_fmt(_round2(need_fte))} FTE; have "
                f"{_fmt(_round2(sup_after.fte_by_hub.get(hub, 0.0)))}; add ceil("
                f"({_fmt(_round2(need_fte))} - "
                f"{_fmt(_round2(sup_after.fte_by_hub.get(hub, 0.0)))}) / {_fmt(designer_fte)}) "
                f"= {n_des} designer(s) at {_fmt(designer_fte)} FTE."
            )
        design_rows.append(
            HubDesignRequirement(
                hub=hub,
                added_projects=n_added_by_hub.get(hub, 0),
                extra_design_weeks=extra,
                baseline_load_weeks=base_load,
                new_load_weeks=new_load,
                fte_before=_round2(sup_before.fte_by_hub.get(hub, 0.0)),
                fte_after_scenario=_round2(sup_after.fte_by_hub.get(hub, 0.0)),
                working_weeks_per_engineer=_round2(sup_after.wwpe_by_hub[hub]),
                capacity_before=_round2(cap_b),
                capacity_after_scenario=_round2(cap_a),
                booked_pct_before=pct_b,
                booked_pct_after=pct_a,
                status_before=st_b,
                status_after=st_a,
                min_extra_designers=n_des,
                min_extra_fte=_round2(n_des * designer_fte),
                designer_fte=designer_fte,
                reachable=reachable,
            )
        )

    lab_rows: list[LabRegionRequirement] = []
    for region in _ALL_REGIONS:
        relevant = (
            n_added_by_region.get(region, 0) > 0
            or sup_before.lab_year_by_region.get(region, 0.0)
            != sup_after.lab_year_by_region.get(region, 0.0)
            or base_region_load.get(region, 0.0) > 0
        )
        if not relevant:
            continue
        extra_lab = add_region_load.get(region, 0.0)
        base_load = base_region_load.get(region, 0.0)
        new_load = base_load + extra_lab
        cap_b = _lab_capacity(sup_before, region, basis)
        cap_a = _lab_capacity(sup_after, region, basis)
        pct_b, st_b = _booking(base_load, cap_b)
        pct_a, st_a = _booking(new_load, cap_a)
        # per-chamber supply of the unit that would be added
        spec_src = next(
            (ac for ac in scenario.add_chambers if ac.lab_region == region), AddChamber(region)
        )
        n_plat, n_eff, n_m, n_b, n_c, _stages = chamber_norm(baseline, region)
        plat = spec_src.platforms if spec_src.platforms is not None else n_plat
        eff = spec_src.efficiency if spec_src.efficiency is not None else n_eff
        mnt = spec_src.maintenance_weeks if spec_src.maintenance_weeks is not None else n_m
        brk = spec_src.breakdown_weeks if spec_src.breakdown_weeks is not None else n_b
        cal = spec_src.calibration_weeks if spec_src.calibration_weeks is not None else n_c
        hol = sup_after.region_holidays.get(region, 0.0)
        per_ch_year = _efficient_lab_weeks(plat, eff, mnt, brk, cal, hol)
        per_ch = per_ch_year if basis == "year" else per_ch_year * sup_after.lab_remaining_fraction
        n_ch, reachable = _min_units(new_load, cap_a, per_ch, target_below_pct)

        if extra_lab or n_added_by_region.get(region, 0):
            parts = []
            for (_g_cap, g_hub, cat), pids in sorted(groups.items()):
                if _lab_region_of(g_hub) != region:
                    continue
                lw = add_per_project[pids[0]][1]
                parts.append(f"{len(pids)} x {lw} wk ({cat}, {g_hub})")
            workings.append(
                f"{region} lab: extra lab weeks = " + " + ".join(parts) + f" = {_fmt(extra_lab)}."
            )
        workings.append(
            f"{region} lab: load {_fmt(base_load)} + {_fmt(extra_lab)} = {_fmt(new_load)} wk; "
            f"capacity {_fmt(_round2(cap_a))} wk; booked "
            f"{'n/a' if pct_a is None else _fmt(pct_a) + ' %'} ({st_a}); was "
            f"{'n/a' if pct_b is None else _fmt(pct_b) + ' %'} ({st_b})."
        )
        if n_ch == 0 and reachable:
            workings.append(
                f"{region} lab: no extra chambers needed to stay below {_fmt(target_below_pct)} %."
            )
        elif not reachable:
            workings.append(
                f"{region} lab: adding chambers cannot reach the target (no capacity per chamber)."
            )
        else:
            working_wk = float(dc.WITHIN_YEAR_WEEK) - hol - mnt - brk - cal
            need_cap = _fmt(_round2(new_load * 100.0 / target_below_pct))
            tail = (
                ""
                if basis == "year"
                else f", x {_fmt(round(sup_after.lab_remaining_fraction, 4))} remaining"
            )
            workings.append(
                f"{region} lab: one chamber adds ({_fmt(_round2(working_wk))} working wk x "
                f"{_fmt(eff)} efficiency x {plat} platform(s)) = "
                f"{_fmt(_round2(per_ch_year))} wk{tail}; need capacity > {need_cap}, have "
                f"{_fmt(_round2(cap_a))}; add ceil(({need_cap} - {_fmt(_round2(cap_a))}) / "
                f"{_fmt(_round2(per_ch))}) = {n_ch} chamber(s)."
            )
        lab_rows.append(
            LabRegionRequirement(
                lab_region=region,
                added_projects=n_added_by_region.get(region, 0),
                extra_lab_weeks=extra_lab,
                baseline_load_weeks=base_load,
                new_load_weeks=new_load,
                chambers_before=sup_before.chambers_by_region.get(region, 0),
                chambers_after_scenario=sup_after.chambers_by_region.get(region, 0),
                capacity_before=_round2(cap_b),
                capacity_after_scenario=_round2(cap_a),
                booked_pct_before=pct_b,
                booked_pct_after=pct_a,
                status_before=st_b,
                status_after=st_a,
                efficient_lab_weeks_per_new_chamber=_round2(per_ch),
                min_extra_chambers=n_ch,
                reachable=reachable,
            )
        )

    t_design = [r for r in design_rows if r.hub in touched_hubs]
    t_lab = [r for r in lab_rows if r.lab_region in touched_regions]
    return AnalyticRequirements(
        basis=basis,
        target_below_pct=target_below_pct,
        extra_design_weeks_total=sum(r.extra_design_weeks for r in t_design),
        extra_lab_weeks_total=sum(r.extra_lab_weeks for r in t_lab),
        min_extra_designers_total=sum(r.min_extra_designers for r in t_design),
        min_extra_chambers_total=sum(r.min_extra_chambers for r in t_lab),
        design=tuple(design_rows),
        lab=tuple(lab_rows),
        workings=tuple(workings),
        touched_hubs=touched_hubs,
        touched_lab_regions=touched_regions,
    )


# =====================================================================================
# 2. Simulation
# =====================================================================================


@dataclass(frozen=True)
class ProjectResult:
    project_id: str
    name: str
    hub: str
    category: str | None
    priority: str | None
    is_new: bool
    outcome: str  # one of OUTCOME_CLASSES
    finish_week: int | None  # projected_end_week (end + delay); None when not scheduled
    within_year: bool
    #: Earliest finish with unlimited designers and chambers, at the speed of
    #: the project's assigned leader (ADR 0032: design steps stretch by 1/FTE).
    #: Whether a project cannot finish in the year whatever is added is decided
    #: at the fastest designer's speed (`_unattainable_new_projects`).
    unconstrained_end_week: int | None


@dataclass(frozen=True)
class UtilizationRow:
    scope: str  # "hub" | "lab_region"
    key: str
    load_weeks: float
    capacity_year: float
    booked_pct_year: float | None
    status_year: str
    capacity_remaining: float
    booked_pct_remaining: float | None
    status_remaining: str
    #: hubs: total FTE; lab regions: number of chambers
    units: float


@dataclass(frozen=True)
class ProjectChange:
    project_id: str
    name: str
    hub: str
    kind: str  # "newly_slipping" | "recovered" | "moved"
    before_outcome: str
    after_outcome: str
    before_finish_week: int | None
    after_finish_week: int | None


@dataclass(frozen=True)
class ScenarioDiff:
    within_year_before: int
    within_year_after: int
    within_year_delta: int
    existing_within_year_before: int
    existing_within_year_after: int
    new_projects_total: int
    new_projects_within_year: int
    newly_slipping: tuple[ProjectChange, ...]
    recovered: tuple[ProjectChange, ...]
    moved: tuple[ProjectChange, ...]


@dataclass(frozen=True)
class SimulationResult:
    projects: tuple[ProjectResult, ...]  # sorted by project_id; includes new projects
    outcome_counts_before: Mapping[str, int]
    outcome_counts_after: Mapping[str, int]
    utilization_before: tuple[UtilizationRow, ...]
    utilization_after: tuple[UtilizationRow, ...]
    diff: ScenarioDiff
    new_project_ids: tuple[str, ...]
    added_engineer_ids: tuple[str, ...]
    added_chamber_ids: tuple[str, ...]
    removed_engineer_ids: tuple[str, ...]
    reassigned_project_ids: tuple[str, ...]
    greedy_runs: int
    workings: tuple[str, ...]


def classify_outcome(o: ProjectScheduleOutcome) -> str:
    if o.excluded:
        return "excluded"
    if o.data_error is not None:
        return "data_error"
    if o.left_out:
        return "left_out"
    if o.blocked:
        return "blocked"
    return "within_year" if o.within_year else "spillover"


def _utilization(
    si: ScheduleInput,
    output: ScheduleOutput,
    calendars: Iterable[HubCalendarInput],
    chamber_supply: Iterable[ChamberSupplyInput],
) -> tuple[UtilizationRow, ...]:
    sup = _supply(si.engineers, si.chambers, calendars, chamber_supply, si.current_week)
    # ADR 0042 §3: the hub rows are capacity-hub rows (OEM load on Greece).
    hub_load = compute_design_load_by_capacity_hub(si, output)
    # lab load by region from outcomes (I7)
    proj = {p.project_id: p for p in si.projects}
    region_load: dict[str, float] = defaultdict(float)
    for o in output.project_outcomes:
        p = proj.get(o.project_id)
        if p is None or p.hub not in hub_names.HUB_LAB_REGION:
            continue
        for st in o.steps:
            if st.kind == "lab" and not st.skipped:
                region_load[hub_names.HUB_LAB_REGION[p.hub]] += (
                    st.duration_weeks * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
                )
    rows: list[UtilizationRow] = []
    for hub in _ALL_HUBS:
        load = float(hub_load.get(hub, 0))
        cy, cr = _design_capacity(sup, hub, "year"), _design_capacity(sup, hub, "remaining")
        py, sy = _booking(load, cy)
        pr, sr = _booking(load, cr)
        rows.append(
            UtilizationRow(
                "hub",
                hub,
                load,
                _round2(cy),
                py,
                sy,
                _round2(cr),
                pr,
                sr,
                _round2(sup.fte_by_hub.get(hub, 0.0)),
            )
        )
    for region in _ALL_REGIONS:
        load = float(region_load.get(region, 0.0))
        cy, cr = _lab_capacity(sup, region, "year"), _lab_capacity(sup, region, "remaining")
        py, sy = _booking(load, cy)
        pr, sr = _booking(load, cr)
        rows.append(
            UtilizationRow(
                "lab_region",
                region,
                load,
                _round2(cy),
                py,
                sy,
                _round2(cr),
                pr,
                sr,
                float(sup.chambers_by_region.get(region, 0)),
            )
        )
    return tuple(rows)


@dataclass(frozen=True)
class _BaselineRun:
    output: ScheduleOutput
    by_id: Mapping[str, ProjectScheduleOutcome]
    utilization: tuple[UtilizationRow, ...]
    names: Mapping[str, str]
    hubs: Mapping[str, str]


def _run_baseline(baseline: WhatIfBaseline, budget: _Budget = _NO_BUDGET) -> _BaselineRun:
    budget.check()
    si = baseline.schedule
    out = run_greedy_sgs(si)
    return _BaselineRun(
        output=out,
        by_id={o.project_id: o for o in out.project_outcomes},
        utilization=_utilization(si, out, baseline.calendars, baseline.chamber_supply),
        names={p.project_id: p.name for p in si.projects},
        hubs={p.project_id: p.hub for p in si.projects},
    )


def _counts(outcomes: Iterable[ProjectScheduleOutcome]) -> dict[str, int]:
    c = {k: 0 for k in OUTCOME_CLASSES}
    for o in outcomes:
        c[classify_outcome(o)] += 1
    return c


def _simulate_with(
    baseline: WhatIfBaseline,
    scenario: Scenario,
    base_run: _BaselineRun,
    runs_so_far: int,
    budget: _Budget = _NO_BUDGET,
    check_limits: bool = True,
) -> SimulationResult:
    applied = apply_scenario(baseline, scenario, _budget=budget, _check_limits=check_limits)
    si = applied.schedule_input
    budget.check()
    out = run_greedy_sgs(si)
    budget.check()
    proj = {p.project_id: p for p in si.projects}
    new_ids = set(applied.new_project_ids)

    results: list[ProjectResult] = []
    for o in out.project_outcomes:
        p = proj[o.project_id]
        results.append(
            ProjectResult(
                project_id=o.project_id,
                name=p.name,
                hub=p.hub,
                category=p.category,
                priority=p.priority,
                is_new=o.project_id in new_ids,
                outcome=classify_outcome(o),
                finish_week=o.projected_end_week,
                within_year=o.within_year,
                unconstrained_end_week=o.unconstrained_end_week,
            )
        )

    slipping: list[ProjectChange] = []
    recovered: list[ProjectChange] = []
    moved: list[ProjectChange] = []
    for o in out.project_outcomes:
        if o.project_id in new_ids:
            continue
        b = base_run.by_id.get(o.project_id)
        if b is None:
            continue
        same = (
            b.projected_end_week == o.projected_end_week
            and b.within_year == o.within_year
            and b.left_out == o.left_out
            and b.blocked == o.blocked
            and b.excluded == o.excluded
        )
        if same:
            continue
        kind = "moved"
        if b.within_year and not o.within_year:
            kind = "newly_slipping"
        elif o.within_year and not b.within_year:
            kind = "recovered"
        ch = ProjectChange(
            project_id=o.project_id,
            name=proj[o.project_id].name,
            hub=proj[o.project_id].hub,
            kind=kind,
            before_outcome=classify_outcome(b),
            after_outcome=classify_outcome(o),
            before_finish_week=b.projected_end_week,
            after_finish_week=o.projected_end_week,
        )
        {"newly_slipping": slipping, "recovered": recovered, "moved": moved}[kind].append(ch)

    wy_before = sum(1 for o in base_run.output.project_outcomes if o.within_year)
    wy_after = sum(1 for o in out.project_outcomes if o.within_year)
    existing_after = sum(
        1 for o in out.project_outcomes if o.within_year and o.project_id not in new_ids
    )
    new_wy = sum(1 for o in out.project_outcomes if o.within_year and o.project_id in new_ids)
    diff = ScenarioDiff(
        within_year_before=wy_before,
        within_year_after=wy_after,
        within_year_delta=wy_after - wy_before,
        existing_within_year_before=wy_before,
        existing_within_year_after=existing_after,
        new_projects_total=len(new_ids),
        new_projects_within_year=new_wy,
        newly_slipping=tuple(slipping),
        recovered=tuple(recovered),
        moved=tuple(moved),
    )
    after_util = _utilization(si, out, applied.calendars, applied.chamber_supply)
    workings = [
        f"Greedy SGS re-run on a copy of the plan with the scenario applied "
        f"({len(si.projects)} projects, {len(si.engineers)} designers, "
        f"{len(si.chambers)} chambers).",
        f"Within-year projects: {wy_before} -> {wy_after} ({wy_after - wy_before:+d}); "
        f"existing {wy_before} -> {existing_after}; new {new_wy} of {len(new_ids)}.",
        f"{len(slipping)} existing project(s) newly slipping, {len(recovered)} recovered, "
        f"{len(moved)} otherwise moved.",
    ]
    return SimulationResult(
        projects=tuple(results),
        outcome_counts_before=_counts(base_run.output.project_outcomes),
        outcome_counts_after=_counts(out.project_outcomes),
        utilization_before=base_run.utilization,
        utilization_after=after_util,
        diff=diff,
        new_project_ids=applied.new_project_ids,
        added_engineer_ids=applied.added_engineer_ids,
        added_chamber_ids=applied.added_chamber_ids,
        removed_engineer_ids=applied.removed_engineer_ids,
        reassigned_project_ids=applied.reassigned_project_ids,
        greedy_runs=runs_so_far + 1,
        workings=tuple(workings),
    )


def simulate(
    baseline: WhatIfBaseline,
    scenario: Scenario,
    *,
    deadline_s: float | None = None,
    clock: Callable[[], float] | None = None,
) -> SimulationResult:
    """Run the real greedy SGS on the baseline and on the scenario and diff
    them. Two greedy runs. Side-effect free; the baseline is untouched.
    `deadline_s` / `clock`: cooperative time budget (`WhatIfBudgetExceeded`)."""

    budget = _Budget(deadline_s, clock)
    validate_scenario_limits(scenario)
    base_run = _run_baseline(baseline, budget)
    return _simulate_with(baseline, scenario, base_run, 1, budget)


# =====================================================================================
# 3. Minimum additions
# =====================================================================================


@dataclass(frozen=True)
class Additions:
    designers: tuple[tuple[str, int], ...]  # (hub, count), sorted, count > 0
    chambers: tuple[tuple[str, int], ...]  # (lab_region, count), sorted, count > 0

    @property
    def total(self) -> int:
        return sum(n for _, n in self.designers) + sum(n for _, n in self.chambers)


@dataclass(frozen=True)
class MinimumAdditionsResult:
    target: str
    #: Every project of the target is within the year (False whenever
    #: `unattainable_project_ids` is non-empty for `all_new_within_year`).
    met: bool
    #: The target holds for every project that capacity can still help.
    met_attainable: bool
    #: Added projects whose critical path alone ends after W52 (lead times
    #: with unlimited resources); no addition can bring them within the year.
    unattainable_project_ids: tuple[str, ...]
    #: The run cap was reached before the search finished.
    capped: bool
    #: True when `additions` is the proven minimum total over the searched
    #: dimensions (the search enumerated every smaller total).
    exact: bool
    additions: Additions
    achieved: SimulationResult | None
    unmet_project_ids: tuple[str, ...]
    runs_used: int
    run_cap: int
    searched_designer_hubs: tuple[str, ...]
    searched_chamber_regions: tuple[str, ...]
    workings: tuple[str, ...]


def _apply_units(
    scenario: Scenario,
    dims: Sequence[tuple[str, str]],
    units: Sequence[int],
    designer_fte: float,
) -> Scenario:
    add_e = list(scenario.add_engineers)
    add_c = list(scenario.add_chambers)
    for (kind, key), n in zip(dims, units, strict=True):
        if n <= 0:
            continue
        if kind == "designer":
            add_e.append(AddEngineer(hub=key, fte=designer_fte, count=n))
        else:
            add_c.append(AddChamber(lab_region=key, count=n))
    return dataclasses.replace(scenario, add_engineers=tuple(add_e), add_chambers=tuple(add_c))


def scenario_with_additions(
    scenario: Scenario, additions: Additions, designer_fte: float = 1.0
) -> Scenario:
    """`scenario` plus the designers / chambers of a `MinimumAdditionsResult`
    (so a caller can re-simulate or validate the recommended world)."""

    dims = [("designer", h) for h, _ in additions.designers] + [
        ("chamber", r) for r, _ in additions.chambers
    ]
    units = [n for _, n in additions.designers] + [n for _, n in additions.chambers]
    return _apply_units(scenario, dims, units, designer_fte)


def _violators(
    target: str,
    res: SimulationResult,
    base_run: _BaselineRun,
    unattainable: frozenset[str] | None = None,
) -> tuple[tuple[str, ...], int]:
    """(violating project ids, total lateness weeks over the violators).
    `unattainable`: new projects excluded from the target (None: decide per
    result from its own unconstrained finish)."""

    ids: list[str] = []
    late = 0
    if target == "all_new_within_year":
        for r in res.projects:
            skip = _unattainable(r) if unattainable is None else r.project_id in unattainable
            if r.is_new and r.outcome != "within_year" and not skip:
                ids.append(r.project_id)
                late += _lateness(r)
    else:
        for r in res.projects:
            if r.is_new:
                continue
            b = base_run.by_id.get(r.project_id)
            if b is not None and b.within_year and not r.within_year:
                ids.append(r.project_id)
                late += _lateness(r)
    return tuple(ids), late


def _unattainable(r: ProjectResult) -> bool:
    """A project that misses W52 even with unlimited resources."""

    return r.unconstrained_end_week is not None and r.unconstrained_end_week > dc.WITHIN_YEAR_WEEK


def _unattainable_new_projects(applied: AppliedScenario, designer_fte: float) -> frozenset[str]:
    """New projects that miss W52 even with unlimited designers and chambers
    when led at the fastest speed any designer could give them: the larger of
    the solver's added-designer FTE and the best valid FTE among the capacity
    hub's designers (ADR 0032; ADR 0042 for the pool). Fixed for the whole
    search, so the target never depends on which designer the leader
    balancing happened to pick."""

    si = applied.schedule_input
    new = set(applied.new_project_ids)
    best: dict[str, float] = {}
    for e in sorted(si.engineers, key=lambda e: e.engineer_id):
        # Only counted designers can be picked for a new project (P29-T05).
        if e.counts_in_capacity and is_valid_fte(e.fte):
            best[e.hub] = max(best.get(e.hub, 0.0), e.fte)
    workflows = build_workflows(si.workflow_steps)
    table = build_lead_time_table(si.lead_times)
    out: set[str] = set()
    for p in sorted(si.projects, key=lambda p: p.project_id):
        if p.project_id not in new:
            continue
        speed = max(designer_fte, best.get(p.capacity_hub, 0.0))
        plan = analyse_project(p, workflows[p.workflow_id], table, leader_fte=speed)
        u = unconstrained_end_week(plan, si.current_week)
        if u is not None and u > dc.WITHIN_YEAR_WEEK:
            out.add(p.project_id)
    return frozenset(out)


def _lateness(r: ProjectResult) -> int:
    if r.finish_week is None:
        return dc.HORIZON_WEEKS + 1 - dc.WITHIN_YEAR_WEEK
    return max(0, r.finish_week - dc.WITHIN_YEAR_WEEK)


def _compositions(total: int, parts: int) -> Iterable[tuple[int, ...]]:
    """All non-negative integer tuples of length `parts` summing to `total`, in
    lexicographic order of the tuple read last-dimension-first ascending, so
    additions in later dimensions (chambers) are tried before heavier early ones."""

    if parts == 1:
        yield (total,)
        return
    for first in range(total + 1):
        for rest in _compositions(total - first, parts - 1):
            yield (first, *rest)


def _n_compositions(total: int, parts: int) -> int:
    return math.comb(total + parts - 1, parts - 1)


def solve_minimum_additions(
    baseline: WhatIfBaseline,
    scenario: Scenario,
    target: Target = "all_new_within_year",
    *,
    max_runs: int = HARD_MAX_RUNS,
    designer_fte: float = 1.0,
    max_units_per_dimension: int = 25,
    deadline_s: float | None = None,
    clock: Callable[[], float] | None = None,
) -> MinimumAdditionsResult:
    """Smallest designers-per-hub and chambers-per-region (on top of
    `scenario`) that meet `target`, found by running the real greedy SGS.

    Targets: `all_new_within_year` (every added project finishes by W52) and
    `no_existing_slips` (no existing project that finishes within the year in
    the baseline stops doing so).

    Search dimensions are the designer pools of the hubs the scenario touches
    (hubs of added projects, of removed engineers and of priority overrides)
    and the chamber pools of those hubs' lab regions that added projects need.
    Lab regions are independent (a project only uses its hub's designers and
    its region's chambers), so each region is solved on its own with the others
    held fixed and the minimum total is the sum. Per region: one pool is a
    doubling + bisection; two pools (a hub plus its chambers, the usual case)
    a bisection to a feasible corner, a staircase walk and one probe along each
    axis from zero (greedy is not monotone in chambers, so the corner alone can
    miss the cheapest point); three or more (several hubs sharing chambers)
    exhaustive by total while a level fits a third of the budget, then a climb
    from the analytic estimate and a prune. Every region result is then
    polished: the totals just below it are tried (nearest first) while budget
    remains, and any cheaper feasible point replaces it.

    `exact` is true ONLY when every combination with a smaller total was
    actually simulated and failed (verified, not assumed). Otherwise the
    answer is the minimum under the assumption that more capacity never
    hurts, and a workings line says how many smaller combinations were left
    unchecked. Every evaluated pair is also audited for non-monotonicity.
    Ties on total prefer fewer chambers. The whole search spends at most
    `min(max_runs, 60)` greedy runs, baseline run included; `capped` is set
    when the budget ended the search early. Designer / chamber additions are
    clamped so that scenario + additions stay within the scenario caps.
    `deadline_s` / `clock`: cooperative time budget (`WhatIfBudgetExceeded`).
    """

    if target not in TARGETS:
        raise ValueError(f"target must be one of {TARGETS}")
    if not designer_fte > 0:
        raise ValueError("designer_fte must be > 0")
    budget = _Budget(deadline_s, clock)
    cap = max(2, min(int(max_runs), HARD_MAX_RUNS))

    applied0 = apply_scenario(baseline, scenario, _budget=budget)
    # ADR 0042: designers are searched per *capacity* hub — an added OEM-HCK
    # project is led from R&D-Greece, so that is where designers are added.
    cap_of0 = {p.project_id: p.capacity_hub for p in applied0.schedule_input.projects}
    hubs: set[str] = {cap_of0[pid] for pid in applied0.new_project_ids}
    by_id = {p.project_id: p for p in baseline.schedule.projects}
    by_eng = {e.engineer_id: e.hub for e in baseline.schedule.engineers}
    for eid in applied0.removed_engineer_ids:
        hubs.add(by_eng[eid])
    for pid, _ in scenario.priority_overrides:
        hubs.add(by_id[pid].capacity_hub)
    designer_hubs = tuple(sorted(hubs))

    new_set = set(applied0.new_project_ids)
    unattainable_ids = _unattainable_new_projects(applied0, designer_fte)
    _, _, per_project = _plan_loads(
        dataclasses.replace(
            applied0.schedule_input,
            projects=tuple(p for p in applied0.schedule_input.projects if p.project_id in new_set),
        )
    )
    regions: set[str] = set()
    for pid in applied0.new_project_ids:
        if per_project.get(pid, (0, 0))[1] > 0:
            regions.add(_lab_region_of(applied0.new_project_labels[pid][0]))
    for pid, _ in scenario.priority_overrides:
        regions.add(_lab_region_of(by_id[pid].hub))
    chamber_regions = tuple(sorted(regions))

    dims: list[tuple[str, str]] = [("designer", h) for h in designer_hubs] + [
        ("chamber", r) for r in chamber_regions
    ]
    workings: list[str] = [
        f"Target: {target}. Search dimensions: designers in {list(designer_hubs) or 'none'}, "
        f"chambers in {list(chamber_regions) or 'none'}. Run cap {cap} (baseline run included)."
    ]

    base_run = _run_baseline(baseline, budget)
    runs = 1
    cache: dict[tuple[int, ...], tuple[SimulationResult, tuple[str, ...], int]] = {}
    #: (region, that region's own coordinates) -> region meets the target. Regions
    #: are independent, so this verdict is reusable whatever the other regions hold.
    gmemo: dict[tuple[str, tuple[int, ...]], bool] = {}
    # Per-dimension limits: the search limit, clamped so scenario + additions
    # stay within the scenario caps (the recommendation must be re-simulable).
    room_des = max(0, MAX_ADDED_DESIGNERS_TOTAL - sum(ae.count for ae in scenario.add_engineers))
    room_ch = max(0, MAX_ADDED_CHAMBERS_TOTAL - sum(ac.count for ac in scenario.add_chambers))
    lims = [
        min(max_units_per_dimension, room_des if kind == "designer" else room_ch)
        for kind, _ in dims
    ]
    region_of_dim = [key if kind == "chamber" else _lab_region_of(key) for kind, key in dims]
    groups = sorted(set(region_of_dim))

    # Regions are independent subsystems: a project only ever uses the
    # designers of its capacity hub (ADR 0042) and the chambers of its hub's
    # lab region — and a capacity hub's lab region is its members' (the OEM
    # hubs and R&D-Greece are all Greece) — so one region's additions cannot
    # change another region's projects. The search
    # therefore solves one region at a time (a pool of at most 2-4 dimensions)
    # with every other region held fixed, and the minimum total is the sum.
    class _Group:
        def __init__(self, region: str) -> None:
            self.region = region
            self.idx = [i for i, r in enumerate(region_of_dim) if r == region]
            self.n_des = sum(1 for i in self.idx if dims[i][0] == "designer")
            self.lims = [lims[i] for i in self.idx]

        def full(self, local: Sequence[int], current: tuple[int, ...]) -> tuple[int, ...]:
            out = list(current)
            for i, v in zip(self.idx, local, strict=True):
                out[i] = v
            return tuple(out)

        def local_of(self, units: Sequence[int]) -> tuple[int, ...]:
            return tuple(units[i] for i in self.idx)

        def fits(self, local: Sequence[int]) -> bool:
            return all(v <= lm for v, lm in zip(local, self.lims, strict=True))

    gobjs = {r: _Group(r) for r in groups}

    def evaluate(units: tuple[int, ...]) -> tuple[SimulationResult, tuple[str, ...], int]:
        nonlocal runs
        hit = cache.get(units)
        if hit is not None:
            return hit
        if runs >= cap:
            raise _RunCapReached
        sc = _apply_units(scenario, dims, units, designer_fte)
        res = _simulate_with(baseline, sc, base_run, runs, budget, check_limits=False)
        runs += 1
        vio, late = _violators(target, res, base_run, unattainable_ids)
        cache[units] = (res, vio, late)
        hub_of = {r.project_id: r.hub for r in res.projects}
        bad_regions = {_lab_region_of(hub_of[p]) for p in vio}
        for g in gobjs.values():
            gmemo[(g.region, g.local_of(units))] = g.region not in bad_regions
        return cache[units]

    def region_violators(units: tuple[int, ...], region: str) -> tuple[str, ...]:
        res, vio, _ = evaluate(units)
        hub_of = {r.project_id: r.hub for r in res.projects}
        return tuple(p for p in vio if _lab_region_of(hub_of[p]) == region)

    seed_req = analytic_requirements(
        baseline,
        scenario,
        designer_fte=designer_fte,
        _base_run=base_run,
        _budget=budget,
    )
    des_need = {r.hub: r.min_extra_designers for r in seed_req.design}
    lab_need = {r.lab_region: r.min_extra_chambers for r in seed_req.lab}

    def feasible(g: _Group, local: tuple[int, ...], current: tuple[int, ...]) -> bool:
        hit = gmemo.get((g.region, local))
        if hit is not None:
            return hit
        return not region_violators(g.full(local, current), g.region)

    def key_of(g: _Group, local: tuple[int, ...]) -> tuple[int, int, tuple[int, ...]]:
        return (sum(local), sum(local[g.n_des :]), local)

    def solve_group(g: _Group, current: tuple[int, ...]) -> tuple[tuple[int, ...] | None, bool]:
        """Best units for group `g` with the rest as in `current`:
        (full units or None, search_was_exhaustive_by_construction)."""

        k = len(g.idx)

        def ok(local: tuple[int, ...]) -> bool:
            return feasible(g, local, current)

        def min_along(axis: int, fixed: tuple[int, ...]) -> int | None:
            lim = g.lims[axis]

            def at(v: int) -> tuple[int, ...]:
                return fixed[:axis] + (v,) + fixed[axis + 1 :]

            if ok(at(0)):
                return 0
            if lim < 1:
                return None
            lo, hi = 0, 1
            while hi < lim and not ok(at(hi)):
                lo, hi = hi, hi * 2
            if hi >= lim:
                hi = lim
                if not ok(at(hi)):
                    return None
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if ok(at(mid)):
                    hi = mid
                else:
                    lo = mid
            return hi

        zero_l = tuple(0 for _ in range(k))
        if ok(zero_l):
            return g.full(zero_l, current), True
        if k == 0:
            return None, True
        if k == 1:
            v = min_along(0, zero_l)
            return (None, True) if v is None else (g.full((v,), current), True)
        if k == 2:
            x0 = min_along(0, (0, g.lims[1]))
            if x0 is None:
                return None, True
            y0 = min_along(1, (x0, 0))
            if y0 is None:
                return None, True
            x, y = x0, y0
            best_xy = (x0, y0)
            while y > 0 and x < min(sum(best_xy), g.lims[0]):
                x += 1
                while y > 0 and ok((x, y - 1)):
                    y -= 1
                    if x + y <= sum(best_xy):  # ties: more designers, fewer chambers
                        best_xy = (x, y)
            # Greedy is not monotone in chambers, so the staircase (which starts at
            # the many-chambers corner) can miss a cheaper point on an axis. Probe
            # each axis from zero.
            cands = [best_xy]
            px = min_along(0, (0, 0))
            if px is not None:
                cands.append((px, 0))
            py = min_along(1, (0, 0))
            if py is not None:
                cands.append((0, py))
            best_xy = min(cands, key=lambda c: key_of(g, c))
            return g.full(best_xy, current), True

        # k >= 3: exhaustive by total while a level fits a third of the budget,
        # then climb from the analytic estimate and prune.
        spent = 0
        total = 1
        while total <= max(g.lims) * k:
            n_cmp = _n_compositions(total, k)
            if spent + n_cmp > cap // 3 or runs + n_cmp > cap:
                break
            level = sorted(
                (c for c in _compositions(total, k) if g.fits(c)),
                key=lambda c: (sum(c[g.n_des :]), tuple(-v for v in c)),
            )
            for local in level:
                if ok(local):
                    return g.full(local, current), True
            spent += n_cmp
            total += 1
        else:
            return None, False
        workings.append(
            f"{g.region}: total {total} has {_n_compositions(total, k)} combinations, too many "
            "for the run budget; climbing from the analytic estimate, then pruning."
        )
        cur = tuple(
            min(
                g.lims[j],
                (des_need if dims[i][0] == "designer" else lab_need).get(dims[i][1], 0),
            )
            for j, i in enumerate(g.idx)
        )
        while not ok(cur):
            nbrs = []
            for j in range(k):
                if cur[j] >= g.lims[j]:
                    continue
                nxt = cur[:j] + (cur[j] + 1,) + cur[j + 1 :]
                v2 = region_violators(g.full(nxt, current), g.region)
                late = cache[g.full(nxt, current)][2]
                nbrs.append(((len(v2), late, j), nxt))
            if not nbrs:
                return None, False
            cur = min(nbrs)[1]
        for j in range(k):
            while cur[j] > 0:
                trial = cur[:j] + (cur[j] - 1,) + cur[j + 1 :]
                if not ok(trial):
                    break
                cur = trial
        return g.full(cur, current), False

    def level_points(g: _Group, level: int) -> list[tuple[int, ...]]:
        return [c for c in _compositions(level, len(g.idx)) if g.fits(c)]

    def unchecked_below(g: _Group, best: tuple[int, ...]) -> int | None:
        """Combinations with a smaller total that were never simulated
        (None when there are too many to count cheaply)."""

        k = len(best)
        top = sum(best) - 1
        if top < 0:
            return 0
        if math.comb(top + k, k) > _MAX_POINTS_COUNTED:
            return None
        return sum(
            1 for lv in range(top + 1) for c in level_points(g, lv) if (g.region, c) not in gmemo
        )

    def polish(g: _Group, current: tuple[int, ...], run_limit: int) -> tuple[int, ...]:
        """Try the totals just below the group's answer, nearest first, while
        `runs < run_limit`; adopt any cheaper feasible point and repeat."""

        best = g.local_of(current)
        k = len(best)
        while sum(best) > 0:
            improved: tuple[int, ...] | None = None
            for level in range(sum(best) - 1, -1, -1):
                if math.comb(level + k - 1, k - 1) > _MAX_POINTS_COUNTED:
                    return g.full(best, current)

                def near(
                    c: tuple[int, ...], b: tuple[int, ...] = best
                ) -> tuple[int, tuple[int, ...]]:
                    return (sum(abs(p - q) for p, q in zip(c, b, strict=True)), c)

                pts = sorted(level_points(g, level), key=near)
                complete = True
                found: list[tuple[int, ...]] = []
                for c in pts:
                    if (g.region, c) not in gmemo and (runs >= run_limit or runs >= cap - 1):
                        complete = False
                        break
                    if feasible(g, c, current):
                        found.append(c)
                if found:
                    improved = min(found, key=lambda c: key_of(g, c))
                    break
                if not complete:
                    return g.full(best, current)
            if improved is None:
                break
            best = improved
            current = g.full(best, current)
        return g.full(best, current)

    capped = False
    zero = tuple(0 for _ in dims)
    current = zero
    solved: list[str] = []
    try:
        _, vio0, _ = evaluate(zero)
        workings.append(f"0 additions: {len(vio0)} project(s) violate the target.")
        if vio0 and not dims:
            workings.append("No designer or chamber pool to extend for this scenario.")
        if vio0:
            for region in groups:
                g = gobjs[region]
                if not region_violators(current, region):
                    continue
                found, _ = solve_group(g, current)
                if found is not None:
                    current = found
                    solved.append(region)
                workings.append(
                    f"{region}: "
                    + (
                        "no addition within the per-pool limit meets the target."
                        if found is None
                        else f"smallest additions found, {sum(found[i] for i in g.idx)} unit(s)."
                    )
                )
            # Phase 2: polish each solved region with the budget left (cheapest
            # verification first, fair share of the remaining runs).
            order = sorted(
                solved,
                key=lambda r: (
                    unchecked_below(gobjs[r], gobjs[r].local_of(current)) or 10**9,
                    r,
                ),
            )
            for n_left, region in zip(range(len(order), 0, -1), order, strict=True):
                spare = max(0, cap - 1 - runs)
                current = polish(gobjs[region], current, runs + spare // n_left)
            evaluate(current)  # the combined recommendation (usually cached)
    except _RunCapReached:
        capped = True

    def rank(units: tuple[int, ...]) -> tuple[int, int, tuple[int, ...]]:
        n_des_all = sum(1 for kind, _ in dims if kind == "designer")
        return (sum(units), sum(units[n_des_all:]), units)

    feas = [u for u in cache if not cache[u][1]]
    if feas:
        best = min(feas, key=rank)
    else:
        best = min(cache, key=lambda u: (len(cache[u][1]), cache[u][2], *rank(u)))
    met = bool(feas)

    # Monotonicity audit: more of everything must never turn a pass into a fail.
    nonmono = 0
    for region in groups:
        for u in cache:
            if region_violators(u, region):
                continue
            for v in cache:
                if all(a <= b for a, b in zip(u, v, strict=True)) and region_violators(v, region):
                    nonmono += 1
    if nonmono:
        workings.append(
            f"Note: {nonmono} evaluated pair(s) are not monotone (a larger addition scored "
            'worse), so "more capacity never hurts" does not hold everywhere on this plan.'
        )

    # Verification: exact only if every smaller combination was simulated and failed.
    unchecked_total: int | None = 0
    if met:
        for region in groups:
            g = gobjs[region]
            n_unchecked = unchecked_below(g, g.local_of(best))
            if n_unchecked is None:
                unchecked_total = None
                break
            unchecked_total = (unchecked_total or 0) + n_unchecked
    exact = met and not capped and unchecked_total == 0
    if met and not exact and not capped:
        left = "some" if unchecked_total is None else str(unchecked_total)
        workings.append(
            "Minimum under the assumption that more capacity never hurts: the answer is the "
            "smallest found, and the smaller combinations that could beat it were checked as far "
            f"as the {cap}-run cap allows ({left} smaller combination(s) not simulated)."
        )
    if met and (
        sum(ae.count for ae in scenario.add_engineers) + sum(best[: len(designer_hubs)])
        > MAX_ADDED_DESIGNERS_TOTAL
        or sum(ac.count for ac in scenario.add_chambers) + sum(best[len(designer_hubs) :])
        > MAX_ADDED_CHAMBERS_TOTAL
    ):
        workings.append(
            "Note: scenario plus recommended additions exceed the scenario size caps "
            f"({MAX_ADDED_DESIGNERS_TOTAL} designers, {MAX_ADDED_CHAMBERS_TOTAL} chambers), "
            "so the combined scenario cannot be simulated in one request."
        )
    res, vio, _ = cache[best]
    a = Additions(
        designers=tuple(
            (k, n) for (kind, k), n in zip(dims, best, strict=True) if kind == "designer" and n > 0
        ),
        chambers=tuple(
            (k, n) for (kind, k), n in zip(dims, best, strict=True) if kind == "chamber" and n > 0
        ),
    )
    unattainable = (
        tuple(r.project_id for r in res.projects if r.is_new and r.project_id in unattainable_ids)
        if target == "all_new_within_year"
        else ()
    )
    workings.append(
        f"Result: {'target met' if met else 'target NOT met'} with {a.total} addition(s) after "
        f"{runs} greedy run(s)" + (" (run cap reached)." if capped else ".")
    )
    if unattainable:
        workings.append(
            f"{len(unattainable)} added project(s) cannot finish by W{dc.WITHIN_YEAR_WEEK} even "
            "with unlimited designers and chambers (their lead-time critical path, at the "
            "fastest designer FTE available, alone ends later); they are excluded from the "
            "search."
        )
    return MinimumAdditionsResult(
        target=target,
        met=met and not unattainable,
        met_attainable=met,
        unattainable_project_ids=unattainable,
        capped=capped,
        exact=exact,
        additions=a,
        achieved=res,
        unmet_project_ids=vio,
        runs_used=runs,
        run_cap=cap,
        searched_designer_hubs=designer_hubs,
        searched_chamber_regions=chamber_regions,
        workings=tuple(workings),
    )


#: Largest number of lattice points polish / verification will enumerate per level or in total.
_MAX_POINTS_COUNTED: int = 4000


class _RunCapReached(Exception):
    """Internal: the greedy-run budget is spent."""


# =====================================================================================
# JSON-friendly view
# =====================================================================================


def to_jsonable(obj: object) -> object:
    """Recursively turn a result dataclass into plain dicts / lists / scalars."""

    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: to_jsonable(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, Mapping):
        return {str(k): to_jsonable(v) for k, v in sorted(obj.items(), key=lambda kv: str(kv[0]))}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    return obj
