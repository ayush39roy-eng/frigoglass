"""Delivery by year, LEFT_OUT reasons and the long-tail warnings (ADR 0063 as
ruled at R53-2 / R53-3 / R53-9, invariants I58 / I59 / I63).

Pure functions over plain rows. The services build `DeliveryRow`s from the
STORED outcome rows of a run (band = `priority_at_run`) and serve the result
as is; the browser derives nothing (I59). Nothing in this module is a
scheduler input: the flags are computed from a finished run only (I63).

Row precedence is the stored-outcome bucket precedence (R42-6, I53), so the
first row equals the Dashboard within-year count::

    not counting (queued tier on pre-P53 rows, P4/Q)  -> never listed
    blocked                                           -> the "blocked" line
    within_year / spillover (scheduled)               -> year_of(completion), floor Y0
    left_out                                          -> "not placed", by reason
    anything else (data error, On Hold, ...)          -> never listed

A status-excluded project with `within_year` (Commercialized delivered in Y0,
R53-2b) is in the Y0 row. Its band can be P4 / Q / none, so the table has an
`other` column next to P1 / P2 / P3: `p1 + p2 + p3 + other = total` in every
row (`other` is 0 whenever no such project exists).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from scheduling.types import ProjectScheduleOutcome, ScheduleInput, ScheduleOutput
from scheduling.weeks import year_end, year_of

#: R53-2: served `left_out_reason` values.
LEFT_OUT_REASONS: tuple[str, ...] = ("no_leader", "no_chamber", "data_error", "beyond_horizon")
#: The P1 / P2 / P3 columns; any other band goes to `other`.
DELIVERY_BANDS: tuple[str, ...] = ("P1", "P2", "P3")


def left_out_reason(
    *,
    left_out: bool,
    no_leader: bool,
    no_chamber_step_id: str | None,
    data_error: str | None,
) -> str | None:
    """R53-2 / I58: the served reason of a not-placed outcome, derived from
    the stored row. `None` when the row is placed (not LEFT_OUT and no data
    error). `beyond_horizon` = LEFT_OUT with none of the three diagnostics
    (copy: "Cannot be scheduled within {N} years — check resources")."""

    if no_leader and left_out:
        return "no_leader"
    if no_chamber_step_id is not None and left_out:
        return "no_chamber"
    if data_error is not None:
        return "data_error"
    if left_out:
        return "beyond_horizon"
    return None


def outcome_left_out_reason(outcome: ProjectScheduleOutcome) -> str | None:
    """`left_out_reason` of a scheduler outcome."""

    return left_out_reason(
        left_out=outcome.left_out,
        no_leader=outcome.no_leader,
        no_chamber_step_id=outcome.no_chamber_step_id,
        data_error=outcome.data_error,
    )


def far_finish(*, scheduled: bool, completion_week: int | None, run_week: int) -> bool:
    """R53-9: `far_finish = scheduled ∧ year_of(completion) > Y0 + 1` (the
    "indicative" boundary). A warning only (I63)."""

    if not scheduled or completion_week is None or completion_week < 1:
        return False
    return year_of(completion_week) > year_of(run_week) + 1


@dataclass(frozen=True)
class DeliveryRow:
    """One stored outcome row as the delivery table needs it.

    `priority` is the band in the run input (`priority_at_run`).
    `completion_week` is `last_step_end_week + delay_weeks_applied`
    (`projected_end_week`), `None` when not scheduled."""

    project_id: str
    priority: str | None
    counts_toward_year: bool
    not_scheduled_priority: bool
    blocked: bool
    within_year: bool
    spillover: bool
    left_out: bool
    completion_week: int | None
    left_out_reason: str | None = None


@dataclass(frozen=True)
class BandCounts:
    """Counts and the sorted project ids per band column."""

    p1: int
    p2: int
    p3: int
    other: int
    total: int
    project_ids: Mapping[str, tuple[str, ...]]  # "P1" | "P2" | "P3" | "other" -> ids


@dataclass(frozen=True)
class DeliveryYear:
    """One year row: "By end of Y0" (`is_plan_year`) or a later year."""

    year: int
    is_plan_year: bool
    indicative: bool  # year > Y0 + 1
    counts: BandCounts
    cumulative: BandCounts  # running sum from Y0 to this year (ids omitted: {})


@dataclass(frozen=True)
class DeliveryByYear:
    """The served table (R53-3)."""

    plan_year: int  # Y0
    years: tuple[DeliveryYear, ...]  # Y0 .. largest year present, contiguous
    not_placed: BandCounts
    not_placed_by_reason: Mapping[str, BandCounts]  # every LEFT_OUT_REASONS key
    blocked: BandCounts


def _band_key(priority: str | None) -> str:
    return priority if priority in DELIVERY_BANDS else "other"


def _counts(rows: Iterable[DeliveryRow]) -> BandCounts:
    ids: dict[str, list[str]] = {"P1": [], "P2": [], "P3": [], "other": []}
    for r in rows:
        ids[_band_key(r.priority)].append(r.project_id)
    frozen_ids = {k: tuple(sorted(v)) for k, v in ids.items()}
    p1, p2, p3, other = (len(frozen_ids[k]) for k in ("P1", "P2", "P3", "other"))
    return BandCounts(
        p1=p1, p2=p2, p3=p3, other=other, total=p1 + p2 + p3 + other, project_ids=frozen_ids
    )


def _add(a: BandCounts, b: BandCounts) -> BandCounts:
    return BandCounts(
        p1=a.p1 + b.p1,
        p2=a.p2 + b.p2,
        p3=a.p3 + b.p3,
        other=a.other + b.other,
        total=a.total + b.total,
        project_ids={},
    )


_ZERO = BandCounts(p1=0, p2=0, p3=0, other=0, total=0, project_ids={})


def delivery_row_of(outcome: ProjectScheduleOutcome, priority: str | None) -> DeliveryRow:
    """A `DeliveryRow` from a scheduler outcome and its input band."""

    return DeliveryRow(
        project_id=outcome.project_id,
        priority=priority,
        counts_toward_year=outcome.counts_toward_year,
        not_scheduled_priority=outcome.not_scheduled_priority,
        blocked=outcome.blocked,
        within_year=outcome.within_year,
        spillover=outcome.spillover,
        left_out=outcome.left_out,
        completion_week=outcome.projected_end_week,
        left_out_reason=outcome_left_out_reason(outcome),
    )


def delivery_rows(schedule_input: ScheduleInput, output: ScheduleOutput) -> tuple[DeliveryRow, ...]:
    """`DeliveryRow`s of a run held in memory (What-if, import, tests); the
    band is the run input's priority."""

    band = {p.project_id: p.priority for p in schedule_input.projects}
    return tuple(delivery_row_of(o, band.get(o.project_id)) for o in output.project_outcomes)


def delivery_by_year(rows: Iterable[DeliveryRow], *, run_week: int) -> DeliveryByYear:
    """R53-3 / I59: the delivery table of one run. `run_week` is the run's
    `current_week` (What-if / import: the input week); Y0 = `year_of(run_week)`.

    Rows are calendar years whatever the run's within-year cut-off is: a
    scheduled counting row lands in `max(Y0, year_of(completion))`; a
    status-excluded `within_year` row (Commercialized delivered in Y0) in Y0.
    For a live run (`within_year_week = year_end(Y0)`) the Y0 row is exactly
    the WITHIN_YEAR bucket and the later rows the SPILLOVER bucket."""

    y0 = year_of(run_week)
    by_year: dict[int, list[DeliveryRow]] = {y0: []}
    blocked: list[DeliveryRow] = []
    not_placed: list[DeliveryRow] = []
    for r in sorted(rows, key=lambda x: x.project_id):
        if r.not_scheduled_priority or not r.counts_toward_year:
            continue
        if r.blocked:
            blocked.append(r)
        elif r.within_year or r.spillover:
            if r.completion_week is None or r.completion_week < 1:
                year = y0  # status-excluded within_year (Commercialized, R53-2b)
            else:
                year = max(y0, year_of(r.completion_week))
            by_year.setdefault(year, []).append(r)
        elif r.left_out:
            not_placed.append(r)

    years: list[DeliveryYear] = []
    running = _ZERO
    for year in range(y0, max(by_year) + 1):
        counts = _counts(by_year.get(year, ()))
        running = _add(running, counts)
        years.append(
            DeliveryYear(
                year=year,
                is_plan_year=year == y0,
                indicative=year > y0 + 1,
                counts=counts,
                cumulative=running,
            )
        )

    by_reason = {
        reason: _counts(r for r in not_placed if (r.left_out_reason or "beyond_horizon") == reason)
        for reason in LEFT_OUT_REASONS
    }
    return DeliveryByYear(
        plan_year=y0,
        years=tuple(years),
        not_placed=_counts(not_placed),
        not_placed_by_reason=by_reason,
        blocked=_counts(blocked),
    )


# --- R53-9: long single-leader tails ------------------------------------------


@dataclass(frozen=True)
class LeaderTail:
    """R53-9: one leader engineer's tail. Engineer-level (GDPR, OQ #8): served
    only where engineer utilisation is already served."""

    engineer_id: str
    leader_tail_week: int  # last week of their booked design rows
    overloaded: bool  # leader_tail_week > year_end(Y0 + 1)
    far_finish_projects: int  # far_finish projects they lead


def leader_tails(
    *,
    run_week: int,
    design_rows: Iterable[tuple[str, int]],
    project_leaders: Iterable[tuple[str, str | None]],
    far_finish_project_ids: Iterable[str],
) -> tuple[LeaderTail, ...]:
    """R53-9 / I63, from a run's stored rows only.

    - `design_rows`: `(engineer_id, end_week)` of every booked (non-skipped)
      design row of the run;
    - `project_leaders`: `(project_id, leader_engineer_id)` of the run's
      projects; a leader engineer is one that leads at least one of them;
    - `far_finish_project_ids`: the run's `far_finish` projects.

    Returns one entry per leader engineer with at least one booked design
    row, sorted by `engineer_id`."""

    tail: dict[str, int] = {}
    for engineer_id, end_week in design_rows:
        if end_week > tail.get(engineer_id, 0):
            tail[engineer_id] = end_week
    leads: dict[str, str] = {pid: lid for pid, lid in project_leaders if lid is not None}
    leaders = set(leads.values())
    far: dict[str, int] = {}
    for pid in set(far_finish_project_ids):
        lid = leads.get(pid)
        if lid is not None:
            far[lid] = far.get(lid, 0) + 1
    limit = year_end(year_of(run_week) + 1)
    return tuple(
        LeaderTail(
            engineer_id=eid,
            leader_tail_week=tail[eid],
            overloaded=tail[eid] > limit,
            far_finish_projects=far.get(eid, 0),
        )
        for eid in sorted(leaders)
        if eid in tail
    )


def tail_flags(
    schedule_input: ScheduleInput, output: ScheduleOutput
) -> tuple[frozenset[str], tuple[LeaderTail, ...]]:
    """R53-9 over a run held in memory: `(far_finish project ids, leader
    tails)`. Reads the output only; never feeds a solver (I63)."""

    run_week = schedule_input.current_week
    far = frozenset(
        o.project_id
        for o in output.project_outcomes
        if far_finish(
            scheduled=o.projected_end_week is not None and not o.blocked,
            completion_week=o.projected_end_week,
            run_week=run_week,
        )
    )
    design_rows = [
        (s.assigned_engineer_id, s.end_week)
        for o in output.project_outcomes
        for s in o.steps
        if s.kind == "design" and not s.skipped and s.assigned_engineer_id is not None
    ]
    leaders = [(p.project_id, p.leader_engineer_id) for p in schedule_input.projects]
    return far, leader_tails(
        run_week=run_week,
        design_rows=design_rows,
        project_leaders=leaders,
        far_finish_project_ids=far,
    )


__all__ = [
    "DELIVERY_BANDS",
    "LEFT_OUT_REASONS",
    "BandCounts",
    "DeliveryByYear",
    "DeliveryRow",
    "DeliveryYear",
    "LeaderTail",
    "delivery_by_year",
    "delivery_row_of",
    "delivery_rows",
    "far_finish",
    "leader_tails",
    "left_out_reason",
    "outcome_left_out_reason",
    "tail_flags",
]
