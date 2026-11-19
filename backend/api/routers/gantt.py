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
  *(2026-10-21)* Engineer plus a hub-scoped role (PM, Hub Planner,
  Executive Viewer, Admin): that role's hub scope OR own assignments
  (`services.hub_scope.project_row_scope`, ADR 0012 MAX).
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

**P12 (ADR 0020, docs/API_CONTRACT_P12.md §4).** `duration_weeks` is the
effective duration the active run booked. `hub_id` is ANDed with the scope /
own-assignment filter and never widens it.

**P33-T12 (ADR 0046/0048, docs/API_CONTRACT_P33.md Part G).** Step rows are
read-only: per-project timing editing is retired, so `timing_editable`,
`duration_override_weeks`, `start_not_before_week` and `overlap_weeks` are
gone. Each step carries the project's template copy (`plan_weeks`, also
served as `lead_time_weeks`), the signed copied gap `gap_weeks`
(`plan_gap_weeks`: negative = parallel, positive = wait) and `own_effort`
(the step's kind follows the project's own effort figure, OR-1).

**P13-T13 (docs/API_CONTRACT_P13.md §7).** Toolbar filters (`q`, `category`,
`type`, `status_`, `leader_engineer_id`, `current_step`, `priority`) and
`sort`, all server-side and ANDed with the scope; row meta (`external_code`,
`type`, `leader_name` under the OQ #8 rule, booked `design/lab/total_weeks`);
and `weekly_active_counts` over the whole filtered set (see `get_gantt`).

**ADR 0028 / P15-R01.** `GanttStepRow.assigned_engineer_name` is served to every reader
(the owner decided to use the personal data); row scoping is unchanged.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import domain_constants as dc
from api.db import get_db
from api.deps import principal_can, require_permission, require_roles
from api.errors import CodedHTTPException
from api.query_params import (
    MAX_FILTER_VALUES,
    CategoryListQuery,
    CurrentStepListQuery,
    HubIdListQuery,
    LeaderListQuery,
    RegionListQuery,
    StatusListQuery,
    TypeListQuery,
)
from api.routers.projects import project_read_for
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import (
    ProjectPriority,
    RoleName,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from scheduling.effort_split import EffortSplitRejected
from scheduling.weeks import year_end, year_of, year_start
from schemas.gantt import (
    FreezeToggleRequest,
    GanttProjectRow,
    GanttResponse,
    GanttStepRow,
    GanttWeeklyActiveCount,
)
from schemas.project import ProjectRead
from schemas.step_pin import StepPinsRefusal, StepPinsRequest, StepPinsResponse
from services.active_run import slip_weeks, step_kinds_for_run
from services.audit_helpers import project_audit_state
from services.band_rank import band_sizes
from services.category_type_filter import any_of, category_type_filter
from services.delivery_serving import stored_far_finish
from services.edit_conflict import check_base, field_refs
from services.hub_scope import (
    global_hub_filter,
    hub_scope_filter,
    is_hub_in_scope,
    needs_own_assignments,
    project_row_scope,
)
from services.outcome_buckets import outcome_bucket, outcome_label, priority_label
from services.plan_clock import PlanClock, get_plan_clock
from services.project_cards import build_project_cards
from services.project_effort import (
    TRIGGER_UNFREEZE,
    rederive_project_effort,
    split_rejected_error,
    validate_effort_split,
)
from services.project_filters import (
    Q_MAX_LENGTH,
    leader_name_if_self,
    search_predicate,
)
from services.rate_limit import TokenBucketLimiter
from services.schedule_stale import mark_projects_stale
from services.step_pins import (
    can_write_pins,
    current_length_weeks,
    pin_block_reason,
    pin_clearable,
    run_pin_windows,
    save_step_pins,
    step_pin_lapsed,
)
from services.template_copy import share_lock_categories
from services.tracking import tracking_status_for
from services.workspace import row_effective_weeks, row_is_skipped, row_own_effort_kinds

router = APIRouter(prefix="/gantt", tags=["gantt"])


_read = require_permission(Surface.GANTT, Action.READ)
_write = require_permission(Surface.GANTT, Action.WRITE)
#: P40 (ADR 0054 R40-2): pins are written by the Admin / Super Admin ROLES only.
_pin_writer = require_roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)

#: P40-F01 (security S40-M1): each pin save takes project row locks and can
#: dispatch a greedy run, so it is limited per user like the register save
#: (`REGISTER_EDITS_RATE_LIMIT`): a burst of 10, then one every 6 seconds.
#: Checked after authentication and the role check (401 / 403 come first),
#: before any lock. Per API process (`services.rate_limit`).
STEP_PINS_RATE_LIMIT = TokenBucketLimiter(capacity=10, refill_per_second=1 / 6)

GanttSort = Literal["name", "priority", "start", "end"]

#: Band order for `sort=priority` (DOMAIN_RULES "Scheduling order"; the VIP
#: order rule: P1 → P4 → Q, then weighted score descending, then name). A null
#: priority is the Queue bucket, as in Capacity and the Board (P13 slice B).
_BAND_ORDER = {band: i for i, band in enumerate(dc.PRIORITY_ORDER)}
_QUEUE_BAND = _BAND_ORDER[ProjectPriority.Q.value]


def _served_span_fte(
    step: ScheduleRunProjectStep,
    *,
    can_write_timing: bool,
    frozen: bool,
    live_status: WorkflowStepStatus | None,
) -> float | None:
    """`GanttStepRow.span_fte` (P20-T02, ADR 0032): the run's stored
    `span_fte`, served only to a caller who may edit this project's step
    timing (OQ #8), and never for a step that cannot be dragged because it is
    skipped, Done (live) or in a frozen project. The run already stores NULL
    for lab / elapsed / skipped / Done steps, frozen projects and no leader.
    """

    if not can_write_timing or frozen or step.skipped or step.span_fte is None:
        return None
    if live_status == WorkflowStepStatus.DONE:
        return None
    return float(step.span_fte)


def _kind_of(templates: Mapping[str, WorkflowStepTemplate], step_id: str) -> WorkflowStepKind:
    template = templates.get(step_id)
    return template.kind if template is not None else WorkflowStepKind.DESIGN


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


async def last_finish_week(db: AsyncSession, run: ScheduleRun) -> int:
    """P53 (R53-6): the largest end week of a non-skipped row of the RUN (not
    of the filtered page, so every filtered slice shares one axis), never
    below `year_end(Y0)`, rounded up to a year end. The Timeline axis ends
    here, never at the search limit H."""

    y_end = year_end(year_of(run.current_week))
    last = (
        await db.execute(
            select(func.max(ScheduleRunProjectStep.end_week)).where(
                ScheduleRunProjectStep.schedule_run_id == run.id,
                ScheduleRunProjectStep.skipped.is_(False),
            )
        )
    ).scalar_one_or_none()
    return year_end(year_of(max(last or y_end, y_end)))


def _weekly_active_counts(
    projects: Sequence[Project],
    steps_by_project: dict[uuid.UUID, list[ScheduleRunProjectStep]],
    *,
    first: int,
    last: int,
) -> list[GanttWeeklyActiveCount]:
    """Active non-skipped run steps per display week, `first..last` (P53
    R53-6: `year_start(Y0)..last_finish_week`; ADR 0062 extended the Timeline
    past W52) over the whole filtered set, split by the project's workflow, and
    (P40-T01) by step code (`by_step`, the step id such as `"PDD-A"`; same
    rows, so it sums to `pdd + oem`)."""

    pdd = [0] * (last + 1)
    oem = [0] * (last + 1)
    by_step: list[dict[str, int]] = [defaultdict(int) for _ in range(last + 1)]
    for project in projects:
        counts = oem if project.workflow_id == dc.WORKFLOW_ID_FOR_OEM_HUB else pdd
        for step in steps_by_project.get(project.id, []):
            if step.skipped:
                continue
            code = step.step_template_id
            for week in range(max(first, step.start_week), min(last, step.end_week) + 1):
                counts[week] += 1
                by_step[week][code] += 1
    return [
        GanttWeeklyActiveCount(
            week=w, pdd=pdd[w], oem=oem[w], by_step=dict(sorted(by_step[w].items()))
        )
        for w in range(first, last + 1)
    ]


def _current_step_counts(
    projects: Sequence[Project],
    steps_by_project: dict[uuid.UUID, list[ScheduleRunProjectStep]],
    week: int,
) -> dict[str, int]:
    """P40-T01: per step code, the projects of the filtered set with a
    non-skipped run step covering `week` (the `weekly_active_counts`
    definition at one week; a project counts once per step)."""

    counts: dict[str, set[uuid.UUID]] = defaultdict(set)
    for project in projects:
        for step in steps_by_project.get(project.id, []):
            if step.skipped or not (step.start_week <= week <= step.end_week):
                continue
            counts[step.step_template_id].add(project.id)
    return {code: len(ids) for code, ids in sorted(counts.items())}


@router.get("", response_model=GanttResponse)
async def get_gantt(
    hub_id: HubIdListQuery = None,
    region: RegionListQuery = None,
    project_id: uuid.UUID | None = None,
    limit: int = 100,
    # P13-F12 (security-auditor Info-5): a negative offset would slice the
    # tail of the scoped list; reject it with 422.
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(max_length=Q_MAX_LENGTH)] = None,
    category: CategoryListQuery = None,
    type_: TypeListQuery = None,
    status_: StatusListQuery = None,
    leader_engineer_id: LeaderListQuery = None,
    current_step: CurrentStepListQuery = None,
    priority: Annotated[
        list[ProjectPriority] | None,
        Query(
            description=(
                "Repeatable (ORed). P1..P4 match exactly. Q is the Queue bucket: "
                "priority Q OR no priority (the Capacity / Priority board rule). "
                f"At most {MAX_FILTER_VALUES} values."
            ),
            max_length=MAX_FILTER_VALUES,
        ),
    ] = None,
    sort: GanttSort = "name",
    include_unplaced: Annotated[
        bool,
        Query(
            description=(
                "P40: also list each project's live steps that have no row in the active "
                "run (planned weeks null), so their pins can be edited."
            )
        ),
    ] = False,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
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
    # Engineer role, per docs/PROJECT_AND_STACK.md §5: "R (own assignments)"
    # = projects with at least one active-run step assigned to the caller's
    # own linked Engineer row. ADR 0012 (MAX over the rules): a caller who
    # also holds a hub-scoped role gets that hub scope OR their own
    # assignments, never the narrower set alone (2026-10-21 multi-role fix,
    # `services.hub_scope.project_row_scope`).
    own: ColumnElement[bool] | None = None
    if needs_own_assignments(current_user):
        own_engineer_id = (
            await db.execute(
                select(Engineer.id).where(Engineer.user_id == current_user.user_id)
            )
        ).scalar_one_or_none()
        if own_engineer_id is not None:
            own = Project.id.in_(
                select(ScheduleRunProjectStep.project_id).where(
                    ScheduleRunProjectStep.schedule_run_id == active_run.id,
                    ScheduleRunProjectStep.assigned_engineer_id == own_engineer_id,
                )
            )
    scope = project_row_scope(current_user, Project.hub_id, own)
    if scope is not None:
        stmt = stmt.where(scope)
    # ADR 0020 hub / ADR 0025 country, ANDed with the scope above.
    global_filter = global_hub_filter(Project.hub_id, hub_id, region)
    if global_filter is not None:
        stmt = stmt.where(global_filter)
    if project_id is not None:
        stmt = stmt.where(Project.id == project_id)
    # P13-T13: toolbar filters, all bound parameters (no SQL interpolation).
    # P31: OR within `category` / `type`, AND across; ANDed with the scope.
    selection = category_type_filter(category, type_)
    if selection is not None:
        stmt = stmt.where(selection)
    # ADR 0051: status / leader / priority are lists (OR within, AND across).
    for column, values in (
        (Project.status, status_),
        (Project.leader_engineer_id, leader_engineer_id),
    ):
        predicate = any_of(column, values)
        if predicate is not None:
            stmt = stmt.where(predicate)
    priority_filter = any_of(Project.priority, priority)
    if priority_filter is not None and ProjectPriority.Q in (priority or ()):
        # The Queue bucket (P13, same as Capacity / Priority board): Q or none.
        priority_filter = or_(priority_filter, Project.priority.is_(None))
    if priority_filter is not None:
        stmt = stmt.where(priority_filter)
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

    if current_step or sort == "priority":
        # The register's current-step and score source (one batch pass).
        cards = await build_project_cards(db, filtered, active_run, current_week=clock.week)
        if current_step:
            steps = set(current_step)
            filtered = [
                p
                for p in filtered
                if (stage := cards[p.id].current_stage) is not None and stage.step_id in steps
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
    templates = {
        t.id: t for t in (await db.execute(select(WorkflowStepTemplate))).scalars().all()
    }
    run_week = active_run.current_week
    axis_end = await last_finish_week(db, active_run)
    weekly_counts = _weekly_active_counts(
        filtered, planned_steps, first=year_start(year_of(run_week)), last=axis_end
    )
    current_counts = _current_step_counts(filtered, planned_steps, clock.week)
    projects = filtered[offset : offset + limit]
    project_ids = [p.id for p in projects]

    # ADR 0028 / P15-R01 (O3): the assignee name is served to every reader (the owner
    # decided to use the personal data); the scope of the rows is unchanged.

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
    # ADR 0046 OR-1: per project, the kinds that follow its own effort figure.
    live_by_project: dict[uuid.UUID, list[ProjectWorkflowStep]] = {}
    for live in actual_steps.values():
        live_by_project.setdefault(live.project_id, []).append(live)
    own_kinds = {
        pid: row_own_effort_kinds(rows, templates) for pid, rows in live_by_project.items()
    }

    # P20-T02 (OQ #8): `span_fte` is served only with the caller's GANTT
    # write permission on the project, the same check as the freeze toggle
    # (GANTT/WRITE and the project's hub in scope).
    gantt_writer = principal_can(current_user, Surface.GANTT, Action.WRITE)

    # P12 (ADR 0021 §4): the one tracking-status implementation.
    tracking = await tracking_status_for(
        db, project_ids, active_run=active_run, current_week=clock.week
    )
    # P40-R02: the pins the active run was solved with, for the per-step
    # `pin_lapsed` (stored values compared; the browser derives nothing).
    run_pins = run_pin_windows(active_run.workflow_snapshot if active_run else None)

    gantt_rows: list[GanttProjectRow] = []
    for project in projects:
        outcome = outcomes.get(project.id)
        can_write_timing = gantt_writer and is_hub_in_scope(current_user, project.hub_id)
        project_own_kinds = own_kinds.get(project.id, frozenset())
        expected = outcome.expected_end_week if outcome else None
        projected = outcome.projected_end_week if outcome else None
        leader_fte = (
            float(project.leader_engineer.fte) if project.leader_engineer is not None else None
        )

        def _pin_fields(
            step_id: str,
            run_step: ScheduleRunProjectStep | None,
            live: ProjectWorkflowStep | None,
            *,
            project: Project = project,
            project_own_kinds: frozenset[str] = project_own_kinds,
            leader_fte: float | None = leader_fte,
        ) -> dict[str, object]:
            """P40 (R40-2 / R40-13): the live pin, the run's pin flags, the
            current length and the caller's editability of one step."""

            kind = _kind_of(templates, step_id)
            own = kind.value in project_own_kinds
            cert = project.certification_testing_required
            skipped = (
                row_is_skipped(live, kind, cert, own_effort=own) if live is not None else True
            )
            eff = row_effective_weeks(live, kind, cert, own_effort=own) if live else 0
            reason = pin_block_reason(current_user, project, live, skipped=skipped)
            return {
                "pin_lapsed": step_pin_lapsed(
                    run_step, run_pins.get((str(project.id), step_id))
                ),
                "pin_clearable": pin_clearable(current_user, project, live),
                "manual_start_week": live.manual_start_week if live else None,
                "manual_end_week": live.manual_end_week if live else None,
                "pinned": bool(run_step.pinned) if run_step is not None else False,
                "manual_overlap": (
                    bool(run_step.manual_overlap) if run_step is not None else False
                ),
                "current_length_weeks": current_length_weeks(
                    row=live,
                    run_step=run_step,
                    eff=eff,
                    kind=kind,
                    frozen=project.frozen,
                    leader_fte=leader_fte,
                ),
                "pin_editable": reason is None,
                "pin_block_reason": reason,
            }

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
                    # P33-T08: the project's own copy of its template length.
                    lead_time_weeks=(
                        actual.plan_weeks if actual else step.duration_weeks
                    ),
                    effort_weeks=actual.effort_weeks if actual else None,
                    # P33-T12 (contract Part G): the template copy, read-only.
                    plan_weeks=actual.plan_weeks if actual else step.duration_weeks,
                    gap_weeks=actual.plan_gap_weeks if actual else 0,
                    own_effort=(
                        _kind_of(templates, step.step_template_id).value in project_own_kinds
                    ),
                    predecessor_ids=sorted(template.predecessor_ids or []) if template else [],
                    span_fte=_served_span_fte(
                        step,
                        can_write_timing=can_write_timing,
                        frozen=project.frozen,
                        live_status=actual.status if actual else None,
                    ),
                    **_pin_fields(step.step_template_id, step, actual),
                )
            )
        if include_unplaced:
            # P40: the project's live steps with no active-run row (a project
            # the run left out, did not schedule, or that changed since), so
            # their pins can be edited. Planned weeks and run fields are null.
            placed = {s.step_template_id for s in planned_steps.get(project.id, [])}
            for live in sorted(
                live_by_project.get(project.id, []), key=lambda r: r.sequence_order
            ):
                if live.step_template_id in placed:
                    continue
                template = templates.get(live.step_template_id)
                kind = _kind_of(templates, live.step_template_id)
                pin = _pin_fields(live.step_template_id, None, live)
                step_rows.append(
                    GanttStepRow(
                        step_id=live.step_template_id,
                        step_name=template.name if template else live.step_template_id,
                        kind=kind,
                        sequence_order=live.sequence_order,
                        skipped=row_is_skipped(
                            live,
                            kind,
                            project.certification_testing_required,
                            own_effort=kind.value in project_own_kinds,
                        ),
                        status=live.status,
                        percent_complete=live.percent_complete,
                        duration_weeks=None,
                        planned_start_week=None,
                        planned_end_week=None,
                        actual_start_week=live.actual_start_week,
                        actual_end_week=live.actual_end_week,
                        assigned_engineer_name=None,
                        assigned_chamber_code=None,
                        eng_conflict=False,
                        chamber_overlap=False,
                        lead_time_weeks=live.plan_weeks,
                        effort_weeks=live.effort_weeks,
                        plan_weeks=live.plan_weeks,
                        gap_weeks=live.plan_gap_weeks,
                        own_effort=kind.value in project_own_kinds,
                        predecessor_ids=(
                            sorted(template.predecessor_ids or []) if template else []
                        ),
                        span_fte=None,
                        **pin,
                    )
                )
            step_rows.sort(key=lambda r: r.sequence_order)

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
                pin_lapsed=bool(outcome.pin_lapsed) if outcome else False,
                manual_overlap=bool(outcome.manual_overlap) if outcome else False,
                priority_label=priority_label(project.priority),
                counts_toward_year=outcome.counts_toward_year if outcome else True,
                not_scheduled_priority=outcome.not_scheduled_priority if outcome else False,
                outcome=outcome_bucket(outcome),
                outcome_label=outcome_label(outcome, projected),
                steps=step_rows,
                far_finish=stored_far_finish(outcome, run_week) if outcome else False,
            )
        )

    return GanttResponse(
        has_active_schedule_run=True,
        schedule_run_version=active_run.version,
        total_count=total_count,
        rows=gantt_rows,
        weekly_active_counts=weekly_counts,
        current_step_counts=current_counts,
        current_week=clock.week,
        plan_year_start_week=year_start(year_of(run_week)),
        plan_year_end_week=year_end(year_of(run_week)),
        last_finish_week=axis_end,
    )


@router.post("/projects/{project_id}/freeze", response_model=ProjectRead)
async def toggle_freeze(
    project_id: uuid.UUID,
    body: FreezeToggleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> ProjectRead:
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
    if body.base:
        # P47 (ADR 0059 C1): lock and re-read the row, then compare `base`.
        # An unfreeze may re-copy the template (OR-5), so the category's
        # FOR SHARE comes before the row lock, as below.
        if not body.frozen:
            await share_lock_categories(db, [project.category])
        project = (
            await db.execute(
                stmt.with_for_update().execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if project is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
        if project.frozen and not body.frozen and not can_write_pins(current_user):
            # P47-R01 (M-1): the unfreeze permission (same 403 as below)
            # before the comparison.
            raise CodedHTTPException(
                status.HTTP_403_FORBIDDEN,
                "UNFREEZE_REQUIRES_ADMIN",
                "Only an Admin or Super Admin can unfreeze a project.",
            )
        requested: dict[str, object] = {"frozen": body.frozen}
        if body.actual_start_week is not None:
            requested["actual_start_week"] = body.actual_start_week
        await check_base(
            db,
            current_user,
            entity="project",
            entity_id=project.id,
            label=project.name,
            base=body.base,
            requested=requested,
            current={"frozen": project.frozen, "actual_start_week": project.actual_start_week},
            refs=field_refs("Project", str(project.id)),
            hub_id=project.hub_id,
        )

    if body.frozen and body.actual_start_week is None and project.actual_start_week is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "actual_start_week is required to freeze a project "
                "(DOMAIN_RULES.md booking rules)."
            ),
        )

    unfreezing = project.frozen and not body.frozen
    if unfreezing and not can_write_pins(current_user):
        # P40 (ADR 0054 R40-10): only the Admin and Super Admin roles may
        # unfreeze. Freezing keeps GANTT/WRITE.
        raise CodedHTTPException(
            status.HTTP_403_FORBIDDEN,
            "UNFREEZE_REQUIRES_ADMIN",
            "Only an Admin or Super Admin can unfreeze a project.",
        )
    if unfreezing and (
        project.design_effort_weeks is not None or project.lab_effort_weeks is not None
    ):
        # ADR 0041 R7 before anything is written: a lead-time edit made while
        # the project was frozen could have pushed its split above 104 weeks.
        hub_is_oem = (
            await db.execute(select(Hub.is_oem).where(Hub.id == project.hub_id))
        ).scalar_one()
        try:
            await validate_effort_split(
                db,
                hub_is_oem=hub_is_oem,
                category=project.category,
                design_effort_weeks=project.design_effort_weeks,
                lab_effort_weeks=project.lab_effort_weeks,
                certification_testing_required=project.certification_testing_required,
                project_id=project.id,
            )
        except EffortSplitRejected as exc:
            raise split_rejected_error(exc) from exc
    before_state = project_audit_state(project)
    inputs_before = (project.frozen, project.actual_start_week)
    if unfreezing:
        # P33-T10 ruling (OR-5): the re-derivation below may re-copy the
        # template; the category's FOR SHARE before this write locks the row.
        await share_lock_categories(db, [project.category])
    project.frozen = body.frozen
    if body.actual_start_week is not None:
        project.actual_start_week = body.actual_start_week
    await db.flush()
    if unfreezing:
        # ADR 0041 R6: re-derivation is a no-op while frozen (I10), so the
        # effort split catches up on unfreeze (same transaction, own audit
        # row). The figures were validated (R7) when they were written.
        await rederive_project_effort(
            db, project, trigger=TRIGGER_UNFREEZE, actor_user_id=current_user.user_id
        )
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
    # P47-R01 (M-2): financial fields only for Project Registration READ.
    return project_read_for(project, current_user, await band_sizes(db))


@router.put(
    "/step-pins",
    response_model=StepPinsResponse,
    responses={
        404: {"model": StepPinsRefusal, "description": "PROJECT_NOT_FOUND"},
        409: {
            "model": StepPinsRefusal,
            "description": "PROJECT_FROZEN / PROJECT_CLOSED / STEP_STARTED / STEP_SKIPPED",
        },
    },
)
async def save_pins(
    body: StepPinsRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_pin_writer),
    clock: PlanClock = Depends(get_plan_clock),
) -> StepPinsResponse:
    """P40 (ADR 0054 R40-1 / R40-2 / R40-11; docs/API_CONTRACT_P40.md §1):
    save manual step Start / End weeks, one all-or-nothing batch.

    Admin and Super Admin roles only (403 otherwise, a project grant does not
    count). Hub-scoped: a project out of scope reads as 404
    `PROJECT_NOT_FOUND`. The week domain is checked against the request's
    `plan_clock` week. Refusals: 422 `DUPLICATE_STEP` / `PIN_INVALID` /
    `UNKNOWN_STEP` / `PIN_OUT_OF_RANGE`, 409 `PROJECT_FROZEN` /
    `PROJECT_CLOSED` / `STEP_STARTED` / `STEP_SKIPPED`; nothing is written.
    On success: one audit row per changed pair, `schedule_stale` on the
    changed projects and ONE greedy run (`trigger_reason="step_pin"`, the
    priority move's lifecycle and `X-Schedule-*` headers). Never solves
    in-process. 429 `RATE_LIMITED` with `Retry-After` past the per-user
    limit (`STEP_PINS_RATE_LIMIT`), before any lock.
    """

    allowed, retry_after = STEP_PINS_RATE_LIMIT.allow(f"step-pins:{current_user.user_id}")
    if not allowed:
        raise CodedHTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many pin saves. Please wait a moment and try again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )

    result = await save_step_pins(db, body.items, current_user, current_week=clock.week)
    response.headers.update(result.response_headers())
    outcome = result.outcome
    return StepPinsResponse(
        changes=result.changes,
        unchanged_count=result.unchanged_count,
        projects_marked_stale=result.projects_marked_stale,
        current_week=result.current_week,
        recalc_status=outcome.recalc_status,
        schedule_run_id=outcome.schedule_run_id,
        baseline_run_id=outcome.baseline_run_id,
        task_id=outcome.task_id,
    )
