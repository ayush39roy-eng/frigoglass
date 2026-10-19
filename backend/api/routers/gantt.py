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

**P9 (docs/API_CONTRACT_P9.md §5).** Rows carry the completion weeks
(`expected_end_week`, `projected_end_week`, `unconstrained_end_week`) from the
active run's outcome row, and `target_end_week`, `schedule_stale` and
`workflow_id` from the project, plus `slip_weeks = projected − expected`.
Step rows carry `kind` from the run's `workflow_snapshot`, `skipped` from
the run step, and `status`/`percent_complete` from the live progress row.
Nothing here is recomputed (I16).

**P12 (ADR 0019/0020, docs/API_CONTRACT_P12.md §3–§4).** Step rows also
carry `lead_time_weeks` (live lead-time value), the live planner inputs
`duration_override_weeks` / `start_not_before_week`, and `timing_editable`
(`services.step_timing.timing_editable`: ADR 0019 §4 AND GANTT write with the
project's hub in scope, the freeze toggle's check). `duration_weeks` is the
effective duration the active run booked. The drag itself is
`PATCH /projects/{id}/steps/{step_id}/timing` (`api/routers/step_timing.py`).
`hub_id` is ANDed with the scope / own-assignment filter and never widens it.

**P13-T13 (docs/API_CONTRACT_P13.md §7).** Toolbar filters (`q`, `category`,
`type`, `status_`, `leader_engineer_id`, `current_step`, `priority`) and
`sort`, all server-side and ANDed with the scope; row meta (`external_code`,
`type`, `leader_name` under the OQ #8 rule, booked `design/lab/total_weeks`);
and `weekly_active_counts` over the whole filtered set (see `get_gantt`).

**ADR 0028 / P15-R01.** `GanttStepRow.assigned_engineer_name` is served to every reader
(the owner decided to use the personal data); row scoping is unchanged.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Sequence
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import domain_constants as dc
from api.db import get_db
from api.deps import principal_can, require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from schemas.gantt import (
    FreezeToggleRequest,
    GanttProjectRow,
    GanttResponse,
    GanttStepRow,
    GanttWeeklyActiveCount,
)
from schemas.project import ProjectRead
from services.active_run import slip_weeks, step_kinds_for_run
from services.audit_helpers import project_audit_state
from services.hub_scope import (
    global_hub_filter,
    hub_scope_filter,
    is_engineer_self_scoped,
    is_hub_in_scope,
)
from services.project_cards import build_project_cards
from services.project_filters import (
    Q_MAX_LENGTH,
    STEP_CODE_MAX_LENGTH,
    leader_name_if_self,
    search_predicate,
)
from services.schedule_stale import mark_projects_stale
from services.step_timing import timing_editable
from services.tracking import tracking_status_for

router = APIRouter(prefix="/gantt", tags=["gantt"])


_read = require_permission(Surface.GANTT, Action.READ)
_write = require_permission(Surface.GANTT, Action.WRITE)

GanttSort = Literal["name", "priority", "start", "end"]

#: Band order for `sort=priority` (DOMAIN_RULES "Scheduling order"; the VIP
#: order rule: P1 → P4 → Q, then weighted score descending, then name). A null
#: priority is the Queue bucket, as in Capacity and the Board (P13 slice B).
_BAND_ORDER = {band: i for i, band in enumerate(dc.PRIORITY_ORDER)}
_QUEUE_BAND = _BAND_ORDER[ProjectPriority.Q.value]


def _kind_weeks(
    steps: Sequence[ScheduleRunProjectStep], kinds: dict[str, WorkflowStepKind]
) -> tuple[int | None, int | None, int | None]:
    """(design, lab, total) booked effective weeks over non-skipped run steps;
    all `None` when the project has no step in the active run."""

    if not steps:
        return None, None, None
    design = lab = total = 0
    for step in steps:
        if step.skipped:
            continue
        total += step.duration_weeks
        kind = kinds.get(step.step_template_id, WorkflowStepKind.DESIGN)
        if kind == WorkflowStepKind.DESIGN:
            design += step.duration_weeks
        elif kind == WorkflowStepKind.LAB:
            lab += step.duration_weeks
    return design, lab, total


def _weekly_active_counts(
    projects: Sequence[Project],
    steps_by_project: dict[uuid.UUID, list[ScheduleRunProjectStep]],
) -> list[GanttWeeklyActiveCount]:
    """Active non-skipped run steps per display week (1..WITHIN_YEAR_WEEK)
    over the whole filtered set, split by the project's workflow."""

    last = dc.WITHIN_YEAR_WEEK
    pdd = [0] * (last + 1)
    oem = [0] * (last + 1)
    for project in projects:
        counts = oem if project.workflow_id == dc.WORKFLOW_ID_FOR_OEM_HUB else pdd
        for step in steps_by_project.get(project.id, []):
            if step.skipped:
                continue
            for week in range(max(1, step.start_week), min(last, step.end_week) + 1):
                counts[week] += 1
    return [
        GanttWeeklyActiveCount(week=w, pdd=pdd[w], oem=oem[w]) for w in range(1, last + 1)
    ]


@router.get("", response_model=GanttResponse)
async def get_gantt(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    project_id: uuid.UUID | None = None,
    limit: int = 100,
    # P13-F12 (security-auditor Info-5): a negative offset would slice the
    # tail of the scoped list; reject it with 422.
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(max_length=Q_MAX_LENGTH)] = None,
    category: ProjectCategory | None = None,
    type_: Annotated[ProjectType | None, Query(alias="type")] = None,
    status_: ProjectStatus | None = None,
    leader_engineer_id: uuid.UUID | None = None,
    current_step: Annotated[str | None, Query(max_length=STEP_CODE_MAX_LENGTH)] = None,
    priority: Annotated[
        ProjectPriority | None,
        Query(
            description=(
                "P1..P4 match exactly. Q is the Queue bucket: priority Q OR no "
                "priority (the Capacity / Priority board rule)."
            )
        ),
    ] = None,
    sort: GanttSort = "name",
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> GanttResponse:
    """P13-T13 (docs/API_CONTRACT_P13.md §7): every filter is ANDed with the
    scope and the hub/country filter, server-side. `current_step` is the
    first step not Done and not skipped (the `/dashboard/projects` rule,
    `services.project_cards`). `priority=Q` is the Queue bucket: priority Q
    OR no priority (as Capacity and the Priority board classify it); P1..P4
    match exactly. `sort`: `name` (default), `priority` (band P1 → P4 → Queue,
    where Queue is Q or no priority, then weighted score descending, then
    name), `start`
    (earliest non-skipped planned start), `end` (`projected_end_week`);
    missing values sort last, ties by name then id. `total_count` and
    `weekly_active_counts` cover the whole filtered set; `limit`/`offset`
    page the rows only.
    """

    if limit < 1 or limit > 500:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 500")

    active_run = (
        await db.execute(select(ScheduleRun).where(ScheduleRun.is_active.is_(True)))
    ).scalar_one_or_none()
    if active_run is None:
        return GanttResponse(
            has_active_schedule_run=False,
            schedule_run_version=None,
            total_count=0,
            rows=[],
            weekly_active_counts=[],
        )

    stmt = select(Project).options(
        selectinload(Project.hub), selectinload(Project.leader_engineer)
    )
    own_engineer_id: uuid.UUID | None = None
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
    # ADR 0020 hub / ADR 0025 country, ANDed with the scope above.
    global_filter = global_hub_filter(Project.hub_id, hub_id, region)
    if global_filter is not None:
        stmt = stmt.where(global_filter)
    if project_id is not None:
        stmt = stmt.where(Project.id == project_id)
    # P13-T13: toolbar filters, all bound parameters (no SQL interpolation).
    if category is not None:
        stmt = stmt.where(Project.category == category)
    if type_ is not None:
        stmt = stmt.where(Project.type == type_)
    if status_ is not None:
        stmt = stmt.where(Project.status == status_)
    if leader_engineer_id is not None:
        stmt = stmt.where(Project.leader_engineer_id == leader_engineer_id)
    if priority == ProjectPriority.Q:
        # The Queue bucket (P13, same as Capacity / Priority board): Q or none.
        stmt = stmt.where(or_(Project.priority == priority, Project.priority.is_(None)))
    elif priority is not None:
        stmt = stmt.where(Project.priority == priority)
    search = search_predicate(q)
    if search is not None:
        stmt = stmt.where(search)
    filtered = list(
        (await db.execute(stmt.order_by(Project.name, Project.id))).scalars().all()
    )

    # The whole filtered set's run steps and outcomes: one query each. They
    # feed the derived filter, the sorts, the weekly counts and the page rows.
    planned_steps: dict[uuid.UUID, list[ScheduleRunProjectStep]] = defaultdict(list)
    outcomes: dict[uuid.UUID, ScheduleRunProjectOutcome] = {}
    if filtered:
        filtered_ids = [p.id for p in filtered]
        for step in (
            await db.execute(
                select(ScheduleRunProjectStep).where(
                    ScheduleRunProjectStep.schedule_run_id == active_run.id,
                    ScheduleRunProjectStep.project_id.in_(filtered_ids),
                )
            )
        ).scalars():
            planned_steps[step.project_id].append(step)
        outcomes = {
            o.project_id: o
            for o in (
                await db.execute(
                    select(ScheduleRunProjectOutcome).where(
                        ScheduleRunProjectOutcome.schedule_run_id == active_run.id,
                        ScheduleRunProjectOutcome.project_id.in_(filtered_ids),
                    )
                )
            ).scalars()
        }

    if current_step is not None or sort == "priority":
        # The register's current-step and score source (one batch pass).
        cards = await build_project_cards(db, filtered, active_run)
        if current_step is not None:
            filtered = [
                p
                for p in filtered
                if (stage := cards[p.id].current_stage) is not None
                and stage.step_id == current_step
            ]
        if sort == "priority":
            def _priority_key(p: Project) -> tuple[int, int, float, str, str]:
                score = cards[p.id].score
                band = (
                    _BAND_ORDER.get(p.priority.value, _QUEUE_BAND) if p.priority else _QUEUE_BAND
                )
                return (band, score is None, -(score or 0.0), p.name, str(p.id))

            filtered.sort(key=_priority_key)
    if sort == "start":

        def _start_key(p: Project) -> tuple[bool, int, str, str]:
            starts = [s.start_week for s in planned_steps.get(p.id, []) if not s.skipped]
            return (not starts, min(starts) if starts else 0, p.name, str(p.id))

        filtered.sort(key=_start_key)
    elif sort == "end":

        def _end_key(p: Project) -> tuple[bool, int, str, str]:
            outcome = outcomes.get(p.id)
            end = outcome.projected_end_week if outcome is not None else None
            return (end is None, end or 0, p.name, str(p.id))

        filtered.sort(key=_end_key)

    total_count = len(filtered)
    weekly_counts = _weekly_active_counts(filtered, planned_steps)
    projects = filtered[offset : offset + limit]
    project_ids = [p.id for p in projects]

    # ADR 0028 / P15-R01 (O3): the assignee name is served to every reader (the owner
    # decided to use the personal data); the scope of the rows is unchanged.

    templates = {
        t.id: t for t in (await db.execute(select(WorkflowStepTemplate))).scalars().all()
    }
    run_kinds = await step_kinds_for_run(db, active_run)
    engineer_names: dict[uuid.UUID, str] = {
        e.id: e.name for e in (await db.execute(select(Engineer))).scalars().all()
    }
    chamber_codes = {
        c.id: c.code for c in (await db.execute(select(Chamber))).scalars().all()
    }

    actual_steps: dict[tuple[uuid.UUID, str], ProjectWorkflowStep] = {}
    if project_ids:
        live_rows = (
            await db.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id.in_(project_ids))
            )
        ).scalars().all()
        for live in live_rows:
            actual_steps[(live.project_id, live.step_template_id)] = live

    # P12 (ADR 0019 §4): `timing_editable` also needs the caller's GANTT
    # write permission on the project, the same check as the freeze toggle
    # (GANTT/WRITE and the project's hub in scope).
    gantt_writer = principal_can(current_user, Surface.GANTT, Action.WRITE)

    # P12 (ADR 0021 §4): the one tracking-status implementation.
    tracking = await tracking_status_for(db, project_ids, active_run=active_run)

    gantt_rows: list[GanttProjectRow] = []
    for project in projects:
        outcome = outcomes.get(project.id)
        can_write_timing = gantt_writer and is_hub_in_scope(current_user, project.hub_id)
        schedulable = project.status not in NON_SCHEDULABLE_STATUSES
        expected = outcome.expected_end_week if outcome else None
        projected = outcome.projected_end_week if outcome else None
        step_rows: list[GanttStepRow] = []
        for step in sorted(planned_steps.get(project.id, []), key=lambda s: s.sequence_order):
            template = templates.get(step.step_template_id)
            actual = actual_steps.get((project.id, step.step_template_id))
            step_rows.append(
                GanttStepRow(
                    step_id=step.step_template_id,
                    step_name=template.name if template else step.step_template_id,
                    kind=run_kinds.get(step.step_template_id, WorkflowStepKind.DESIGN),
                    sequence_order=step.sequence_order,
                    skipped=step.skipped,
                    status=actual.status if actual else WorkflowStepStatus.NOT_STARTED,
                    percent_complete=actual.percent_complete if actual else 0,
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
                    lead_time_weeks=(
                        actual.duration_weeks if actual else step.duration_weeks
                    ),
                    duration_override_weeks=(
                        actual.duration_override_weeks if actual else None
                    ),
                    start_not_before_week=actual.start_not_before_week if actual else None,
                    timing_editable=timing_editable(
                        can_write=can_write_timing,
                        frozen=project.frozen,
                        schedulable=schedulable,
                        skipped=step.skipped or actual is None or actual.duration_weeks == 0,
                        step_status=actual.status if actual else WorkflowStepStatus.NOT_STARTED,
                    ),
                )
            )

        design_weeks, lab_weeks, total_weeks = _kind_weeks(
            planned_steps.get(project.id, []), run_kinds
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
                target_end_week=project.target_end_week,
                expected_end_week=expected,
                projected_end_week=projected,
                unconstrained_end_week=outcome.unconstrained_end_week if outcome else None,
                slip_weeks=slip_weeks(projected, expected),
                blocked=outcome.blocked if outcome else False,
                schedule_stale=project.schedule_stale,
                workflow_id=project.workflow_id,
                is_vip=project.is_vip,
                tracking_status=tracking.get(project.id, "idle"),
                external_code=project.external_code,
                type=project.type,
                leader_name=leader_name_if_self(project, current_user),
                leader_engineer_id=project.leader_engineer_id,
                design_weeks=design_weeks,
                lab_weeks=lab_weeks,
                total_weeks=total_weeks,
                steps=step_rows,
            )
        )

    return GanttResponse(
        has_active_schedule_run=True,
        schedule_run_version=active_run.version,
        total_count=total_count,
        rows=gantt_rows,
        weekly_active_counts=weekly_counts,
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
    inputs_before = (project.frozen, project.actual_start_week)
    project.frozen = body.frozen
    if body.actual_start_week is not None:
        project.actual_start_week = body.actual_start_week
    await db.flush()
    if (project.frozen, project.actual_start_week) != inputs_before:
        # P14-T01 (workflow-auditor finding S1): `frozen` and
        # `actual_start_week` are scheduler inputs, so a freeze or unfreeze
        # marks the project stale like every other input edit (ADR 0006).
        await mark_projects_stale(db, [project.id])
        await db.refresh(project, ["schedule_stale"])
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
