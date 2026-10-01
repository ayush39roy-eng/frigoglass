"""Pydantic response models for `api/routers/schedule_runs.py` — versioned
`ScheduleRun` summaries, per the "Versions & History" cross-cutting
requirement (`docs/PROJECT_AND_STACK.md` §2).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    #: P9-R02 (ruling 6): the CP-SAT verdict, "OPTIMAL" / "FEASIBLE". Always
    #: null for greedy runs (`solver_type` records the solver) and for older runs.
    solver_status: str | None = None
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

    #: P9-F01/R04-L1: reject non-finite floats outright (was surfacing as a
    #: 500 on `NaN`) and validate strictly (was coercing `"15"` / `true` in
    #: lax mode).
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)

    @model_validator(mode="before")
    @classmethod
    def _ignore_legacy_max_time_in_seconds(cls, data: Any) -> Any:
        """P9-R02b: for ONE release, silently accept and ignore a legacy
        `max_time_in_seconds` key (same pattern as the chamber
        `weeks_per_chamber` tolerance), so an older client does not 422.
        DOMAIN_RULES "Gate remediation rulings" #6 retired wall-clock CP-SAT
        limits; the value is never forwarded. Remove this hook in the release
        after P9.
        """

        if isinstance(data, dict) and "max_time_in_seconds" in data:
            data = {k: v for k, v in data.items() if k != "max_time_in_seconds"}
        return data

    #: Pass-1 CP-SAT budget in deterministic-time units (ruling 6), forwarded
    #: to `scheduling.cp_sat.run_cp_sat(deterministic_time=...)`. `None` (the
    #: default) means "use `core.celery_config.CelerySettings.
    #: cp_sat_deterministic_time`, else the solver's own default" — resolved
    #: inside the Celery task (`workers/schedule_tasks.py`), not here.
    deterministic_time: float | None = Field(default=None, gt=0, le=60)


class CpSatDispatchResponse(BaseModel):
    """Response for `POST /schedule-runs/cp-sat-dispatch` — 202-style:
    returned as soon as the `ScheduleRun` row is created and the Celery task
    is enqueued, well before the solve itself runs. `schedule_run_id` /
    `celery_task_id` are what the client needs to open a P3-T05 SSE
    connection against `workers.progress.channel_name(schedule_run_id)`.
    """

    schedule_run: ScheduleRunSummary
    celery_task_id: str
