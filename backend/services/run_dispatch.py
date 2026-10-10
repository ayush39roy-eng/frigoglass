"""Single-flight check shared by every solver dispatch path.

A run counts as "in flight" while it is `QUEUED` or `RUNNING` and was created
within `CelerySettings.task_time_limit_seconds + 120` seconds. Past that
window a stuck row is the sweeper's job (`workers/schedule_run_sweeper.py`,
same window), so a crashed worker cannot block every later dispatch.

Callers decide what an in-flight run means for them:
- Workspace "Recalculate schedule" and the admin CP-SAT dispatch refuse with
  409 `RUN_IN_PROGRESS`;
- a priority move (ADR 0015) still saves the priority and answers
  `deferred`, without starting a second run.

Extracted in P11-T01 from the identical inline queries in
`api/routers/workspace.py::recalculate` and
`api/routers/schedule_runs.py::dispatch_cp_sat_run`.

**Serialised (P11-T01).** The check first takes a transaction-scoped
Postgres advisory lock (`pg_advisory_xact_lock`, one fixed key). Two
concurrent dispatchers therefore cannot both see "nothing in flight" and both
queue a run: the second waits until the first transaction ends, and by then
the first one's `QUEUED` row is committed (`create_queued_schedule_run`
commits immediately) and visible. The lock is released by the caller's next
commit or rollback; every caller commits or raises right after the check.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.celery_config import get_celery_settings
from models.enums import ScheduleRunStatus
from models.schedule import ScheduleRun

#: Seconds added to the Celery hard time limit before a queued/running row
#: stops counting as in flight.
IN_FLIGHT_GRACE_SECONDS = 120

#: Fixed advisory-lock key for "decide whether to dispatch a solver run".
#: Spells "RPDRUN" in ASCII hex, the same convention as
#: `api/routers/users.py::SUPER_ADMIN_MEMBERSHIP_LOCK` ("RPDSA"), and distinct
#: from it.
DISPATCH_LOCK_KEY = 0x52504452554E


def in_flight_window() -> timedelta:
    return timedelta(
        seconds=get_celery_settings().task_time_limit_seconds + IN_FLIGHT_GRACE_SECONDS
    )


async def find_in_flight_run(db: AsyncSession) -> uuid.UUID | None:
    """The id of one queued or running run inside the window, or `None`.
    Takes the dispatch advisory lock first (see module docstring).
    """

    await db.execute(select(func.pg_advisory_xact_lock(DISPATCH_LOCK_KEY)))
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
    ).scalar_one_or_none()
