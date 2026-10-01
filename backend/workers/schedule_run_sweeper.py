"""P9-F01 (R04-L1): a Celery-beat sweeper for `ScheduleRun` rows stuck in
`QUEUED`/`RUNNING` — the documented gap the security-auditor's P9-R04 re-run
found: a hard-killed worker (`task_time_limit` exceeded, an OS-level restart,
Postgres/Redis briefly unreachable before `run_cp_sat_schedule`'s own
`except Exception` cleanup in `workers/schedule_tasks.py` could run) can
leave a row with no `completed_at` and no terminal SSE event, which then also
makes `api/routers/schedule_runs.py::dispatch_cp_sat_run`'s and
`api/routers/workspace.py::recalculate_project`'s `RUN_IN_PROGRESS` in-flight
checks block every future dispatch/recalc forever.

Registered on the EXISTING general-purpose `worker` Celery app
(`workers/worker_app.py`), not `workers/celery_app.py` ("solver-worker") —
same reasoning as `workers/backup_tasks.py`'s module docstring: sweeping a
handful of rows every few minutes is bookkeeping, not CP-SAT-scale compute,
so it must not compete with a solve for `solver-worker`'s isolated resource
budget.

**Staleness window**: identical to the in-flight checks above
(`CelerySettings.task_time_limit_seconds + 120`s past `created_at`) — a row
is only ever swept once BOTH of those checks would already consider it long
gone, so this task can never race a genuinely still-running solve into a
false FAILED.

**Never re-implements scheduling logic** — this task only flips a
`ScheduleRun.status`/`error_message`/`completed_at` and publishes a terminal
SSE event; it does not touch `backend/scheduling/`, `ScheduleRunProjectStep`
or `ScheduleRunProjectOutcome` rows.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from celery import Task
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from core.celery_config import get_celery_settings
from models.audit import AuditLogEntry
from models.enums import ScheduleRunStatus
from models.schedule import ScheduleRun
from workers.progress import publish_progress
from workers.worker_app import worker_app

logger = logging.getLogger(__name__)

#: Beat cadence is declared on `worker_app.conf.beat_schedule`
#: (`workers/worker_app.py`, currently every 5 minutes) rather than here —
#: this module cannot import `worker_app` for the value without introducing
#: the same circular import `worker_app.py`'s own comment on that entry
#: explains, since this module already imports `worker_app` to register its
#: task.
TASK_NAME = "workers.schedule_run_sweeper.sweep_stuck_schedule_runs"


def _database_url() -> str:
    """Same convention as `workers/schedule_tasks.py::_database_url` —
    deliberately duplicated rather than imported, for the same "this worker
    must not depend on that module's engine-lifetime assumptions" reason.
    """

    url = os.environ.get("RPD_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "RPD_DATABASE_URL is not set (async postgresql+asyncpg:// DSN). "
            "See backend/api/db.py / backend/workers/schedule_tasks.py for the same convention."
        )
    return url


@asynccontextmanager
async def _open_session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine: AsyncEngine = create_async_engine(_database_url())
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@worker_app.task(bind=True, name=TASK_NAME)
def sweep_stuck_schedule_runs(self: Task) -> dict[str, Any]:
    """Sync Celery entry point — see `workers/schedule_tasks.py`'s identical
    `asyncio.run(...)` bridge for why.
    """

    _ = self
    return asyncio.run(_sweep_stuck_schedule_runs_async())


async def _sweep_stuck_schedule_runs_async() -> dict[str, Any]:
    window = timedelta(seconds=get_celery_settings().task_time_limit_seconds + 120)
    cutoff = datetime.now(UTC) - window
    swept: list[str] = []

    async with _open_session_factory() as session_factory, session_factory() as db:
        stuck = (
            (
                await db.execute(
                    select(ScheduleRun).where(
                        ScheduleRun.status.in_(
                            [ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING]
                        ),
                        ScheduleRun.created_at < cutoff,
                    )
                )
            )
            .scalars()
            .all()
        )

        for run in stuck:
            previous_status = run.status.value
            run.status = ScheduleRunStatus.FAILED
            run.error_message = (
                "Swept: no terminal status recorded within "
                f"{int(window.total_seconds())}s of dispatch (worker crash, "
                "hard kill, or unreachable Postgres/Redis)."
            )
            run.completed_at = datetime.now(UTC)
            db.add(run)
            db.add(
                AuditLogEntry(
                    actor_user_id=None,
                    action="schedule_run.swept_stuck",
                    entity_type="ScheduleRun",
                    entity_id=str(run.id),
                    hub_id=None,
                    before_state={"status": previous_status},
                    after_state={"status": ScheduleRunStatus.FAILED.value},
                )
            )
            swept.append(str(run.id))

        if swept:
            await db.commit()

    for run_id in swept:
        try:
            publish_progress(run_id, status="failed", message="Swept: stale queued/running run")
        except Exception:  # noqa: BLE001 - best-effort SSE notice only
            logger.exception("ScheduleRun %s: swept but failed to publish SSE event", run_id)

    if swept:
        logger.warning("Swept %d stuck ScheduleRun row(s): %s", len(swept), swept)

    return {"swept_count": len(swept), "schedule_run_ids": swept}

