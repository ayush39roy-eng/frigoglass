"""Workflow Settings (docs/API_CONTRACT_P9.md §3; ADRs 0007, 0008, 0009, 0010).

**RBAC.** Surface `workflow_settings`: Admin READ, Super Admin READ + WRITE.
`PUT /workflow-settings/chambers/{id}` is also the Capacity Planning path for
chamber downtime. A caller with `capacity_planning` WRITE (Hub Planner,
Admin) may use it for chambers in their own lab region(s)
(`services.hub_scope.scoped_lab_regions`, the P3-T03 chamber pattern). An
out-of-scope chamber is a 404, exactly like a missing one.

A chamber-PUT caller without `workflow_settings` READ (a Hub Planner) gets
back a payload *scoped to what they may see*: empty `workflows` and
`lead_times`, and only the hub calendars and chambers inside their scope.
The contract says every PUT "returns the full GET payload"; returning the
full lead-time table and every hub's calendar to a role with "–" on
Workflow Settings would contradict the §5 matrix. This is a recorded
deviation (docs/MEMORY.md P9-T03).

**Every successful PUT** writes one audit row, sets `schedule_stale = true`
on every schedulable project (`services.schedule_stale.
mark_all_schedulable_stale`; it never solves), and returns the count in
`X-Schedule-Stale-Count`. A lead-time edit also recomputes every live
`ProjectWorkflowStep.duration_weeks` through `services.workflow_durations`.

**Precedence validation (steps PUT).** The final authority is the
scheduler's own `scheduling.workflow.build_workflows`, called on the
proposed templates, so the API accepts exactly what the solver accepts
(I15). That function raises one generic `ValueError` type. A thin
pre-check runs first to pick the contract's specific 422 `code`:
`BAD_STEP_SET` (not exactly the workflow's 14 steps), `SELF_REFERENCE`,
`BAD_PREDECESSOR` (unknown, cross-workflow or duplicated reference),
`EMPTY_PREDECESSORS` (a non-first step with none). Whatever
`build_workflows` still rejects after that is a cycle (`CYCLE`). Changing a
step away from `lab` while a chamber lists it in `allowed_stages` is
rejected with `KIND_IN_USE` (I4: chambers book lab-kind steps only).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import any_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import domain_constants as dc
from api.db import get_db
from api.deps import get_current_principal, principal_can, require_permission
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.enums import OEM_PROJECT_CATEGORIES, ProjectCategory, WorkflowStepKind
from models.hub import Hub, HubWorkCalendar
from models.user import User
from models.workflow import Workflow, WorkflowLeadTime, WorkflowStepTemplate
from scheduling.types import WorkflowStepTemplate as SchedWorkflowStepTemplate
from scheduling.workflow import build_workflows
from schemas.workflow_settings import (
    ChamberSetting,
    ChamberSettingUpdateRequest,
    HubCalendarSetting,
    HubCalendarUpdateRequest,
    LeadTimeSetting,
    LeadTimesUpdateRequest,
    StepsUpdateRequest,
    WorkflowSetting,
    WorkflowSettings,
    WorkflowStepSetting,
)
from services.audit_helpers import chamber_audit_state
from services.capacity_supply import (
    calendar_figures,
    chamber_figures,
    load_calendars_by_region,
    region_holiday_weeks,
    round2,
)
from services.hub_scope import hub_scope_filter, scoped_lab_regions
from services.schedule_stale import mark_all_schedulable_stale
from services.workflow_durations import recompute_step_durations

router = APIRouter(prefix="/workflow-settings", tags=["workflow-settings"])

_read = require_permission(Surface.WORKFLOW_SETTINGS, Action.READ)
_write = require_permission(Surface.WORKFLOW_SETTINGS, Action.WRITE)

STALE_COUNT_HEADER = "X-Schedule-Stale-Count"
AUDIT_ACTION_PREFIX = "workflow_settings."


def categories_for_workflow(workflow_id: str) -> frozenset[ProjectCategory]:
    """`OEM` uses the three OEM categories; every other workflow uses A+/A/B/C
    (DOMAIN_RULES "Lead times").
    """

    if workflow_id == dc.WORKFLOW_ID_FOR_OEM_HUB:
        return OEM_PROJECT_CATEGORIES
    return frozenset(ProjectCategory) - OEM_PROJECT_CATEGORIES


# --- Read model --------------------------------------------------------------


async def build_settings_payload(
    db: AsyncSession, principal: Principal, *, full: bool
) -> WorkflowSettings:
    """The `GET` payload. With `full=False` (a chamber-PUT caller without
    Workflow Settings READ) workflows and lead times are omitted, and
    calendars and chambers are limited to the caller's scope.
    """

    workflows: list[WorkflowSetting] = []
    lead_times: list[LeadTimeSetting] = []
    template_times: list[datetime] = []
    if full:
        wf_rows = (
            (
                await db.execute(
                    select(Workflow)
                    .options(selectinload(Workflow.step_templates))
                    .order_by(Workflow.id)
                )
            )
            .scalars()
            .all()
        )
        for wf in wf_rows:
            steps = sorted(wf.step_templates, key=lambda t: t.sequence_order)
            template_times.extend(t.updated_at for t in steps)
            workflows.append(
                WorkflowSetting(
                    id=wf.id,
                    name=wf.name,
                    steps=[
                        WorkflowStepSetting(
                            step_id=t.id,
                            code=t.code,
                            name=t.name,
                            kind=t.kind,
                            sequence_order=t.sequence_order,
                            predecessor_ids=list(t.predecessor_ids or []),
                        )
                        for t in steps
                    ],
                )
            )
        seq = {
            t.id: t.sequence_order
            for t in (await db.execute(select(WorkflowStepTemplate))).scalars().all()
        }
        category_order = {c: i for i, c in enumerate(ProjectCategory)}
        lt_rows = (await db.execute(select(WorkflowLeadTime))).scalars().all()
        lead_times = [
            LeadTimeSetting(
                workflow_id=lt.workflow_id, category=lt.category, step_id=lt.step_id, weeks=lt.weeks
            )
            for lt in sorted(
                lt_rows,
                key=lambda lt: (
                    lt.workflow_id,
                    category_order[lt.category],
                    seq.get(lt.step_id, 0),
                ),
            )
        ]

    cal_stmt = (
        select(Hub, HubWorkCalendar)
        .join(HubWorkCalendar, HubWorkCalendar.hub_id == Hub.id)
        .order_by(Hub.name)
    )
    if not full:
        hub_filter = hub_scope_filter(principal, Hub.id)
        if hub_filter is not None:
            cal_stmt = cal_stmt.where(hub_filter)
    hub_calendars: list[HubCalendarSetting] = []
    calendar_times: list[datetime] = []
    for hub, cal in (await db.execute(cal_stmt)).all():
        calendar_times.append(cal.updated_at)
        hub_calendars.append(
            HubCalendarSetting(
                hub_id=hub.id,
                hub=hub.name,
                weekdays_per_week=cal.weekdays_per_week,
                national_holiday_days=float(cal.national_holiday_days),
                medical_leave_days=float(cal.medical_leave_days),
                casual_leave_days=float(cal.casual_leave_days),
                annual_leave_days=float(cal.annual_leave_days),
                weeks_in_year=cal.weeks_in_year,
                working_weeks_per_engineer=round2(
                    calendar_figures(cal).working_weeks_per_engineer
                ),
            )
        )

    chamber_stmt = select(Chamber).order_by(Chamber.lab_region, Chamber.code)
    if not full:
        regions = await scoped_lab_regions(db, principal)
        if regions is not None:
            chamber_stmt = chamber_stmt.where(Chamber.lab_region.in_(regions))
    calendars = await load_calendars_by_region(db)
    chambers: list[ChamberSetting] = []
    chamber_times: list[datetime] = []
    for c in (await db.execute(chamber_stmt)).scalars().all():
        chamber_times.append(c.updated_at)
        figures = chamber_figures(c, region_holiday_weeks(calendars, c.lab_region))
        chambers.append(
            ChamberSetting(
                chamber_id=c.id,
                code=c.code,
                lab_region=c.lab_region,
                platforms=c.platforms,
                efficiency=float(c.efficiency),
                maintenance_weeks=float(c.maintenance_weeks),
                breakdown_weeks=float(c.breakdown_weeks),
                calibration_weeks=float(c.calibration_weeks),
                working_weeks_per_chamber=round2(figures.working_weeks_per_chamber),
                efficient_lab_weeks=round2(figures.efficient_lab_weeks),
            )
        )

    last = (
        await db.execute(
            select(AuditLogEntry.occurred_at, User.full_name)
            .outerjoin(User, User.id == AuditLogEntry.actor_user_id)
            .where(AuditLogEntry.action.startswith(AUDIT_ACTION_PREFIX, autoescape=True))
            .order_by(AuditLogEntry.occurred_at.desc())
            .limit(1)
        )
    ).first()
    if last is not None:
        updated_at, updated_by = last[0], last[1]
    else:
        stamps = template_times + calendar_times + chamber_times
        updated_at, updated_by = (max(stamps) if stamps else datetime.now(UTC)), None

    return WorkflowSettings(
        workflows=workflows,
        lead_times=lead_times,
        hub_calendars=hub_calendars,
        chambers=chambers,
        current_week=dc.CURRENT_WEEK,
        horizon_weeks=dc.HORIZON_WEEKS,
        within_year_week=dc.WITHIN_YEAR_WEEK,
        updated_at=updated_at,
        updated_by=updated_by,
    )


async def _finish_put(
    db: AsyncSession,
    response: Response,
    principal: Principal,
    *,
    action: str,
    entity_type: str,
    entity_id: str,
    hub_id: uuid.UUID | None,
    before_state: dict[str, Any],
    after_state: dict[str, Any],
    full_payload: bool = True,
) -> WorkflowSettings:
    """The common tail of every PUT: stale flags, audit row, commit, header,
    payload.
    """

    stale_count = await mark_all_schedulable_stale(db)
    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            hub_id=hub_id,
            before_state=before_state,
            after_state={**after_state, "schedule_stale_count": stale_count},
        )
    )
    await db.commit()
    response.headers[STALE_COUNT_HEADER] = str(stale_count)
    return await build_settings_payload(db, principal, full=full_payload)


@router.get("", response_model=WorkflowSettings)
async def get_workflow_settings(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> WorkflowSettings:
    return await build_settings_payload(db, current_user, full=True)


# --- Steps / precedence (ADR 0009) ---------------------------------------------


def _step_error(code: str, detail: str) -> CodedHTTPException:
    return CodedHTTPException(HTTP_422, code, detail)


@router.put("/steps/{workflow_id}", response_model=WorkflowSettings)
async def put_workflow_steps(
    workflow_id: str,
    body: StepsUpdateRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> WorkflowSettings:
    workflow = await db.get(Workflow, workflow_id)
    if workflow is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown workflow")
    templates = {
        t.id: t
        for t in (
            await db.execute(
                select(WorkflowStepTemplate).where(WorkflowStepTemplate.workflow_id == workflow_id)
            )
        )
        .scalars()
        .all()
    }

    submitted = [s.step_id for s in body.steps]
    if len(submitted) != len(set(submitted)) or set(submitted) != set(templates):
        raise _step_error(
            "BAD_STEP_SET",
            f"steps must list each of the {len(templates)} steps of workflow "
            f"{workflow_id!r} exactly once",
        )
    first_id = min(templates.values(), key=lambda t: t.sequence_order).id
    for s in body.steps:
        if s.step_id in s.predecessor_ids:
            raise _step_error("SELF_REFERENCE", f"step {s.step_id!r} lists itself as a predecessor")
        if len(s.predecessor_ids) != len(set(s.predecessor_ids)):
            raise _step_error("BAD_PREDECESSOR", f"step {s.step_id!r} repeats a predecessor")
        unknown = [p for p in s.predecessor_ids if p not in templates]
        if unknown:
            raise _step_error(
                "BAD_PREDECESSOR",
                f"step {s.step_id!r} references {unknown}, which are not steps of "
                f"workflow {workflow_id!r}",
            )
        if s.step_id != first_id and not s.predecessor_ids:
            raise _step_error(
                "EMPTY_PREDECESSORS",
                f"step {s.step_id!r} has no predecessors; only the first step "
                f"({first_id!r}) may have none",
            )

    proposed = {s.step_id: s for s in body.steps}
    try:
        build_workflows(
            tuple(
                SchedWorkflowStepTemplate(
                    workflow_id=workflow_id,
                    step_id=t.id,
                    code=t.code,
                    name=t.name,
                    kind=proposed[t.id].kind.value,
                    sequence_order=t.sequence_order,
                    predecessor_ids=tuple(proposed[t.id].predecessor_ids),
                )
                for t in templates.values()
            )
        )
    except ValueError as exc:
        # Every other rejection reason was pre-checked above.
        raise _step_error("CYCLE", str(exc)) from exc

    leaving_lab = [
        sid
        for sid, s in proposed.items()
        if templates[sid].kind == WorkflowStepKind.LAB and s.kind != WorkflowStepKind.LAB
    ]
    if leaving_lab:
        in_use_stmt = select(Chamber.code).where(
            or_(*(any_(Chamber.allowed_stages) == sid for sid in leaving_lab))
        )
        in_use = (await db.execute(in_use_stmt)).scalars().all()
        if in_use:
            raise _step_error(
                "KIND_IN_USE",
                f"step(s) {sorted(leaving_lab)} are in the allowed_stages of chamber(s) "
                f"{sorted(in_use)}; remove them there before changing the kind",
            )

    before = {
        sid: {"kind": t.kind.value, "predecessor_ids": list(t.predecessor_ids or [])}
        for sid, t in sorted(templates.items())
    }
    for sid, s in proposed.items():
        templates[sid].kind = s.kind
        templates[sid].predecessor_ids = list(s.predecessor_ids)
    await db.flush()
    after = {
        sid: {"kind": t.kind.value, "predecessor_ids": list(t.predecessor_ids or [])}
        for sid, t in sorted(templates.items())
    }
    return await _finish_put(
        db,
        response,
        current_user,
        action=f"{AUDIT_ACTION_PREFIX}steps_update",
        entity_type="Workflow",
        entity_id=workflow_id,
        hub_id=None,
        before_state={"steps": before},
        after_state={"steps": after},
    )


# --- Lead times (ADR 0007) -------------------------------------------------------


@router.put("/lead-times", response_model=WorkflowSettings)
async def put_lead_times(
    body: LeadTimesUpdateRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> WorkflowSettings:
    keys = [(lt.workflow_id, lt.category, lt.step_id) for lt in body.lead_times]
    if len(keys) != len(set(keys)):
        raise CodedHTTPException(
            HTTP_422,
            "DUPLICATE_LEAD_TIME",
            "lead_times lists the same (workflow_id, category, step_id) more than once",
        )
    step_workflow: dict[str, str] = dict(
        (
            await db.execute(select(WorkflowStepTemplate.id, WorkflowStepTemplate.workflow_id))
        )
        .tuples()
        .all()
    )
    for lt in body.lead_times:
        if step_workflow.get(lt.step_id) != lt.workflow_id:
            raise CodedHTTPException(
                HTTP_422,
                "BAD_LEAD_TIME",
                f"{lt.step_id!r} is not a step of workflow {lt.workflow_id!r}",
            )
        if lt.category not in categories_for_workflow(lt.workflow_id):
            raise CodedHTTPException(
                HTTP_422,
                "BAD_LEAD_TIME",
                f"category {lt.category.value!r} does not belong to workflow {lt.workflow_id!r}",
            )

    existing = {
        (row.workflow_id, row.category, row.step_id): row
        for row in (await db.execute(select(WorkflowLeadTime))).scalars().all()
    }
    before: list[dict[str, Any]] = []
    after: list[dict[str, Any]] = []
    for lt in body.lead_times:
        row = existing.get((lt.workflow_id, lt.category, lt.step_id))
        before.append(
            {
                "workflow_id": lt.workflow_id,
                "category": lt.category.value,
                "step_id": lt.step_id,
                "weeks": row.weeks if row is not None else None,
            }
        )
        if row is None:
            db.add(
                WorkflowLeadTime(
                    workflow_id=lt.workflow_id,
                    category=lt.category,
                    step_id=lt.step_id,
                    weeks=lt.weeks,
                )
            )
        else:
            row.weeks = lt.weeks
        after.append(
            {
                "workflow_id": lt.workflow_id,
                "category": lt.category.value,
                "step_id": lt.step_id,
                "weeks": lt.weeks,
            }
        )
    await db.flush()
    recomputed = await recompute_step_durations(db)
    return await _finish_put(
        db,
        response,
        current_user,
        action=f"{AUDIT_ACTION_PREFIX}lead_times_update",
        entity_type="WorkflowLeadTime",
        entity_id="lead_times",
        hub_id=None,
        before_state={"lead_times": before},
        after_state={"lead_times": after, "recomputed_step_rows": recomputed},
    )


# --- Hub calendars (ADR 0008) ------------------------------------------------------


def _calendar_state(cal: HubWorkCalendar) -> dict[str, Any]:
    return {
        "weekdays_per_week": cal.weekdays_per_week,
        "national_holiday_days": float(cal.national_holiday_days),
        "medical_leave_days": float(cal.medical_leave_days),
        "casual_leave_days": float(cal.casual_leave_days),
        "annual_leave_days": float(cal.annual_leave_days),
        "weeks_in_year": cal.weeks_in_year,
    }


@router.put("/hub-calendars/{hub_id}", response_model=WorkflowSettings)
async def put_hub_calendar(
    hub_id: uuid.UUID,
    body: HubCalendarUpdateRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> WorkflowSettings:
    hub = await db.get(Hub, hub_id)
    if hub is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown hub")
    cal = (
        await db.execute(select(HubWorkCalendar).where(HubWorkCalendar.hub_id == hub_id))
    ).scalar_one_or_none()
    weeks_in_year = cal.weeks_in_year if cal is not None else 52
    deduction = (
        body.national_holiday_days
        + body.medical_leave_days
        + body.casual_leave_days
        + body.annual_leave_days
    ) / body.weekdays_per_week
    if deduction >= weeks_in_year:
        raise CodedHTTPException(
            HTTP_422,
            "BAD_CALENDAR",
            "The leave and holiday days add up to the whole year or more.",
        )

    before = _calendar_state(cal) if cal is not None else {}
    if cal is None:
        cal = HubWorkCalendar(hub_id=hub_id, weeks_in_year=52, **body.model_dump())
        db.add(cal)
    else:
        for key, value in body.model_dump().items():
            setattr(cal, key, value)
    await db.flush()
    return await _finish_put(
        db,
        response,
        current_user,
        action=f"{AUDIT_ACTION_PREFIX}hub_calendar_update",
        entity_type="HubWorkCalendar",
        entity_id=str(hub_id),
        hub_id=hub_id,
        before_state=before,
        after_state=_calendar_state(cal),
    )


# --- Chamber downtime (ADR 0008) -----------------------------------------------------


@router.put("/chambers/{chamber_id}", response_model=WorkflowSettings)
async def put_chamber(
    chamber_id: uuid.UUID,
    body: ChamberSettingUpdateRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> WorkflowSettings:
    """Super Admin (Workflow Settings WRITE) edits any chamber. A caller with
    Capacity Planning WRITE edits chambers in their own lab region(s) only.
    Everyone else gets 403.
    """

    settings_writer = principal_can(current_user, Surface.WORKFLOW_SETTINGS, Action.WRITE)
    planning_writer = principal_can(current_user, Surface.CAPACITY_PLANNING, Action.WRITE)
    if not (settings_writer or planning_writer):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Requires write on workflow_settings or capacity_planning",
        )

    stmt = select(Chamber).where(Chamber.id == chamber_id)
    if not settings_writer:
        regions = await scoped_lab_regions(db, current_user)
        if regions is not None:
            stmt = stmt.where(Chamber.lab_region.in_(regions))
    chamber = (await db.execute(stmt)).scalar_one_or_none()
    if chamber is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chamber not found")

    updates = body.model_dump(exclude_unset=True)
    for key, value in updates.items():
        if value is None:
            raise CodedHTTPException(
                HTTP_422, "NULL_NOT_ALLOWED", f"{key} may not be null"
            )
    before = chamber_audit_state(chamber)
    for key, value in updates.items():
        setattr(chamber, key, value)
    if "platforms" in updates:
        chamber.max_concurrent = updates["platforms"]
    await db.flush()
    return await _finish_put(
        db,
        response,
        current_user,
        action=f"{AUDIT_ACTION_PREFIX}chamber_update",
        entity_type="Chamber",
        entity_id=str(chamber.id),
        hub_id=None,
        before_state=before,
        after_state=chamber_audit_state(chamber),
        full_payload=principal_can(current_user, Surface.WORKFLOW_SETTINGS, Action.READ),
    )

