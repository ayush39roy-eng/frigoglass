"""Shared reads of the active `ScheduleRun` for the read models (Capacity,
Gantt, Project Workspace). None of these recompute a schedule figure. They
only locate the stored rows (Invariants I9, I13, I16).

`step_kinds_for_run` answers "which kind was step X *in this run*". The
answer comes from the run's `workflow_snapshot` (ADR 0009, I15), so an edit
on Workflow Settings after the run (for example turning a lab step into an
elapsed one) does not change how that run's load is reported (I6/I7). Runs
from before P9-T01 have no snapshot. For those it falls back to the current
templates.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.enums import WorkflowStepKind
from models.schedule import ScheduleRun
from models.workflow import WorkflowStepTemplate


async def get_active_run(db: AsyncSession) -> ScheduleRun | None:
    return (
        await db.execute(select(ScheduleRun).where(ScheduleRun.is_active.is_(True)))
    ).scalar_one_or_none()


def _snapshot_kinds(snapshot: dict[str, Any] | None) -> dict[str, WorkflowStepKind]:
    kinds: dict[str, WorkflowStepKind] = {}
    if not snapshot:
        return kinds
    for workflow in snapshot.get("workflows", []):
        for step in workflow.get("steps", []):
            try:
                kinds[str(step["step_id"])] = WorkflowStepKind(step["kind"])
            except (KeyError, ValueError):
                continue
    return kinds


async def step_kinds_for_run(
    db: AsyncSession, run: ScheduleRun | None
) -> dict[str, WorkflowStepKind]:
    """`{step_id: kind}` as recorded on `run.workflow_snapshot`, with any step
    missing from the snapshot filled in from the current templates.
    """

    current = {
        t.id: t.kind for t in (await db.execute(select(WorkflowStepTemplate))).scalars().all()
    }
    if run is None:
        return current
    return {**current, **_snapshot_kinds(run.workflow_snapshot)}


def slip_weeks(projected: int | None, expected: int | None) -> int | None:
    """`projected − expected` (may be negative), or `None` when either is
    missing. A subtraction of two stored values, not a schedule computation
    (DOMAIN_RULES "Expected vs projected completion", I16).
    """

    if projected is None or expected is None:
        return None
    return projected - expected
