"""`Project.schedule_stale` bookkeeping (ADR 0006, ADR 0009).

A stale flag never triggers a solve. It only tells the UI that the active
`ScheduleRun` no longer reflects the inputs.

- A per-stage progress edit marks one project stale
  (`mark_projects_stale([...])`).
- A Workflow Settings change marks every *schedulable* project stale
  (`mark_all_schedulable_stale`). Its return value is the count sent back in
  the `X-Schedule-Stale-Count` header.
- Activating a run clears the flag for every project that has an outcome
  row in that run, and (P56) for every project the run leaves out for a
  missing priority / category (`clear_stale_for_run`). `services.schedule_persistence.
  persist_schedule_output(activate=True)` is the only place a run becomes
  active, so every activation path clears it.

All three are parameterised `UPDATE`s built with SQLAlchemy Core.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from models.enums import NON_SCHEDULABLE_STATUSES
from models.project import Project
from models.schedule import ScheduleRunProjectOutcome
from services.schedule_readiness import sql_missing_schedule_fields


async def mark_projects_stale(db: AsyncSession, project_ids: Sequence[uuid.UUID]) -> None:
    if not project_ids:
        return
    await db.execute(
        update(Project)
        .where(Project.id.in_(list(project_ids)))
        .values(schedule_stale=True)
        .execution_options(synchronize_session=False)
    )


async def mark_all_schedulable_stale(db: AsyncSession) -> int:
    """Set `schedule_stale = true` on every project whose status is
    schedulable. Returns how many schedulable projects there are, which is
    how many are now stale.
    """

    schedulable = Project.status.not_in(list(NON_SCHEDULABLE_STATUSES))
    await db.execute(
        update(Project)
        .where(schedulable)
        .values(schedule_stale=True)
        .execution_options(synchronize_session=False)
    )
    count = (
        await db.execute(select(func.count()).select_from(Project).where(schedulable))
    ).scalar_one()
    return int(count)


async def clear_stale_for_run(db: AsyncSession, schedule_run_id: uuid.UUID) -> None:
    in_run = select(ScheduleRunProjectOutcome.project_id).where(
        ScheduleRunProjectOutcome.schedule_run_id == schedule_run_id
    )
    await db.execute(
        update(Project)
        # P56: a project left out of every run for a missing priority /
        # category is as current as the run can make it; its flag clears too
        # (filling the field marks it stale again).
        .where(or_(Project.id.in_(in_run), sql_missing_schedule_fields()))
        .values(schedule_stale=False)
        .execution_options(synchronize_session=False)
    )


async def count_stale_schedulable(db: AsyncSession) -> int:
    """ADR 0069 plan freshness: how many schedulable projects are
    `schedule_stale`. One parameterised `COUNT`, not hub-scoped."""

    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(Project)
                .where(
                    Project.schedule_stale.is_(True),
                    Project.status.not_in(list(NON_SCHEDULABLE_STATUSES)),
                )
            )
        ).scalar_one()
    )
