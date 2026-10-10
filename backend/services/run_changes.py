"""Run-to-run change list (ADR 0015 §4, docs/API_CONTRACT_P11.md §3, I20).

Compares the **stored** `ScheduleRunProjectOutcome` rows of two runs on four
fields: `projected_end_week`, `within_year`, `left_out` and `blocked`. Both
runs are immutable (I14), so the list for a given pair never changes.
Nothing is recomputed: every value served is a stored column.

Scoping is the data-access layer's, applied server-side:
- an Engineer principal sees only projects with a step assigned to their own
  linked Engineer row in the compared (new) run, the Gantt's "own
  assignments" rule (`services.hub_scope.is_engineer_self_scoped`, P10-F01);
- everyone else is filtered by `hub_scope_filter(principal, Project.hub_id)`.
Changed projects outside that scope are only *counted* (`hidden_count`).
Their names, ids and figures never leave this function.
"""

from __future__ import annotations

import uuid
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.principal import Principal
from models.engineer import Engineer
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from schemas.schedule_run import ScheduleRunChangeRow, ScheduleRunChanges
from services.hub_scope import hub_scope_filter, is_engineer_self_scoped


class _Compared(NamedTuple):
    projected_end_week: int | None
    within_year: bool
    left_out: bool
    blocked: bool


_EMPTY = _Compared(None, False, False, False)


async def _outcomes(db: AsyncSession, run_id: uuid.UUID) -> dict[uuid.UUID, _Compared]:
    rows = (
        await db.execute(
            select(
                ScheduleRunProjectOutcome.project_id,
                ScheduleRunProjectOutcome.projected_end_week,
                ScheduleRunProjectOutcome.within_year,
                ScheduleRunProjectOutcome.left_out,
                ScheduleRunProjectOutcome.blocked,
            ).where(ScheduleRunProjectOutcome.schedule_run_id == run_id)
        )
    ).all()
    return {pid: _Compared(end, wy, lo, bl) for pid, end, wy, lo, bl in rows}


async def _own_assignment_project_ids(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID
) -> set[uuid.UUID]:
    engineer_id = (
        await db.execute(select(Engineer.id).where(Engineer.user_id == principal.user_id))
    ).scalar_one_or_none()
    if engineer_id is None:
        return set()
    rows = await db.execute(
        select(ScheduleRunProjectStep.project_id)
        .where(
            ScheduleRunProjectStep.schedule_run_id == run_id,
            ScheduleRunProjectStep.assigned_engineer_id == engineer_id,
        )
        .distinct()
    )
    return {row[0] for row in rows.all()}


def _sort_key(row: ScheduleRunChangeRow) -> tuple[bool, int, str, str]:
    # |delta_weeks| descending with null last, then project name, then id
    # (only to make equal names deterministic).
    delta = row.delta_weeks
    return (delta is None, -abs(delta) if delta is not None else 0, row.project_name,
            str(row.project_id))


async def compute_run_changes(
    db: AsyncSession, run: ScheduleRun, baseline: ScheduleRun, principal: Principal
) -> ScheduleRunChanges:
    after = await _outcomes(db, run.id)
    before = after if baseline.id == run.id else await _outcomes(db, baseline.id)

    changed: set[uuid.UUID] = {
        pid
        for pid in after.keys() | before.keys()
        if pid not in before or pid not in after or before[pid] != after[pid]
    }

    rows: list[ScheduleRunChangeRow] = []
    if changed:
        stmt = (
            select(Project.id, Project.name, Hub.name, Project.priority)
            .join(Hub, Project.hub_id == Hub.id)
            .where(Project.id.in_(changed))
        )
        if is_engineer_self_scoped(principal):
            own = await _own_assignment_project_ids(db, principal, run.id)
            stmt = stmt.where(Project.id.in_(own))
        else:
            hub_filter = hub_scope_filter(principal, Project.hub_id)
            if hub_filter is not None:
                stmt = stmt.where(hub_filter)
        for pid, name, hub_name, priority in (await db.execute(stmt)).all():
            b = before.get(pid, _EMPTY)
            a = after.get(pid, _EMPTY)
            delta = (
                a.projected_end_week - b.projected_end_week
                if a.projected_end_week is not None and b.projected_end_week is not None
                else None
            )
            rows.append(
                ScheduleRunChangeRow(
                    project_id=pid,
                    project_name=name,
                    hub=hub_name,
                    priority=priority,
                    before_projected_end_week=b.projected_end_week,
                    after_projected_end_week=a.projected_end_week,
                    delta_weeks=delta,
                    before_within_year=b.within_year,
                    after_within_year=a.within_year,
                    before_left_out=b.left_out,
                    after_left_out=a.left_out,
                    before_blocked=b.blocked,
                    after_blocked=a.blocked,
                    is_new=pid not in before,
                    is_removed=pid not in after,
                )
            )
    rows.sort(key=_sort_key)
    return ScheduleRunChanges(
        run_id=run.id,
        run_version=run.version,
        against_run_id=baseline.id,
        against_run_version=baseline.version,
        hidden_count=len(changed) - len(rows),
        rows=rows,
    )
