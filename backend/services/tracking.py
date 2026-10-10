"""Due stages, plan-based progress and per-project tracking status (ADR 0021
§1, §4, §5; DOMAIN_RULES "Weekly check-in and tracking status").

Served, never computed in the browser. Every reader of `tracking_status`
(Priority board, VIP, Gantt project row, `/dashboard/projects`, the check-in
page) calls `tracking_status_for` here, so they cannot disagree.

**Due stage** for week `CURRENT_WEEK`: not skipped, not `Done`, and either
its status is `In Progress` / `Blocked` or the active run's planned window
`[start_week, end_week]` (inclusive) for the stage contains `CURRENT_WEEK`.
Skipped is decided exactly as the Workspace decides it: the active run's
step row when the run has one, else a 0-week lead time or a lab step on a
project without certification testing (ADR 0007,
`services.workspace.is_step_skipped`).

**Decision beyond the contract:** only projects whose status is schedulable
have due stages. A Draft, On Hold, Commercialized or Cancelled project is out
of the plan, so it is `idle` and nothing on it is due (otherwise a cancelled
project with a stage left `In Progress` would show as overdue forever).

**Tracking status** (per project):
- `idle`: no due stage;
- `live`: every due stage has a check-in with `week == CURRENT_WEEK`;
- `overdue`: some due stage has no check-in in `CURRENT_WEEK` or
  `CURRENT_WEEK - 1` and has been due since at least `CURRENT_WEEK - 1`;
- `due`: otherwise.

"Due since" is the earliest of: the planned start (when the planned window
contains `CURRENT_WEEK`, or the stage is active and its planned start is
already past) and the recorded `actual_start_week` of an active stage. A
stage with neither became due this week.

**Plan-based progress** (`plan_percent`): the share of the planned window
elapsed at `CURRENT_WEEK`, clamped to 0..100. Display only; it is never
written into the progress fields (ADR 0021 §5, ADR 0023 §5).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from models.checkin import StageCheckin
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from services.active_run import get_active_run
from services.workspace import is_step_skipped

TrackingStatus = Literal["live", "due", "overdue", "idle"]

_ACTIVE_STATUSES = frozenset({WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED})


def plan_percent(
    planned_start_week: int | None,
    planned_end_week: int | None,
    current_week: int = dc.CURRENT_WEEK,
) -> int | None:
    """`clamp(round((CW − start + 1) / (end − start + 1) × 100), 0, 100)`,
    or `None` without a planned window.
    """

    if planned_start_week is None or planned_end_week is None:
        return None
    span = planned_end_week - planned_start_week + 1
    if span <= 0:
        return 100 if current_week >= planned_start_week else 0
    raw = round((current_week - planned_start_week + 1) / span * 100)
    return max(0, min(100, raw))


def _is_skipped(
    live: ProjectWorkflowStep,
    run_step: ScheduleRunProjectStep | None,
    kind: WorkflowStepKind | None,
    cert_required: bool,
) -> bool:
    """The Workspace rule (`services.workspace.build_workspace`): the active
    run's flag when the run has the step, else the lead-time/certification
    rule of ADR 0007.
    """

    if run_step is not None:
        return run_step.skipped
    return is_step_skipped(live.duration_weeks, kind or WorkflowStepKind.DESIGN, cert_required)


def stage_is_due(
    live: ProjectWorkflowStep,
    run_step: ScheduleRunProjectStep | None,
    *,
    kind: WorkflowStepKind | None,
    cert_required: bool,
    current_week: int = dc.CURRENT_WEEK,
) -> bool:
    """ADR 0021 §1 for one stage of a schedulable project."""

    if live.status == WorkflowStepStatus.DONE:
        return False
    if _is_skipped(live, run_step, kind, cert_required):
        return False
    if live.status in _ACTIVE_STATUSES:
        return True
    return run_step is not None and run_step.start_week <= current_week <= run_step.end_week


def due_since_week(
    live: ProjectWorkflowStep,
    run_step: ScheduleRunProjectStep | None,
    current_week: int = dc.CURRENT_WEEK,
) -> int:
    """The first week the (due) stage counted as due; see module docstring."""

    candidates: list[int] = []
    active = live.status in _ACTIVE_STATUSES
    if run_step is not None and run_step.start_week <= current_week and (
        active or current_week <= run_step.end_week
    ):
        candidates.append(run_step.start_week)
    if active and live.actual_start_week is not None:
        candidates.append(live.actual_start_week)
    return min(candidates) if candidates else current_week


@dataclass(frozen=True)
class DueStage:
    """One due stage, with what the check-in page and the status need."""

    project_id: uuid.UUID
    step_id: str
    step_name: str
    kind: WorkflowStepKind
    sequence_order: int
    status: WorkflowStepStatus
    percent_complete: int
    blocked_reason: str | None
    planned_start_week: int | None
    planned_end_week: int | None
    plan_percent: int | None
    due_since_week: int
    checked_in_this_week: bool
    checked_in_last_week: bool
    last_checkin_week: int | None
    #: The live row's assignee and the active run's assignee (either may be
    #: null). Used only for the Engineer own-stage rule, never served.
    assigned_engineer_ids: frozenset[uuid.UUID]


def status_from_due_stages(
    stages: Iterable[DueStage], current_week: int = dc.CURRENT_WEEK
) -> TrackingStatus:
    """ADR 0021 §4 for one project's due stages."""

    stages = list(stages)
    if not stages:
        return "idle"
    if all(s.checked_in_this_week for s in stages):
        return "live"
    for s in stages:
        recent = s.checked_in_this_week or s.checked_in_last_week
        if not recent and s.due_since_week <= current_week - 1:
            return "overdue"
    return "due"


@dataclass(frozen=True)
class _CheckinSummary:
    last_week: int | None
    this_week: bool
    previous_week: bool


async def _checkin_summaries(
    db: AsyncSession, project_ids: list[uuid.UUID], current_week: int
) -> dict[tuple[uuid.UUID, str], _CheckinSummary]:
    if not project_ids:
        return {}
    rows = await db.execute(
        select(
            StageCheckin.project_id,
            StageCheckin.step_template_id,
            func.max(StageCheckin.week),
            func.bool_or(StageCheckin.week == current_week),
            func.bool_or(StageCheckin.week == current_week - 1),
        )
        .where(StageCheckin.project_id.in_(project_ids))
        .group_by(StageCheckin.project_id, StageCheckin.step_template_id)
    )
    return {
        (pid, step): _CheckinSummary(
            last_week=last, this_week=bool(this_w), previous_week=bool(prev_w)
        )
        for pid, step, last, this_w, prev_w in rows.all()
    }


async def due_stages_for(
    db: AsyncSession,
    project_ids: Iterable[uuid.UUID],
    *,
    active_run: ScheduleRun | None = None,
    current_week: int = dc.CURRENT_WEEK,
) -> dict[uuid.UUID, list[DueStage]]:
    """`{project_id: [due stages in sequence order]}` for every requested
    project (a project with no due stage maps to `[]`). Reads the active run
    unless `active_run` is passed (callers that already loaded it).
    """

    ids = list(dict.fromkeys(project_ids))
    result: dict[uuid.UUID, list[DueStage]] = {pid: [] for pid in ids}
    if not ids:
        return result
    if active_run is None:
        active_run = await get_active_run(db)

    projects = {
        pid: (status, cert)
        for pid, status, cert in (
            await db.execute(
                select(Project.id, Project.status, Project.certification_testing_required).where(
                    Project.id.in_(ids)
                )
            )
        ).all()
    }
    schedulable = [
        pid for pid, (status, _cert) in projects.items() if status not in NON_SCHEDULABLE_STATUSES
    ]
    if not schedulable:
        return result

    templates = {
        t.id: t for t in (await db.execute(select(WorkflowStepTemplate))).scalars().all()
    }
    live_rows = (
        (
            await db.execute(
                select(ProjectWorkflowStep)
                .where(ProjectWorkflowStep.project_id.in_(schedulable))
                .order_by(ProjectWorkflowStep.project_id, ProjectWorkflowStep.sequence_order)
            )
        )
        .scalars()
        .all()
    )
    run_steps: dict[tuple[uuid.UUID, str], ScheduleRunProjectStep] = {}
    if active_run is not None:
        for step in (
            await db.execute(
                select(ScheduleRunProjectStep).where(
                    ScheduleRunProjectStep.schedule_run_id == active_run.id,
                    ScheduleRunProjectStep.project_id.in_(schedulable),
                )
            )
        ).scalars():
            run_steps[(step.project_id, step.step_template_id)] = step
    checkins = await _checkin_summaries(db, schedulable, current_week)

    grouped: dict[uuid.UUID, list[DueStage]] = defaultdict(list)
    for live in live_rows:
        key = (live.project_id, live.step_template_id)
        run_step = run_steps.get(key)
        template = templates.get(live.step_template_id)
        kind = template.kind if template is not None else WorkflowStepKind.DESIGN
        cert_required = projects[live.project_id][1]
        if not stage_is_due(
            live, run_step, kind=kind, cert_required=cert_required, current_week=current_week
        ):
            continue
        summary = checkins.get(key)
        planned_start = run_step.start_week if run_step is not None else None
        planned_end = run_step.end_week if run_step is not None else None
        assignees = {
            e
            for e in (
                live.assigned_engineer_id,
                run_step.assigned_engineer_id if run_step is not None else None,
            )
            if e is not None
        }
        grouped[live.project_id].append(
            DueStage(
                project_id=live.project_id,
                step_id=live.step_template_id,
                step_name=template.name if template is not None else live.step_template_id,
                kind=kind,
                sequence_order=live.sequence_order,
                status=live.status,
                percent_complete=live.percent_complete,
                blocked_reason=live.blocked_reason,
                planned_start_week=planned_start,
                planned_end_week=planned_end,
                plan_percent=plan_percent(planned_start, planned_end, current_week),
                due_since_week=due_since_week(live, run_step, current_week),
                checked_in_this_week=summary.this_week if summary else False,
                checked_in_last_week=summary.previous_week if summary else False,
                last_checkin_week=summary.last_week if summary else None,
                assigned_engineer_ids=frozenset(assignees),
            )
        )
    for pid, stages in grouped.items():
        result[pid] = sorted(stages, key=lambda s: s.sequence_order)
    return result


async def tracking_status_for(
    db: AsyncSession,
    project_ids: Iterable[uuid.UUID],
    *,
    active_run: ScheduleRun | None = None,
) -> dict[uuid.UUID, TrackingStatus]:
    """ADR 0021 §4: `{project_id: "live" | "due" | "overdue" | "idle"}` for
    every requested project. The one implementation every payload reuses.
    """

    due = await due_stages_for(db, project_ids, active_run=active_run)
    return {pid: status_from_due_stages(stages) for pid, stages in due.items()}
