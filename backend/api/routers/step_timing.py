"""Gantt drag: `PATCH /projects/{project_id}/steps/{step_id}/timing`
(ADR 0019, docs/API_CONTRACT_P12.md §3).

**RBAC**: the same checks as the Gantt freeze toggle
(`api/routers/gantt.py::toggle_freeze`): `GANTT`/`WRITE` (Hub Planner, Admin,
Super Admin; Portfolio Manager, Executive Viewer and Engineer get 403), and a
hub-scoped project lookup, so a Hub Planner of another hub gets 404 and learns
nothing about the project. Logic: `services.step_timing.apply_step_timing`.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.project import Project
from schemas.step_timing import StepTimingRequest, StepTimingResponse
from services.hub_scope import hub_scope_filter
from services.step_timing import apply_step_timing

router = APIRouter(tags=["gantt"])

_write = require_permission(Surface.GANTT, Action.WRITE)


@router.patch(
    "/projects/{project_id}/steps/{step_id}/timing", response_model=StepTimingResponse
)
async def set_step_timing(
    project_id: uuid.UUID,
    step_id: str,
    body: StepTimingRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> StepTimingResponse:
    stmt = select(Project).where(Project.id == project_id)
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    project = (await db.execute(stmt)).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    changes = {name: getattr(body, name) for name in body.model_fields_set}
    result = await apply_step_timing(db, project, step_id, changes, current_user)
    return StepTimingResponse(
        project_id=result.project_id,
        step_id=result.step_id,
        duration_override_weeks=result.duration_override_weeks,
        start_not_before_week=result.start_not_before_week,
        effective_duration_weeks=result.effective_duration_weeks,
        effort_weeks=result.effort_weeks,
        lead_time_weeks=result.lead_time_weeks,
        recalc_status=result.recalc_status,
        schedule_run_id=result.schedule_run_id,
        baseline_run_id=result.baseline_run_id,
        task_id=result.task_id,
    )
