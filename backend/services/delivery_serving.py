"""Serve the delivery-by-year table and the long-tail warnings (P53-T03,
ADR 0063 R53-3 / R53-9, I59 / I63, docs/API_CONTRACT_P53.md §4).

Every surface goes through `to_wire(scheduling.delivery.delivery_by_year(...))`
over its own (hub-scoped, filtered) rows, so Dashboard, Executive, export,
What-if and plan import serve the same function's output (I59). A pre-P53
run is served `null` with `pre_p53_run`; its band column is NULL and is
never filled from the live band (R53-3).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.enums import WorkflowStepKind
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from scheduling.delivery import (
    DELIVERY_BANDS,
    BandCounts,
    DeliveryByYear,
    DeliveryRow,
    LeaderTail,
    delivery_by_year,
    far_finish,
    leader_tails,
    left_out_reason,
)
from scheduling.weeks import PLAN_YEAR_WEEKS, year_end, year_of
from schemas.delivery import (
    DeliveryByYearOut,
    DeliveryRowOut,
    LeftOutReasonCounts,
    TailWarningsOut,
)
from services.active_run import step_kinds_for_run
from services.priority_applicability import effective_priority

#: R53-2 copy of a `beyond_horizon` row.
BEYOND_HORIZON_COPY = "Cannot be scheduled within {n} years — check resources"


def horizon_years_of(run_week: int, horizon_weeks: int) -> int | None:
    span = horizon_weeks - run_week
    if span > 0 and span % PLAN_YEAR_WEEKS == 0:
        return span // PLAN_YEAR_WEEKS
    return None


def left_out_reason_label(
    reason: str | None, *, no_chamber_step_id: str | None, horizon_years: int | None
) -> str | None:
    """P58: a served not-placed reason in words (the frontend's
    `lib/left-out-reason.ts` copy, with the step named for `no_chamber`).
    `None` for a placed project."""

    if reason is None:
        return None
    if reason == "no_leader":
        return "No leader assigned"
    if reason == "no_chamber":
        if no_chamber_step_id:
            return f"No lab chamber accepts step {no_chamber_step_id}"
        return "No lab chamber can run a lab step"
    if reason == "data_error":
        return "Data error — check the project setup"
    if horizon_years is None:
        return "Cannot be scheduled within the search limit — check resources"
    unit = "year" if horizon_years == 1 else "years"
    return f"Cannot be scheduled within {horizon_years} {unit} — check resources"


def _band_cells(c: BandCounts) -> dict[str, int]:
    return {"p1": c.p1, "p2": c.p2, "p3": c.p3, "other": c.other, "total": c.total}


def _no_cum() -> dict[str, None]:
    return {"cum_p1": None, "cum_p2": None, "cum_p3": None, "cum_other": None, "cum_total": None}


def to_wire(
    table: DeliveryByYear,
    *,
    run_week: int,
    within_year_week: int,
    horizon_weeks: int,
) -> DeliveryByYearOut:
    n = horizon_years_of(run_week, horizon_weeks)
    rows: list[DeliveryRowOut] = []
    for y in table.years:
        rows.append(
            DeliveryRowOut(
                kind="by_end_of_year" if y.is_plan_year else "year",
                year=y.year,
                label=f"By end of {y.year}" if y.is_plan_year else str(y.year),
                indicative=y.indicative,
                **_band_cells(y.counts),
                cum_p1=y.cumulative.p1,
                cum_p2=y.cumulative.p2,
                cum_p3=y.cumulative.p3,
                cum_other=y.cumulative.other,
                cum_total=y.cumulative.total,
            )
        )
    reasons = {k: v.total for k, v in table.not_placed_by_reason.items()}
    rows.append(
        DeliveryRowOut(
            kind="not_placed",
            year=None,
            label=f"Not placed within {n} years" if n is not None else "Not placed",
            indicative=False,
            **_band_cells(table.not_placed),
            **_no_cum(),
            left_out_reasons=LeftOutReasonCounts(
                no_leader=reasons.get("no_leader", 0),
                no_chamber=reasons.get("no_chamber", 0),
                data_error=reasons.get("data_error", 0),
                beyond_horizon=reasons.get("beyond_horizon", 0),
            ),
        )
    )
    rows.append(
        DeliveryRowOut(
            kind="blocked",
            year=None,
            label="Blocked",
            indicative=False,
            **_band_cells(table.blocked),
            **_no_cum(),
        )
    )
    return DeliveryByYearOut(
        run_week=run_week,
        base_year=table.plan_year,
        within_year_week=within_year_week,
        horizon_weeks=horizon_weeks,
        horizon_years=n,
        rows=rows,
    )


# --- stored runs ---------------------------------------------------------------------


def stored_row(o: ScheduleRunProjectOutcome, status: object = None) -> DeliveryRow:
    """ADR 0067: with the project's (live) `status`, a Commercialized /
    Cancelled row has no band and is counted under Other."""

    return DeliveryRow(
        project_id=str(o.project_id),
        priority=effective_priority(status, o.priority_at_run),
        counts_toward_year=o.counts_toward_year,
        not_scheduled_priority=o.not_scheduled_priority,
        blocked=o.blocked,
        within_year=o.within_year,
        spillover=o.spillover,
        left_out=o.left_out,
        completion_week=o.projected_end_week,
        left_out_reason=o.left_out_reason,
    )


def is_p53_run(run: ScheduleRun) -> bool:
    return run.rules_epoch is not None


def stored_delivery(
    run: ScheduleRun,
    outcomes: Iterable[ScheduleRunProjectOutcome],
    statuses: Mapping[uuid.UUID, object] | None = None,
) -> DeliveryByYearOut | None:
    """The table over the given (already scoped and filtered) stored rows of
    `run`; None for a pre-P53 run (`pre_p53_run`, R53-3). `statuses` (project
    id → live status) applies ADR 0067: a Commercialized / Cancelled row is
    counted under Other, never P1/P2/P3."""

    if not is_p53_run(run):
        return None
    status_of = statuses or {}
    table = delivery_by_year(
        [stored_row(o, status_of.get(o.project_id)) for o in outcomes],
        run_week=run.current_week,
    )
    return to_wire(
        table,
        run_week=run.current_week,
        within_year_week=year_end(year_of(run.current_week)),
        horizon_weeks=run.horizon_weeks,
    )


def delivery_year_of(o: ScheduleRunProjectOutcome, run_week: int) -> int | None:
    """The year row a stored counting outcome lands in (None when it is not
    listed by year: not counting, blocked, not placed)."""

    if o.not_scheduled_priority or not o.counts_toward_year or o.blocked:
        return None
    if not (o.within_year or o.spillover):
        return None
    y0 = year_of(run_week)
    if o.projected_end_week is None or o.projected_end_week < 1:
        return y0
    return max(y0, year_of(o.projected_end_week))


def stored_far_finish(o: ScheduleRunProjectOutcome, run_week: int) -> bool:
    return far_finish(
        scheduled=o.projected_end_week is not None and not o.blocked and not o.left_out,
        completion_week=o.projected_end_week,
        run_week=run_week,
    )


def stored_left_out_reason(o: ScheduleRunProjectOutcome, run: ScheduleRun) -> str | None:
    """The stored reason of a P53 run. A pre-P53 run kept no diagnostics and
    searched only 78 weeks, so "beyond the search limit" would be wrong for
    it: its reason is served as null (P53-R01, workflow-auditor A1)."""

    if not is_p53_run(run):
        return None
    return o.left_out_reason


# --- R53-9: leader tails of a stored run (I63) -----------------------------------------


async def run_leader_tails(
    db: AsyncSession, run: ScheduleRun
) -> tuple[dict[uuid.UUID, LeaderTail], dict[uuid.UUID, uuid.UUID]]:
    """Every leader engineer's tail in `run`, from its stored rows only.

    A project's leader is the engineer on its latest booked design row (the
    stored run has no other leader record); the tail is the last week of
    that engineer's booked design rows. Engineer-level (OQ #8): callers serve
    it only where engineer utilisation is already served, else counts only.
    """

    kinds = await step_kinds_for_run(db, run)
    steps = (
        await db.execute(
            select(
                ScheduleRunProjectStep.project_id,
                ScheduleRunProjectStep.step_template_id,
                ScheduleRunProjectStep.assigned_engineer_id,
                ScheduleRunProjectStep.end_week,
                ScheduleRunProjectStep.skipped,
            ).where(
                ScheduleRunProjectStep.schedule_run_id == run.id,
                ScheduleRunProjectStep.assigned_engineer_id.is_not(None),
            )
        )
    ).all()
    design_rows: list[tuple[str, int]] = []
    latest: dict[uuid.UUID, tuple[int, uuid.UUID]] = {}
    for pid, step_id, eid, end_week, skipped in steps:
        if skipped or eid is None or kinds.get(step_id) != WorkflowStepKind.DESIGN:
            continue
        design_rows.append((str(eid), end_week))
        if pid not in latest or end_week > latest[pid][0]:
            latest[pid] = (end_week, eid)
    outcomes = (
        (
            await db.execute(
                select(ScheduleRunProjectOutcome).where(
                    ScheduleRunProjectOutcome.schedule_run_id == run.id
                )
            )
        )
        .scalars()
        .all()
    )
    far = [str(o.project_id) for o in outcomes if stored_far_finish(o, run.current_week)]
    tails = leader_tails(
        run_week=run.current_week,
        design_rows=design_rows,
        project_leaders=[(str(pid), str(v[1])) for pid, v in latest.items()],
        far_finish_project_ids=far,
    )
    return (
        {uuid.UUID(t.engineer_id): t for t in tails},
        {pid: v[1] for pid, v in latest.items()},
    )


async def tail_warning_counts(
    db: AsyncSession,
    run: ScheduleRun,
    outcomes: Sequence[ScheduleRunProjectOutcome],
) -> TailWarningsOut | None:
    """Dashboard / Executive counts (R53-9): `far_finish` projects among the
    given (scoped, filtered) rows and overloaded leaders among the leaders of
    those projects. No names. None for a pre-P53 run."""

    if not is_p53_run(run):
        return None
    tails, leader_of = await run_leader_tails(db, run)
    scoped_leaders = {leader_of[o.project_id] for o in outcomes if o.project_id in leader_of}
    return TailWarningsOut(
        far_finish_count=sum(1 for o in outcomes if stored_far_finish(o, run.current_week)),
        leader_overloaded_count=sum(
            1 for eid, t in tails.items() if t.overloaded and eid in scoped_leaders
        ),
    )


# --- in-memory results (What-if, plan import) ----------------------------------------


def result_row(
    *,
    project_id: str,
    priority: str | None,
    outcome: str,
    within_year: bool,
    finish_week: int | None,
    counts_toward_year: bool,
    not_scheduled_priority: bool,
    no_leader: bool = False,
    no_chamber_step_id: str | None = None,
    data_error: str | None = None,
    left_out: bool | None = None,
    status: object = None,
) -> DeliveryRow:
    """A `DeliveryRow` from a What-if / import project result (outcome class
    + flags). `left_out`, when given, is the engine's raw LEFT_OUT flag (as
    stored on a run's outcome row). `within_year` is the Dashboard bucket
    (I9), so a Commercialized project delivered in Y0 (class `excluded`)
    lands in Y0."""

    # P53-R01: the engine's raw flag when given (the outcome class ranks
    # `data_error` above `left_out`, so the class alone can hide it).
    if left_out is None:
        left_out = outcome == "left_out"
    blocked = outcome == "blocked"
    return DeliveryRow(
        project_id=project_id,
        # ADR 0067: no band for a Commercialized / Cancelled project.
        priority=effective_priority(status, priority),
        counts_toward_year=counts_toward_year,
        not_scheduled_priority=not_scheduled_priority,
        blocked=blocked,
        within_year=within_year and not blocked,
        spillover=outcome == "spillover",
        left_out=left_out,
        completion_week=finish_week,
        left_out_reason=left_out_reason(
            left_out=left_out,
            no_leader=no_leader,
            no_chamber_step_id=no_chamber_step_id,
            data_error=data_error,
        ),
    )


def result_delivery(
    rows: Sequence[DeliveryRow],
    *,
    run_week: int,
    within_year_week: int,
    horizon_weeks: int,
) -> DeliveryByYearOut:
    return to_wire(
        delivery_by_year(rows, run_week=run_week),
        run_week=run_week,
        within_year_week=within_year_week,
        horizon_weeks=horizon_weeks,
    )


__all__ = [
    "BEYOND_HORIZON_COPY",
    "run_leader_tails",
    "tail_warning_counts",
    "DELIVERY_BANDS",
    "delivery_year_of",
    "horizon_years_of",
    "is_p53_run",
    "left_out_reason_label",
    "result_delivery",
    "result_row",
    "stored_delivery",
    "stored_far_finish",
    "stored_left_out_reason",
    "stored_row",
    "to_wire",
]
