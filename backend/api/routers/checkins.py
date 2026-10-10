"""Weekly check-in (docs/API_CONTRACT_P12.md §5; ADR 0021, ADR 0023).

- `GET /check-ins/due?hub_id=`: the stages due this week that the caller
  sees (see `services.checkin` for who sees what), grouped by project, each
  with `can_check_in`. Projects are listed overdue first, then due, then
  live, then by name. `hub_id` is ANDed with the caller's scope; it never
  widens it.
- `POST /check-ins`: one atomic batch (1..100 entries). Every entry is
  checked first; any failure answers 422 `CHECKIN_INVALID` with
  `detail.errors = [{index, code, message}]` and writes nothing. Codes, in
  the order they are checked: `DUPLICATE_STAGE` (the same stage twice in one
  batch), `FORBIDDEN_STAGE` (no write right on that stage, or the project or
  stage does not exist / is out of scope, so existence never leaks),
  `PROJECT_FROZEN`, `STEP_DONE_IMMUTABLE`, `NOT_DUE`,
  `INCONSISTENT_PROGRESS`. The server fills `actual_start_week =
  CURRENT_WEEK` on the first move out of Not Started and, on Done,
  `actual_end_week = CURRENT_WEEK` and `percent_complete = 100`. Effects:
  the progress fields, one `stage_checkins` row per entry (also for a stage
  confirmed unchanged), `schedule_stale` on each changed project, a
  `stage_blocked` notification for a stage that moves into On Hold (as the
  Workspace PATCH does), and one `project.check_in` audit row per project.
  Then one greedy run per batch (ADR 0023 §1): `not_needed` when no progress
  field changed, `deferred` (registering the coalesced follow-up run) when
  a run is in flight, else `queued`. Rate-limited per user.
- `GET /check-ins/history?project_id=&step_id=`: that stage's own history,
  newest first, at most 52 rows; the permission is the Workspace read of the
  project (404 out of scope). This is the only place the submitter's name
  is shown (ADR 0021 §7).

Audit rows never carry the note or hold-reason text (free text, may hold
personal data, and the audit log is immutable): only their lengths.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import domain_constants as dc
from api.db import get_db
from api.deps import get_current_principal, require_permission
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.checkin import StageCheckin
from models.enums import NON_SCHEDULABLE_STATUSES, SolverType, WorkflowStepStatus
from models.project import Project
from models.schedule import ScheduleRunProjectStep
from models.user import User
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from schemas.checkin import (
    CheckInDueProject,
    CheckInDueResponse,
    CheckInDueStage,
    CheckInDueSummary,
    CheckInEntry,
    CheckInEntryError,
    CheckInErrorCode,
    CheckInHistoryRow,
    CheckInRecalcStatus,
    CheckInRequest,
    CheckInResponse,
)
from services.active_run import get_active_run
from services.checkin import CheckInAccess, candidate_filter, resolve_access, visible_stages
from services.notifications import generate_stage_blocked_notifications
from services.rate_limit import TokenBucketLimiter
from services.run_dispatch import find_in_flight_run
from services.schedule_persistence import create_queued_schedule_run
from services.schedule_stale import mark_projects_stale
from services.tracking import DueStage, due_stages_for, status_from_due_stages
from services.workspace import get_scoped_project_or_404, merge_stage_update
from workers.progress import publish_progress
from workers.schedule_tasks import run_greedy_schedule

router = APIRouter(prefix="/check-ins", tags=["check-ins"])

_workspace_read = require_permission(Surface.PROJECT_WORKSPACE, Action.READ)

#: `ScheduleRun.trigger_reason` of a check-in run (ADR 0023 §1).
TRIGGER_REASON = "check_in"
#: Audit action, one row per project per batch.
AUDIT_ACTION = "project.check_in"
#: History rows returned (contract §5).
HISTORY_LIMIT = 52
#: Per user: a burst of 10 submissions, then one every 6 seconds. Per API
#: process (see `services.rate_limit` for the documented limitation).
CHECKIN_RATE_LIMIT = TokenBucketLimiter(capacity=10, refill_per_second=1 / 6)

_TRACKING_ORDER = {"overdue": 0, "due": 1, "live": 2, "idle": 3}
_PROGRESS_FIELDS = (
    "status",
    "percent_complete",
    "actual_start_week",
    "actual_end_week",
    "remaining_weeks_override",
    "blocked_reason",
)


# --- GET /check-ins/due ---------------------------------------------------------------


@router.get("/due", response_model=CheckInDueResponse)
async def get_due_check_ins(
    hub_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> CheckInDueResponse:
    access = await resolve_access(db, current_user)
    if not access.has_any_route:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your role has no access to the weekly check-in.",
        )
    active_run = await get_active_run(db)
    stmt = (
        select(Project)
        .options(selectinload(Project.hub))
        .where(candidate_filter(access, active_run))
        .where(Project.status.not_in(list(NON_SCHEDULABLE_STATUSES)))
    )
    if hub_id is not None:
        stmt = stmt.where(Project.hub_id == hub_id)
    projects = (await db.execute(stmt)).scalars().all()
    due = await due_stages_for(db, [p.id for p in projects], active_run=active_run)

    rows: list[CheckInDueProject] = []
    for project in projects:
        project_stages = due.get(project.id, [])
        shown = visible_stages(access, project, project_stages)
        if not shown:
            continue
        rows.append(
            CheckInDueProject(
                project_id=project.id,
                name=project.name,
                hub=project.hub.name,
                hub_id=project.hub_id,
                # Project-level status over every due stage, not just the
                # caller's: compliance is per project (ADR 0021 §7).
                tracking_status=status_from_due_stages(project_stages),
                schedule_stale=project.schedule_stale,
                stages=[_due_stage(stage, can) for stage, can in shown],
            )
        )
    rows.sort(key=lambda r: (_TRACKING_ORDER[r.tracking_status], r.name, str(r.project_id)))

    stage_rows = [s for r in rows for s in r.stages]
    summary = CheckInDueSummary(
        due_stages=len(stage_rows),
        checked_in_stages=sum(1 for s in stage_rows if s.checked_in_this_week),
        projects_live=sum(1 for r in rows if r.tracking_status == "live"),
        projects_due=sum(1 for r in rows if r.tracking_status == "due"),
        projects_overdue=sum(1 for r in rows if r.tracking_status == "overdue"),
        stale_projects=sum(1 for r in rows if r.schedule_stale),
    )
    return CheckInDueResponse(week=dc.CURRENT_WEEK, summary=summary, projects=rows)


def _due_stage(stage: DueStage, can_check_in: bool) -> CheckInDueStage:
    return CheckInDueStage(
        step_id=stage.step_id,
        step_name=stage.step_name,
        kind=stage.kind,
        status=stage.status,
        percent_complete=stage.percent_complete,
        blocked_reason=stage.blocked_reason,
        planned_start_week=stage.planned_start_week,
        planned_end_week=stage.planned_end_week,
        plan_percent=stage.plan_percent,
        checked_in_this_week=stage.checked_in_this_week,
        last_checkin_week=stage.last_checkin_week,
        can_check_in=can_check_in,
    )


# --- POST /check-ins ------------------------------------------------------------------


def _blank_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _stage_state(row: ProjectWorkflowStep) -> dict[str, Any]:
    """Same shape as the Workspace PATCH audit; the reason by length only."""

    return {
        "step_id": row.step_template_id,
        "status": row.status.value,
        "percent_complete": row.percent_complete,
        "actual_start_week": row.actual_start_week,
        "actual_end_week": row.actual_end_week,
        "blocked_reason_length": len(row.blocked_reason) if row.blocked_reason else 0,
    }


def _server_filled(entry: CheckInEntry, row: ProjectWorkflowStep) -> dict[str, Any]:
    """The explicit update for `merge_stage_update`, with the weeks and the
    Done percent filled by the server (contract §5).
    """

    explicit: dict[str, Any] = {
        "status": entry.status,
        "percent_complete": entry.percent_complete,
        "blocked_reason": _blank_to_none(entry.blocked_reason),
    }
    if entry.status != WorkflowStepStatus.NOT_STARTED and row.actual_start_week is None:
        explicit["actual_start_week"] = dc.CURRENT_WEEK
    if entry.status == WorkflowStepStatus.DONE:
        explicit["actual_end_week"] = dc.CURRENT_WEEK
        explicit["percent_complete"] = 100
    return explicit


class _Planned:
    """One validated entry, ready to apply."""

    def __init__(
        self,
        entry: CheckInEntry,
        project: Project,
        row: ProjectWorkflowStep,
        merged: dict[str, Any],
    ) -> None:
        self.entry = entry
        self.project = project
        self.row = row
        self.merged = merged
        self.changed = any(getattr(row, name) != merged[name] for name in _PROGRESS_FIELDS)


async def _validate(
    db: AsyncSession,
    access: CheckInAccess,
    entries: list[CheckInEntry],
) -> tuple[list[_Planned], list[CheckInEntryError]]:
    project_ids = list({e.project_id for e in entries})
    projects = {
        p.id: p
        for p in (
            await db.execute(
                select(Project).options(selectinload(Project.hub)).where(
                    Project.id.in_(project_ids)
                )
            )
        ).scalars()
    }
    live_rows = {
        (r.project_id, r.step_template_id): r
        for r in (
            await db.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id.in_(project_ids))
            )
        ).scalars()
    }
    active_run = await get_active_run(db)
    run_assignees: dict[tuple[uuid.UUID, str], uuid.UUID | None] = {}
    if active_run is not None and project_ids:
        for pid, step_id, eid in (
            await db.execute(
                select(
                    ScheduleRunProjectStep.project_id,
                    ScheduleRunProjectStep.step_template_id,
                    ScheduleRunProjectStep.assigned_engineer_id,
                ).where(
                    ScheduleRunProjectStep.schedule_run_id == active_run.id,
                    ScheduleRunProjectStep.project_id.in_(project_ids),
                )
            )
        ).all():
            run_assignees[(pid, step_id)] = eid
    due = await due_stages_for(db, list(projects), active_run=active_run)
    due_keys = {(s.project_id, s.step_id) for stages in due.values() for s in stages}

    planned: list[_Planned] = []
    errors: list[CheckInEntryError] = []
    seen: set[tuple[uuid.UUID, str]] = set()

    def fail(index: int, code: CheckInErrorCode, message: str) -> None:
        errors.append(CheckInEntryError(index=index, code=code, message=message))

    for index, entry in enumerate(entries):
        key = (entry.project_id, entry.step_id)
        if key in seen:
            fail(index, "DUPLICATE_STAGE", "This stage appears more than once in the batch.")
            continue
        seen.add(key)
        project = projects.get(entry.project_id)
        row = live_rows.get(key)
        assignees = (
            row.assigned_engineer_id if row is not None else None,
            run_assignees.get(key),
        )
        if project is None or not access.can_write_stage(project, assignees):
            # Same answer for "does not exist", "out of scope" and "not
            # yours", so a check-in never reveals what exists.
            fail(index, "FORBIDDEN_STAGE", "You cannot check in this stage.")
            continue
        if project.frozen:
            fail(
                index,
                "PROJECT_FROZEN",
                "This project is frozen. Unfreeze on the Gantt to record stage progress.",
            )
            continue
        if row is not None and row.status == WorkflowStepStatus.DONE:
            fail(index, "STEP_DONE_IMMUTABLE", "A Done stage cannot be reported again.")
            continue
        if row is None or key not in due_keys:
            fail(index, "NOT_DUE", "This stage is not due this week.")
            continue
        merged, problems = merge_stage_update(row, _server_filled(entry, row))
        if problems:
            fail(
                index,
                "INCONSISTENT_PROGRESS",
                "; ".join(f"{name} {msg}" for name, msg in problems),
            )
            continue
        planned.append(_Planned(entry, project, row, merged))
    return planned, errors


@router.post("", response_model=CheckInResponse)
async def submit_check_ins(
    body: CheckInRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> CheckInResponse:
    allowed, retry_after = CHECKIN_RATE_LIMIT.allow(f"checkin:{current_user.user_id}")
    if not allowed:
        raise CodedHTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many check-in submissions. Please wait a moment and try again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )

    access = await resolve_access(db, current_user)
    planned, errors = await _validate(db, access, body.entries)
    if errors:
        raise CodedHTTPException(
            HTTP_422,
            "CHECKIN_INVALID",
            {
                "code": "CHECKIN_INVALID",
                "message": "The check-in was not saved: fix the stages listed in errors.",
                "errors": [e.model_dump() for e in errors],
            },
        )

    week = dc.CURRENT_WEEK
    by_project: dict[uuid.UUID, list[_Planned]] = defaultdict(list)
    for item in planned:
        by_project[item.project.id].append(item)

    before_states: dict[uuid.UUID, list[dict[str, Any]]] = defaultdict(list)
    blocked_now: list[_Planned] = []
    for item in planned:
        before_states[item.project.id].append(_stage_state(item.row))
        was_blocked = item.row.status == WorkflowStepStatus.BLOCKED
        for name, value in item.merged.items():
            setattr(item.row, name, value)
        if item.row.status == WorkflowStepStatus.BLOCKED and not was_blocked:
            blocked_now.append(item)
        db.add(
            StageCheckin(
                project_id=item.project.id,
                step_template_id=item.row.step_template_id,
                week=week,
                user_id=current_user.user_id,
                status=item.row.status,
                percent_complete=item.row.percent_complete,
                blocked_reason=item.row.blocked_reason,
                note=_blank_to_none(item.entry.note),
            )
        )
    await db.flush()

    changed_ids = [
        pid for pid, items in by_project.items() if any(i.changed for i in items)
    ]
    await mark_projects_stale(db, changed_ids)

    if blocked_now:
        names = dict(
            (
                await db.execute(
                    select(WorkflowStepTemplate.id, WorkflowStepTemplate.name).where(
                        WorkflowStepTemplate.id.in_({i.row.step_template_id for i in blocked_now})
                    )
                )
            ).tuples().all()
        )
        for item in blocked_now:
            await generate_stage_blocked_notifications(
                db,
                project=item.project,
                hub_name=item.project.hub.name.value,
                step_id=item.row.step_template_id,
                step_name=names.get(item.row.step_template_id, item.row.step_template_id),
                reason=item.row.blocked_reason or "",
                actor_user_id=current_user.user_id,
            )

    # ADR 0023 §1: one run per batch. Every accepted entry is a due stage, and
    # only schedulable projects have due stages, so "changed" is the test.
    recalc: CheckInRecalcStatus
    if not changed_ids:
        recalc = "not_needed"
    elif await find_in_flight_run(db, trigger_reason=TRIGGER_REASON) is not None:
        recalc = "deferred"
    else:
        recalc = "queued"
    baseline_id: uuid.UUID | None = None
    if recalc == "queued":
        active = await get_active_run(db)
        baseline_id = active.id if active is not None else None

    for pid, items in by_project.items():
        project = items[0].project
        db.add(
            AuditLogEntry(
                actor_user_id=current_user.user_id,
                action=AUDIT_ACTION,
                entity_type="Project",
                entity_id=str(pid),
                hub_id=project.hub_id,
                before_state={"project_id": str(pid), "stages": before_states[pid]},
                after_state={
                    "project_id": str(pid),
                    "week": week,
                    "stages": [
                        {
                            **_stage_state(i.row),
                            "note_length": len(_blank_to_none(i.entry.note) or ""),
                        }
                        for i in items
                    ],
                    "changed": pid in changed_ids,
                    "recalc_status": recalc,
                    "baseline_run_id": str(baseline_id) if baseline_id is not None else None,
                },
            )
        )

    response = CheckInResponse(
        week=week,
        accepted=len(planned),
        projects_marked_stale=changed_ids,
        recalc_status=recalc,
        schedule_run_id=None,
        baseline_run_id=None,
        task_id=None,
    )
    if recalc != "queued":
        await db.commit()
        return response

    # Commits the progress, the check-in rows, the audit rows and the QUEUED
    # run together, before the worker can read them (as the priority move).
    run = await create_queued_schedule_run(
        db,
        solver_type=SolverType.GREEDY,
        trigger_reason=TRIGGER_REASON,
        triggered_by_user_id=current_user.user_id,
    )
    async_result = run_greedy_schedule.delay(
        str(run.id),
        triggered_by_user_id=str(current_user.user_id),
        activate=True,
        # The worker's "finish moved" activity event names one project.
        recalc_project_id=str(changed_ids[0]) if len(changed_ids) == 1 else None,
    )
    run.celery_task_id = async_result.id
    db.add(run)
    for pid in changed_ids:
        db.add(
            AuditLogEntry(
                actor_user_id=current_user.user_id,
                action="project.recalculate_requested",
                entity_type="Project",
                entity_id=str(pid),
                hub_id=by_project[pid][0].project.hub_id,
                before_state=None,
                after_state={
                    "project_id": str(pid),
                    "schedule_run_id": str(run.id),
                    "schedule_run_version": run.version,
                    "celery_task_id": run.celery_task_id,
                    "trigger_reason": TRIGGER_REASON,
                },
            )
        )
    await db.commit()
    publish_progress(str(run.id), status="queued")
    return response.model_copy(
        update={
            "schedule_run_id": run.id,
            "baseline_run_id": baseline_id,
            "task_id": str(async_result.id),
        }
    )


# --- GET /check-ins/history -----------------------------------------------------------


@router.get("/history", response_model=list[CheckInHistoryRow])
async def get_check_in_history(
    project_id: uuid.UUID,
    step_id: str = Query(min_length=1, max_length=10),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_workspace_read),
) -> list[CheckInHistoryRow]:
    project = await get_scoped_project_or_404(db, project_id, current_user)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    rows = (
        await db.execute(
            select(StageCheckin, User.full_name)
            .join(User, User.id == StageCheckin.user_id)
            .where(
                StageCheckin.project_id == project.id,
                StageCheckin.step_template_id == step_id,
            )
            .order_by(StageCheckin.created_at.desc(), StageCheckin.week.desc())
            .limit(HISTORY_LIMIT)
        )
    ).all()
    return [
        CheckInHistoryRow(
            week=checkin.week,
            status=checkin.status,
            percent_complete=checkin.percent_complete,
            blocked_reason=checkin.blocked_reason,
            note=checkin.note,
            by=full_name,
            created_at=checkin.created_at,
        )
        for checkin, full_name in rows
    ]


