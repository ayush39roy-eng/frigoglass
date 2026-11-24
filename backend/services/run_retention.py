"""Retention of old schedule runs' per-step output (owner 2026-11-24).

Every Recalculate stores one row per project step in
`schedule_run_project_steps` (about 5,000 rows a run). Kept forever, that
table had grown to 500k rows / 179 MB of a 240 MB database on the hosted
256 MB-RAM Postgres, which was OOM-killed into crash recovery.

The owner chose: keep the step detail of the latest `KEEP_RUNS_WITH_STEPS`
completed runs; delete it for older runs. A run's row and its per-project
outcomes (`schedule_run_project_outcomes`: projected end, in-year flags,
what changed) are never deleted.

Always kept, whatever their age:
- the active run (`is_active`);
- a run a plan-week rollover points at (`plan_week_rollovers.last_run_id`).

Runs that are queued or running are never touched. Deletion goes one run at
a time, in its own transaction, so a large backlog never becomes one huge
transaction on a small database.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import delete, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from models.enums import ScheduleRunStatus
from models.plan_week_rollover import PlanWeekRollover
from models.schedule import ScheduleRun, ScheduleRunProjectStep

logger = logging.getLogger(__name__)

KEEP_RUNS_WITH_STEPS = 20

_TERMINAL = (
    ScheduleRunStatus.COMPLETED,
    ScheduleRunStatus.FAILED,
    ScheduleRunStatus.CANCELLED,
)


async def runs_to_prune(db: AsyncSession, keep: int = KEEP_RUNS_WITH_STEPS) -> list[uuid.UUID]:
    """Ids of finished runs that still have step rows but fall outside the
    retention set, oldest first."""

    newest_completed = (
        select(ScheduleRun.id)
        .where(ScheduleRun.status == ScheduleRunStatus.COMPLETED)
        .order_by(ScheduleRun.version.desc())
        .limit(keep)
    )
    rollover_runs = select(PlanWeekRollover.last_run_id).where(
        PlanWeekRollover.last_run_id.is_not(None)
    )
    has_steps = exists().where(ScheduleRunProjectStep.schedule_run_id == ScheduleRun.id)
    stmt = (
        select(ScheduleRun.id)
        .where(
            ScheduleRun.status.in_(_TERMINAL),
            ScheduleRun.is_active.is_(False),
            ScheduleRun.id.not_in(newest_completed.scalar_subquery()),
            ScheduleRun.id.not_in(rollover_runs.scalar_subquery()),
            has_steps,
        )
        .order_by(ScheduleRun.version.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def count_prunable_step_rows(db: AsyncSession, run_ids: list[uuid.UUID]) -> int:
    if not run_ids:
        return 0
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(ScheduleRunProjectStep)
                .where(ScheduleRunProjectStep.schedule_run_id.in_(run_ids))
            )
        ).scalar_one()
    )


async def prune_old_run_steps(
    session_factory: async_sessionmaker[AsyncSession],
    keep: int = KEEP_RUNS_WITH_STEPS,
    max_runs: int | None = None,
) -> tuple[int, int]:
    """Delete step rows of runs outside the retention set, one run per
    transaction. Returns (runs pruned, step rows deleted)."""

    async with session_factory() as db:
        run_ids = await runs_to_prune(db, keep)
    if max_runs is not None:
        run_ids = run_ids[:max_runs]

    pruned_runs = 0
    deleted_rows = 0
    for run_id in run_ids:
        async with session_factory() as db:
            # Re-check under the same transaction: the run may have become
            # active (or a rollover target) since the list was read.
            still_prunable = run_id in await runs_to_prune(db, keep)
            if not still_prunable:
                continue
            result = await db.execute(
                delete(ScheduleRunProjectStep).where(
                    ScheduleRunProjectStep.schedule_run_id == run_id
                )
            )
            await db.commit()
        pruned_runs += 1
        deleted_rows += result.rowcount or 0
    if pruned_runs:
        logger.info(
            "Pruned step detail of old schedule runs",
            extra={"runs_pruned": pruned_runs, "step_rows_deleted": deleted_rows},
        )
    return pruned_runs, deleted_rows
