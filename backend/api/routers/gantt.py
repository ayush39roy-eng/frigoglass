"""Project Execution Timeline (Gantt) surface — read model + freeze toggle
(`docs/PROJECT_AND_STACK.md` §2).

`GET /gantt` sources planned weeks / `ENG_CONFLICT`/`OVERLAP` flags from the
active `ScheduleRun`'s `ScheduleRunProjectStep` snapshot, and `LEFT_OUT`/
`SPILLOVER`/`CAT_NOT_ALLOWED` from the active run's `ScheduleRunProjectOutcome`
— never recomputed, matching Invariant I9's spirit. Actual weeks come from
the live `ProjectWorkflowStep` row.

**RBAC (P3-T02)**: `GET /gantt` requires `GANTT`/`READ` (Portfolio Manager,
Hub Planner, Executive Viewer, Engineer, Admin — Auditor gets 403). The
freeze toggle requires `GANTT`/`WRITE` (Hub Planner/Admin only — Invariant
I10: "Applying priorities never mutates a `frozen` project's dates"). Does
NOT itself trigger a recalculation — a Hub Planner would separately call
`POST /schedule-runs/greedy-recalc` (or, later, the real Celery-dispatched
recalc, P3-T06) to see the freeze reflected in a new schedule run.

**Hub-scoped (P3-T03)**: `GET /gantt`'s project set is filtered per
`docs/PROJECT_AND_STACK.md` §5's row-level qualifiers, via
`services.hub_scope`:
- Hub Planner (`hub_scope_all=False`, non-empty `hub_ids`): filtered to
  their own hub(s), same as every other surface.
- Engineer (`hub_scope_all=False`, EMPTY `hub_ids` — Engineer is never
  hub-scoped per the matrix): filtered to "own assignments" — only projects
  with at least one active-run step assigned to the caller's own linked
  `Engineer` row (`Engineer.user_id == current_user.user_id`), narrower than
  a hub filter, per `services.hub_scope.is_engineer_self_scoped`.
- Portfolio Manager/Executive Viewer/Admin (`hub_scope_all=True`):
  unrestricted, unchanged.
The freeze toggle's project lookup is hub-scoped the same way as
`get_project` (Hub Planner/Admin only ever reach `GANTT`/`WRITE`, so the
Engineer "own assignments" branch never applies there).

**GDPR / OQ#8 dependency (P3-T09, security remediation, finding #1 — High):**
`GanttStepRow.assigned_engineer_name` is withheld (`None`) for every reader
except the Engineer role viewing their own self-scoped Gantt (see
`get_gantt`'s `show_engineer_names` gate). `docs/OPEN_QUESTIONS.md` #8 (GDPR
lawful basis for named-engineer utilization) is unresolved and hard-blocking.
Consciously reversible once the DPO signs off — see the gate's own comment
for exactly what to change and not change.
"""

from __future__ import annotations

import uuid
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.engineer import Engineer
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from schemas.gantt import (
    FreezeToggleRequest,
    GanttProjectRow,
    GanttResponse,
    GanttStepRow,
)
from schemas.project import ProjectRead
from services.audit_helpers import project_audit_state
from services.hub_scope import hub_scope_filter, is_engineer_self_scoped

router = APIRouter(prefix="/gantt", tags=["gantt"])

_read = require_permission(Surface.GANTT, Action.READ)
_write = require_permission(Surface.GANTT, Action.WRITE)


@router.get("", response_model=GanttResponse)
async def get_gantt(
    hub_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> GanttResponse:
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 500")

    active_run = (
        await db.execute(select(ScheduleRun).where(ScheduleRun.is_active.is_(True)))
    ).scalar_one_or_none()
    if active_run is None:
        return GanttResponse(
            has_active_schedule_run=False, schedule_run_version=None, total_count=0, rows=[]
        )

    stmt = select(Project).options(selectinload(Project.hub))
    if is_engineer_self_scoped(current_user):
        # Engineer role, per docs/PROJECT_AND_STACK.md §5: "R (own
        # assignments)" — narrower than (and instead of) a hub filter:
        # Engineer is never hub-scoped at all (`hub_scope_filter` would
        # incorrectly resolve to an always-false "in scope of zero hubs"
        # predicate for this principal shape — see `services.hub_scope.
        # is_engineer_self_scoped`'s docstring). Restrict to projects with
        # at least one active-run step assigned to the caller's own linked
        # Engineer row instead.
        own_engineer_id = (
            await db.execute(
                select(Engineer.id).where(Engineer.user_id == current_user.user_id)
            )
        ).scalar_one_or_none()
        if own_engineer_id is None:
            own_project_ids: set[uuid.UUID] = set()
        else:
            own_project_rows = await db.execute(
                select(ScheduleRunProjectStep.project_id)
                .where(
                    ScheduleRunProjectStep.schedule_run_id == active_run.id,
                    ScheduleRunProjectStep.assigned_engineer_id == own_engineer_id,
                )
                .distinct()
            )
            own_project_ids = {row[0] for row in own_project_rows.all()}
        stmt = stmt.where(Project.id.in_(own_project_ids))
    else:
        hub_filter = hub_scope_filter(current_user, Project.hub_id)
        if hub_filter is not None:
            stmt = stmt.where(hub_filter)
    if hub_id is not None:
        stmt = stmt.where(Project.hub_id == hub_id)
    if project_id is not None:
        stmt = stmt.where(Project.id == project_id)
    count_stmt = select(func.count()).select_from(stmt.with_only_columns(Project.id).subquery())
    total_count = (await db.execute(count_stmt)).scalar_one()
    projects = (
        (await db.execute(stmt.order_by(Project.name).limit(limit).offset(offset))).scalars().all()
    )
    project_ids = [p.id for p in projects]

    # P3-T09 (security remediation, finding #1 / OQ#8 dependency — GDPR):
    # `assigned_engineer_name` is only populated for a reader viewing their
    # OWN self-scoped Gantt (the Engineer role, per
    # `services.hub_scope.is_engineer_self_scoped` — every project in that
    # branch's result set is already restricted to the caller's own
    # assignments, so the name shown is always the caller's own name). Every
    # other reader (Hub Planner, Portfolio Manager, Executive Viewer, Admin)
    # never gets a name, regardless of who is actually assigned, pending DPO
    # sign-off on `docs/OPEN_QUESTIONS.md` #8. This mirrors the P4-T03
    # frontend decision but is now enforced server-side (security-auditor
    # P3-T08 finding #1, High). Reversible: once OQ#8 resolves, set this to
    # `True` unconditionally (or per whatever the DPO/ADR decides) — do not
    # do so before then.
    show_engineer_names = is_engineer_self_scoped(current_user)

    templates = {
        t.id: t for t in (await db.execute(select(WorkflowStepTemplate))).scalars().all()
    }
    engineer_names = (
        {e.id: e.name for e in (await db.execute(select(Engineer))).scalars().all()}
        if show_engineer_names
        else {}
    )
    chamber_codes = {
        c.id: c.code for c in (await db.execute(select(Chamber))).scalars().all()
    }

    planned_steps: dict = defaultdict(list)
    if project_ids:
        rows = (
            await db.execute(
                select(ScheduleRunProjectStep).where(
                    ScheduleRunProjectStep.schedule_run_id == active_run.id,
                    ScheduleRunProjectStep.project_id.in_(project_ids),
                )
            )
        ).scalars().all()
        for step in rows:
            planned_steps[step.project_id].append(step)

    actual_steps: dict = {}
    if project_ids:
        rows = (
            await db.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id.in_(project_ids))
            )
        ).scalars().all()
        for step in rows:
            actual_steps[(step.project_id, step.step_template_id)] = step

    outcomes: dict = {}
    if project_ids:
        rows = (
            await db.execute(
                select(ScheduleRunProjectOutcome).where(
                    ScheduleRunProjectOutcome.schedule_run_id == active_run.id,
                    ScheduleRunProjectOutcome.project_id.in_(project_ids),
                )
            )
        ).scalars().all()
        outcomes = {o.project_id: o for o in rows}

    gantt_rows: list[GanttProjectRow] = []
    for project in projects:
        outcome = outcomes.get(project.id)
        step_rows: list[GanttStepRow] = []
        for step in sorted(planned_steps.get(project.id, []), key=lambda s: s.sequence_order):
            template = templates.get(step.step_template_id)
            actual = actual_steps.get((project.id, step.step_template_id))
            step_rows.append(
                GanttStepRow(
                    step_id=step.step_template_id,
                    step_name=template.name if template else step.step_template_id,
                    kind=template.kind if template else "design",
                    sequence_order=step.sequence_order,
                    duration_weeks=step.duration_weeks,
                    planned_start_week=step.start_week,
                    planned_end_week=step.end_week,
                    actual_start_week=actual.actual_start_week if actual else None,
                    actual_end_week=actual.actual_end_week if actual else None,
                    assigned_engineer_name=(
                        engineer_names.get(step.assigned_engineer_id)
                        if step.assigned_engineer_id
                        else None
                    ),
                    assigned_chamber_code=(
                        chamber_codes.get(step.assigned_chamber_id)
                        if step.assigned_chamber_id
                        else None
                    ),
                    eng_conflict=step.eng_conflict,
                    chamber_overlap=step.chamber_overlap,
                )
            )

        gantt_rows.append(
            GanttProjectRow(
                project_id=project.id,
                project_name=project.name,
                hub=project.hub.name,
                category=project.category,
                priority=project.priority,
                frozen=project.frozen,
                delay_weeks=project.delay_weeks,
                left_out=outcome.left_out if outcome else False,
                spillover=outcome.spillover if outcome else False,
                cat_not_allowed=outcome.cat_not_allowed if outcome else False,
                steps=step_rows,
            )
        )

    return GanttResponse(
        has_active_schedule_run=True,
        schedule_run_version=active_run.version,
        total_count=total_count,
        rows=gantt_rows,
    )


@router.post("/projects/{project_id}/freeze", response_model=ProjectRead)
async def toggle_freeze(
    project_id: uuid.UUID,
    body: FreezeToggleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Project:
    """Freeze toggle, per `docs/PROJECT_AND_STACK.md` §2 ("A freeze toggle
    per project. Locks `actual_start`, excludes the project from
    re-scheduling"). Setting `frozen=True` without `actual_start_week`
    returns 422 (matches `scheduling.greedy`'s own input validation, so a
    frozen project this endpoint produces can never fail that check when fed
    into a later recalculation).
    """

    stmt = select(Project).where(Project.id == project_id)
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    if body.frozen and body.actual_start_week is None and project.actual_start_week is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "actual_start_week is required to freeze a project "
                "(DOMAIN_RULES.md booking rules)."
            ),
        )

    before_state = project_audit_state(project)
    project.frozen = body.frozen
    if body.actual_start_week is not None:
        project.actual_start_week = body.actual_start_week
    await db.flush()
    after_state = project_audit_state(project)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project.freeze" if body.frozen else "project.unfreeze",
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state=before_state,
            after_state=after_state,
        )
    )
    await db.commit()
    await db.refresh(project)
    return project
