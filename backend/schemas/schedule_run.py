"""Pydantic response models for `api/routers/schedule_runs.py` — versioned
`ScheduleRun` summaries, per the "Versions & History" cross-cutting
requirement (`docs/PROJECT_AND_STACK.md` §2).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.enums import ScheduleRunStatus, SolverType


class ScheduleRunSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    solver_type: SolverType
    status: ScheduleRunStatus
    is_active: bool
    horizon_weeks: int
    current_week: int
    trigger_reason: str | None
    created_at: datetime


class GreedyRecalcResponse(BaseModel):
    """Response for `POST /schedule-runs/greedy-recalc`."""

    schedule_run: ScheduleRunSummary
    project_count: int
    left_out_count: int
    within_year_count: int
    spillover_count: int


class CpSatDispatchRequest(BaseModel):
    """Request body for `POST /schedule-runs/cp-sat-dispatch` (P3-T06).
    Every field is optional — an empty `{}` body is a valid request (dispatch
    with every solver default).
    """

    model_config = ConfigDict(extra="forbid")

    #: Forwarded to `scheduling.cp_sat.run_cp_sat`'s own `max_time_in_seconds`
    #: search-budget parameter. `None` (the default) means "use
    #: `core.celery_config.CelerySettings.cp_sat_max_time_in_seconds`" —
    #: resolved inside the Celery task (`workers/schedule_tasks.py`), not
    #: here, so this schema stays a pure request-shape description.
    max_time_in_seconds: float | None = Field(default=None, gt=0)


class CpSatDispatchResponse(BaseModel):
    """Response for `POST /schedule-runs/cp-sat-dispatch` — 202-style:
    returned as soon as the `ScheduleRun` row is created and the Celery task
    is enqueued, well before the solve itself runs. `schedule_run_id` /
    `celery_task_id` are what the client needs to open a P3-T05 SSE
    connection against `workers.progress.channel_name(schedule_run_id)`.
    """

    schedule_run: ScheduleRunSummary
    celery_task_id: str
