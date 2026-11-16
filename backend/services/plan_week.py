"""`GET /me.plan_week` (API_CONTRACT_P37 §1, ADR 0052 §6, R37-6/R37-7).

Answers "is the active plan at the calendar week, and if not, is anything
bringing it up to date?" from stored state only. It never dispatches a run
and never takes the dispatch lock (a read endpoint must not serialise behind
dispatch).

- no active run → `None` (R37-7);
- `current` ⇔ the active run's stored week == the calendar week (R37-6,
  equality, so a lowered pin is "behind" too);
- `recalculating`: the weeks differ and some run is queued or running inside
  the in-flight window (any trigger);
- `failed`: the weeks differ and the week's rollover budget is spent. That
  needs P37-T05's `plan_week_rollovers` table; until it lands this module
  never answers `failed` (served as `pending`, per the P37-T04 plan row);
- `pending` otherwise.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.enums import ScheduleRunStatus
from models.schedule import ScheduleRun
from services.active_run import get_active_run
from services.plan_clock import PlanClock
from services.run_dispatch import in_flight_window

PlanWeekStatus = Literal["current", "recalculating", "pending", "failed"]


async def any_run_in_flight(db: AsyncSession) -> bool:
    """A queued or running run inside the in-flight window (the same
    predicate as `run_dispatch.find_in_flight_run`, without its lock)."""

    cutoff = datetime.now(UTC) - in_flight_window()
    return (
        await db.execute(
            select(ScheduleRun.id)
            .where(
                ScheduleRun.status.in_([ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING]),
                ScheduleRun.created_at > cutoff,
            )
            .limit(1)
        )
    ).scalar_one_or_none() is not None


async def plan_week_state(
    db: AsyncSession, clock: PlanClock
) -> tuple[int, int, PlanWeekStatus] | None:
    """`(run_week, run_version, status)` for the active run, or None."""

    active = await get_active_run(db)
    if active is None:
        return None
    status: PlanWeekStatus
    if active.current_week == clock.week:
        status = "current"
    elif await any_run_in_flight(db):
        status = "recalculating"
    else:
        status = "pending"
    return active.current_week, active.version, status
