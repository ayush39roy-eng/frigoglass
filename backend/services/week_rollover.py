"""The weekly rollover run (P37-T05, built at P53-T03 on the absolute week;
DOMAIN_RULES "Weekly rollover run" as amended by R53-1, R37-6..R37-9, I39).

`ensure_week_rollover(db)` is idempotent and is called by the in-app ticker
(`start_rollover_ticker`, every 5 minutes, `RPD_WEEK_ROLLOVER_TICKER`) and by
Celery beat (`workers.week_rollover_tasks`, every 15 minutes plus Mondays
00:05 Europe/Athens). Under the dispatch advisory lock it decides from state
on every tick (R37-8):

- `not_needed`: no active run (R37-7); or the active run's week == the
  calendar week; or a run in flight is already at the calendar week (R37-6:
  equality, never "<"). There is no closed-year branch (R53-1): on 4 Jan 2027
  the week reads 53 and the plan simply moves on.
- `deferred`: a run at another week is in flight → the one coalesced
  follow-up (ADR 0023), whose row reads the week when it is created; or the
  next retry is not yet 30 minutes after the last attempt.
- `queued`: one greedy run, `activate=True`, `trigger_reason="week_rollover"`,
  system actor (no user), audit `schedule.week_rollover`. Never CP-SAT, never
  sets `schedule_stale`.
- `failed`: 3 queued attempts this week already ended FAILED /
  DISPATCH_FAILED / ABANDONED (R37-8). `/me.plan_week.status` then answers
  `failed`.

`plan_week_rollovers` is keyed by the absolute week; `plan_year =
year_of(week)`. Only queued attempts count. A row and an audit row are
written only when the week's recorded outcome changes, so a quiet week
writes nothing.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from models.audit import AuditLogEntry
from models.enums import ScheduleRunStatus, SolverType
from models.plan_week_rollover import PlanWeekRollover
from models.schedule import ScheduleRun
from scheduling.weeks import year_of
from services import plan_clock
from services.active_run import get_active_run
from services.run_dispatch import (
    _set_follow_up,
    dispatch_greedy,
    enqueue_or_fail,
    find_in_flight_run,
)
from services.schedule_persistence import create_queued_schedule_run
from workers.progress import publish_progress_best_effort as publish_progress

logger = logging.getLogger(__name__)

RolloverOutcome = Literal["queued", "deferred", "not_needed", "failed"]

TRIGGER_REASON = "week_rollover"
AUDIT_ACTION = "schedule.week_rollover"
MAX_ATTEMPTS = 3
RETRY_SPACING = timedelta(minutes=30)
#: R37-9: the in-app ticker's period and jitter.
TICKER_PERIOD_SECONDS = 300.0
TICKER_JITTER_SECONDS = 30.0
TICKER_ENV = "RPD_WEEK_ROLLOVER_TICKER"


def ticker_enabled() -> bool:
    """`RPD_WEEK_ROLLOVER_TICKER` (default true; both test suites set false)."""

    raw = os.environ.get(TICKER_ENV, "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


async def _record(
    db: AsyncSession,
    *,
    row: PlanWeekRollover | None,
    week: int,
    from_week: int | None,
    outcome: RolloverOutcome,
    run_id: uuid.UUID | None = None,
    attempt: bool = False,
) -> PlanWeekRollover:
    """Upsert the week's row and write one audit row for the change."""

    now = datetime.now(UTC)
    if row is None:
        row = PlanWeekRollover(week=week, plan_year=year_of(week), attempts=0, status=outcome)
        db.add(row)
    if attempt:
        row.attempts += 1
        row.last_attempt_at = now
    if run_id is not None:
        row.last_run_id = run_id
    row.status = outcome
    row.updated_at = now
    db.add(
        AuditLogEntry(
            actor_user_id=None,
            action=AUDIT_ACTION,
            entity_type="PlanWeekRollover",
            entity_id=str(week),
            hub_id=None,
            before_state=None,
            after_state={
                "from_week": from_week,
                "to_week": week,
                "outcome": outcome,
                "attempt": row.attempts,
            },
        )
    )
    await db.flush()
    return row


async def _last_attempt_failed(db: AsyncSession, row: PlanWeekRollover) -> bool:
    if row.last_run_id is None:
        return True
    status = (
        await db.execute(select(ScheduleRun.status).where(ScheduleRun.id == row.last_run_id))
    ).scalar_one_or_none()
    return status in (None, ScheduleRunStatus.FAILED, ScheduleRunStatus.CANCELLED)


async def ensure_week_rollover(db: AsyncSession) -> RolloverOutcome:
    """One decision (see module docstring). Always ends its transaction."""

    week = plan_clock.current_week()
    in_flight_id = await find_in_flight_run(db, request_follow_up=False)  # takes the lock
    active = await get_active_run(db)
    if active is None or active.current_week == week:
        await db.rollback()
        return "not_needed"
    from_week = active.current_week
    row = await db.get(PlanWeekRollover, week, with_for_update=True)

    if in_flight_id is not None:
        in_flight_week = (
            await db.execute(select(ScheduleRun.current_week).where(ScheduleRun.id == in_flight_id))
        ).scalar_one()
        if in_flight_week == week:
            await db.rollback()
            return "not_needed"
        await _set_follow_up(db, TRIGGER_REASON)
        if row is None or row.status != "deferred":
            await _record(db, row=row, week=week, from_week=from_week, outcome="deferred")
        await db.commit()
        return "deferred"

    if row is not None and row.attempts > 0:
        if row.attempts >= MAX_ATTEMPTS:
            # The budget is spent: never a 4th attempt this week (R37-8).
            if not await _last_attempt_failed(db, row):
                await db.rollback()
                return "deferred"
            if row.status != "failed":
                await _record(db, row=row, week=week, from_week=from_week, outcome="failed")
                await db.commit()
            else:
                await db.rollback()
            return "failed"
        last = row.last_attempt_at
        if last is not None and datetime.now(UTC) - last < RETRY_SPACING:
            await db.rollback()
            return "deferred"

    # Queue the greedy rollover run. `create_queued_schedule_run` commits the
    # QUEUED row together with this week's attempt (releasing the lock).
    row = await _record(db, row=row, week=week, from_week=from_week, outcome="queued", attempt=True)
    run = await create_queued_schedule_run(
        db,
        solver_type=SolverType.GREEDY,
        trigger_reason=TRIGGER_REASON,
        triggered_by_user_id=None,
        current_week=week,
    )
    row.last_run_id = run.id
    db.add(row)
    task_id = await enqueue_or_fail(
        db,
        run,
        lambda: dispatch_greedy(
            str(run.id),
            db=db,
            triggered_by_user_id=None,
            activate=True,
            recalc_project_id=None,
        ),
        actor_user_id=None,
    )
    if task_id is not None:
        run.celery_task_id = task_id
        db.add(run)
    await db.commit()
    if task_id is not None:
        publish_progress(str(run.id), status="queued")
    return "queued"


async def rollover_failed_for_week(db: AsyncSession, week: int) -> bool:
    """`/me.plan_week.status == "failed"` (R37-8)."""

    status = (
        await db.execute(select(PlanWeekRollover.status).where(PlanWeekRollover.week == week))
    ).scalar_one_or_none()
    return status == "failed"


# --- R37-9: the in-app ticker --------------------------------------------------------


async def _tick(session_factory: async_sessionmaker[AsyncSession]) -> None:
    try:
        async with session_factory() as db:
            outcome = await ensure_week_rollover(db)
        if outcome != "not_needed":
            logger.info("week rollover tick: %s", outcome)
    except Exception:  # noqa: BLE001 - a tick never takes the API down
        logger.exception("week rollover tick failed")


async def run_rollover_ticker(
    session_factory: async_sessionmaker[AsyncSession], stop: asyncio.Event
) -> None:
    """Every `TICKER_PERIOD_SECONDS` (+ jitter) until `stop` is set."""

    while not stop.is_set():
        await _tick(session_factory)
        delay = TICKER_PERIOD_SECONDS + random.uniform(0, TICKER_JITTER_SECONDS)  # noqa: S311
        try:
            await asyncio.wait_for(stop.wait(), timeout=delay)
        except TimeoutError:
            continue
