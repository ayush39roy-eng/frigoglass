"""Shared "solved schedule -> persisted run" step (P14-T01, ADR 0026).

Before P14 this lived inline in `workers/schedule_tasks.py::_run_schedule_body`.
It is factored out so the Celery worker and the in-process priority-move
confirm (`services/priority_preview.py`) persist a run with the same code:

1. read the run active before (the baseline) and the recalculated project's
   finish in it;
2. `persist_schedule_output` (versioned immutable run, I14; activation,
   live-step sync, stale-flag clearing and notifications when `activate`);
3. when `activate` and a `recalc_project_id` is given, the
   `project.schedule_recalculated` audit row ("finish moved week X -> Y").

The caller commits. Scheduling itself stays in `backend/scheduling/`; this
module only persists a `ScheduleOutput` it is handed.

The input snapshot builder the worker and the API share is
`services.schedule_persistence.build_schedule_input_from_db` (it was already
a service; nothing in it is worker-specific).
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.audit import AuditLogEntry
from models.enums import SolverType
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome
from scheduling.types import ScheduleInput, ScheduleOutput
from services.schedule_persistence import persist_schedule_output


async def projected_finish(
    db: AsyncSession, schedule_run_id: uuid.UUID | None, project_id: uuid.UUID
) -> int | None:
    """The project's stored `projected_end_week` in a run, or `None`."""

    if schedule_run_id is None:
        return None
    return (
        await db.execute(
            select(ScheduleRunProjectOutcome.projected_end_week).where(
                ScheduleRunProjectOutcome.schedule_run_id == schedule_run_id,
                ScheduleRunProjectOutcome.project_id == project_id,
            )
        )
    ).scalar_one_or_none()


async def persist_solved_run(
    db: AsyncSession,
    schedule_input: ScheduleInput,
    schedule_output: ScheduleOutput,
    *,
    solver: SolverType,
    trigger_reason: str,
    actor_user_id: uuid.UUID | None,
    activate: bool,
    existing_run: ScheduleRun | None = None,
    recalc_project_id: uuid.UUID | None = None,
    objective_value: float | None = None,
    solver_status: str | None = None,
) -> ScheduleRun:
    """Persist one solved schedule (see module docstring). Flushes, never
    commits. `sync_live_workflow_steps` always equals `activate` (the
    "Sharp edge" in `services.schedule_persistence`).
    """

    previous_active_id = (
        await db.execute(select(ScheduleRun.id).where(ScheduleRun.is_active.is_(True)))
    ).scalar_one_or_none()
    previous_finish = (
        await projected_finish(db, previous_active_id, recalc_project_id)
        if recalc_project_id is not None
        else None
    )
    run = await persist_schedule_output(
        db,
        schedule_input,
        schedule_output,
        solver_type=solver,
        trigger_reason=trigger_reason,
        triggered_by_user_id=actor_user_id,
        # Decision (docs/MEMORY.md P3-T06 entry): an admin CP-SAT dispatch
        # never auto-activates (`activate=False`); the Workspace recalc and
        # every auto-trigger pass `activate=True`.
        activate=activate,
        sync_live_workflow_steps=activate,
        existing_run=existing_run,
        objective_value=objective_value,
        solver_status=solver_status,
    )
    if activate and recalc_project_id is not None:
        new_finish = await projected_finish(db, run.id, recalc_project_id)
        hub_id = (
            await db.execute(select(Project.hub_id).where(Project.id == recalc_project_id))
        ).scalar_one_or_none()
        db.add(
            AuditLogEntry(
                actor_user_id=actor_user_id,
                action="project.schedule_recalculated",
                entity_type="Project",
                entity_id=str(recalc_project_id),
                hub_id=hub_id,
                before_state={
                    "project_id": str(recalc_project_id),
                    "projected_end_week": previous_finish,
                },
                after_state={
                    "project_id": str(recalc_project_id),
                    "projected_end_week": new_finish,
                    "schedule_run_id": str(run.id),
                    "schedule_run_version": run.version,
                },
            )
        )
    return run
