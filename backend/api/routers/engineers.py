"""Capacity Planning surface — Engineer CRUD (`docs/PROJECT_AND_STACK.md` §2).

**"Apply Logic" / "Auto-assign" are explicitly OUT OF SCOPE for this router**
(and for all of P3-T01) — per `docs/IMPLEMENTATION_PLAN.md` P3-T01's own scope
note, those bulk-resource-assignment actions require Celery/solver dispatch
wiring that belongs to P3-T06, not plain CRUD. Nothing here implements or
stubs them; there is no "apply logic" endpoint at all yet.

**RBAC (P3-T02)**: every endpoint requires a validated OIDC token (401 if
missing/invalid) and action-level permission on the `CAPACITY_PLANNING`
surface — reads need `READ`, mutations need `WRITE`, per
`docs/PROJECT_AND_STACK.md` §5 (Hub Planner/Admin get write; Portfolio
Manager gets read-only; Engineer/Executive Viewer/Auditor get 403 on
everything).

**Hub-scoped (P3-T03)**: every read/write is additionally filtered to the
caller's own hub(s) via `services.hub_scope` unless `current_user.
hub_scope_all` — a Hub Planner's list is silently filtered, a direct `GET
/engineers/{id}` on an out-of-scope engineer 404s, and creating/moving an
engineer to a hub outside the caller's scope 403s.

**Capacity hubs (P29, ADR 0042).** An engineer's hub is always a capacity hub
(a member hub such as OEM-HCK is a 422 `HUB_NOT_CAPACITY_HUB`).
`counts_in_capacity` (served on every read) may be written by Admin / Super
Admin only (403 `COUNTS_IN_CAPACITY_ADMIN_ONLY`); the change is in the
`engineer.update` audit row's before / after state. `?hub_id=` on a member
hub lists its capacity hub's engineers.
"""

from __future__ import annotations

import logging
import math
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_permission
from api.errors import HTTP_422, CodedHTTPException
from api.query_params import HubIdListQuery
from api.super_admin import ensure_super_admin
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.engineer import Engineer, EngineerInactivePeriod
from models.enums import NON_SCHEDULABLE_STATUSES, RoleName
from models.hub import Hub, HubWorkCalendar
from models.project import Project
from schemas.capacity import YearRemaining
from schemas.engineer import (
    DeactivateRequest,
    DeactivateResponse,
    DeactivationPreview,
    DeactivationRun,
    DeactivationWarning,
    EngineerCreateRequest,
    EngineerRead,
    EngineerStatusFilter,
    EngineerUpdateRequest,
)
from services.audit_helpers import engineer_audit_state, project_audit_state
from services.capacity_hubs import engineer_hub_filter, load_capacity_hub_map
from services.capacity_supply import (
    design_capacity,
    fte_sum,
    hub_weekdays_per_week,
    round2,
    to_days,
)
from services.categories import check_eligibility_codes, load_catalog
from services.edit_conflict import check_base, field_refs
from services.engineer_status import (
    CAUSE_ENGINEER_DEACTIVATED,
    ENGINEER_DEACTIVATED_TRIGGER,
    active_run_books_after,
    build_preview,
    category_not_allowed,
    led_projects_token,
    lock_engineers,
    open_period,
    open_projects,
    projects_out_of_scope,
    record_leader_change,
)
from services.hub_scope import hub_scope_filter, is_hub_in_scope
from services.plan_clock import PlanClock, get_plan_clock
from services.priority_move import decide_auto_recalc_batch, dispatch_auto_recalc_batch
from services.rate_limit import TokenBucketLimiter

router = APIRouter(prefix="/engineers", tags=["capacity-planning", "engineers"])

_read = require_permission(Surface.CAPACITY_PLANNING, Action.READ)
_write = require_permission(Surface.CAPACITY_PLANNING, Action.WRITE)

logger = logging.getLogger(__name__)

#: Postgres SQLSTATEs (P19-R01, S19-L1).
_UNIQUE_VIOLATION = "23505"
_FOREIGN_KEY_VIOLATION = "23503"


def _integrity_http_error(exc: IntegrityError, action: str) -> HTTPException:
    """Map a flush-time IntegrityError to a client-safe HTTP error.

    P19-R01 (S19-L1): the DB message ("Failing row contains (...)") and
    SQLAlchemy's `[parameters: ...]` carry row values, including the
    engineer's name (personal data, OQ #8). So only the SQLSTATE and the
    constraint name are logged, and the returned exception is raised
    `from None` so no traceback with the original error reaches a log.
    The only constraints a validated body can still hit are `user_id`'s
    foreign key (unknown user) and unique key (user already linked).
    """

    orig = exc.orig
    sqlstate = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
    constraint = getattr(getattr(orig, "__cause__", None), "constraint_name", None)
    logger.warning(
        "engineer.%s integrity error sqlstate=%s constraint=%s", action, sqlstate, constraint
    )
    if sqlstate == _UNIQUE_VIOLATION:
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This user is already linked to another engineer.",
        )
    if sqlstate == _FOREIGN_KEY_VIOLATION:
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown user_id"
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="The engineer could not be saved."
    )


async def _get_engineer_or_404(
    db: AsyncSession, engineer_id: uuid.UUID, principal: Principal
) -> Engineer:
    stmt = select(Engineer).where(Engineer.id == engineer_id)
    hub_filter = hub_scope_filter(principal, Engineer.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(stmt)
    engineer = result.scalar_one_or_none()
    if engineer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Engineer not found")
    return engineer


async def _engineer_reads(
    db: AsyncSession, engineers: list[Engineer], *, current_week: int
) -> list[EngineerRead]:
    """`EngineerRead` plus the P19-T03 supply figures (ADR 0008): the hub's
    calendar × the engineer's own fte, and the days at the hub's
    `weekdays_per_week` (docs/API_CONTRACT_P19.md §2)."""

    hub_ids = {e.hub_id for e in engineers}
    calendars = (
        {
            c.hub_id: c
            for c in (
                await db.execute(
                    select(HubWorkCalendar).where(HubWorkCalendar.hub_id.in_(hub_ids))
                )
            ).scalars().all()
        }
        if hub_ids
        else {}
    )
    out: list[EngineerRead] = []
    for e in engineers:
        cal = calendars.get(e.hub_id)
        year, remaining = design_capacity(cal, fte_sum([e.fte]), current_week)
        wd = hub_weekdays_per_week(cal)
        weeks = YearRemaining(year=round2(year), remaining=round2(remaining))
        out.append(
            EngineerRead(
                id=e.id,
                name=e.name,
                hub_id=e.hub_id,
                fte=float(e.fte),
                allowed_categories=list(e.allowed_categories or []),
                user_id=e.user_id,
                counts_in_capacity=e.counts_in_capacity,
                created_at=e.created_at,
                updated_at=e.updated_at,
                weekdays_per_week=wd,
                capacity_weeks=weeks,
                capacity_days=YearRemaining(
                    year=to_days(weeks.year, wd), remaining=to_days(weeks.remaining, wd)
                ),
                active=e.active,
                deactivated_at=e.deactivated_at,
                deactivated_week=e.deactivated_week,
                deactivated_plan_year=e.deactivated_plan_year,
                deactivation_reason=e.deactivation_reason,
            )
        )
    return out


#: P29 (ADR 0042 §5): who may change `counts_in_capacity`.
CAPACITY_ROSTER_ADMIN_ROLES: frozenset[RoleName] = frozenset(
    {RoleName.ADMIN, RoleName.SUPER_ADMIN}
)


def _require_capacity_hub(hub: Hub) -> None:
    """ADR 0042: an engineer's hub is always a capacity hub. A member hub
    (OEM-HCK, OEM-Seitek) is refused with 422 `HUB_NOT_CAPACITY_HUB`."""

    if hub.capacity_hub_id is not None:
        raise CodedHTTPException(
            HTTP_422,
            "HUB_NOT_CAPACITY_HUB",
            "This hub's design work is done by its capacity hub's engineers; "
            "add the engineer to the capacity hub instead.",
        )


def _require_capacity_admin(principal: Principal) -> None:
    """ADR 0042 §5: `counts_in_capacity` is an Admin / Super Admin decision
    (it changes the hub's supply). Anyone else gets 403
    `COUNTS_IN_CAPACITY_ADMIN_ONLY`, also when sending the unchanged value."""

    if not (principal.roles & CAPACITY_ROSTER_ADMIN_ROLES):
        raise CodedHTTPException(
            status.HTTP_403_FORBIDDEN,
            "COUNTS_IN_CAPACITY_ADMIN_ONLY",
            "Only an Admin can change whether an engineer counts in capacity.",
        )


@router.get("", response_model=list[EngineerRead])
async def list_engineers(
    hub_id: HubIdListQuery = None,
    status_: Annotated[
        EngineerStatusFilter,
        Query(
            alias="status",
            description="P38: active (default), inactive or all. Anything else is a 422.",
        ),
    ] = "active",
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> list[EngineerRead]:
    """List engineers, optionally filtered by hub (`hub_id` repeatable,
    ADR 0051: any of the listed hubs; an out-of-scope hub contributes nothing).

    Requires READ on Capacity Planning (401/403 enforced by `_read`,
    P3-T02) and is hub-scoped (P3-T03): a Hub Planner's list is silently
    filtered to their own hub(s) server-side, regardless of what `hub_id`
    the caller passes.
    """

    stmt = select(Engineer)
    # ADR 0042: a member hub (OEM-HCK) has no engineers of its own; its
    # capacity hub's engineers do its design work. P30-R01 (S30-I1): the
    # scope check runs on the requested hub first (out of scope → []).
    cmap = await load_capacity_hub_map(db)
    hub_filter = engineer_hub_filter(current_user, cmap, hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    # P38 (contract §1): the roster shows active engineers by default.
    if status_ == "active":
        stmt = stmt.where(Engineer.active.is_(True))
    elif status_ == "inactive":
        stmt = stmt.where(Engineer.active.is_(False))
    result = await db.execute(stmt.order_by(Engineer.name))
    return await _engineer_reads(db, list(result.scalars().all()), current_week=clock.week)


@router.get("/{engineer_id}", response_model=EngineerRead)
async def get_engineer(
    engineer_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> EngineerRead:
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    return (await _engineer_reads(db, [engineer], current_week=clock.week))[0]


@router.post("", response_model=EngineerRead, status_code=status.HTTP_201_CREATED)
async def create_engineer(
    body: EngineerCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
    clock: PlanClock = Depends(get_plan_clock),
) -> EngineerRead:
    hub = (await db.execute(select(Hub).where(Hub.id == body.hub_id))).scalar_one_or_none()
    if hub is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown hub_id"
        )
    if not is_hub_in_scope(current_user, body.hub_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot create an engineer for a hub outside your assigned hub scope.",
        )
    _require_capacity_hub(hub)
    if not body.counts_in_capacity:
        _require_capacity_admin(current_user)
    await check_eligibility_codes(
        db, body.allowed_categories, loc=("body", "allowed_categories")
    )

    engineer = Engineer(**body.model_dump())
    db.add(engineer)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _integrity_http_error(exc, "create") from None

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="engineer.create",
            entity_type="Engineer",
            entity_id=str(engineer.id),
            hub_id=engineer.hub_id,
            before_state=None,
            after_state=engineer_audit_state(engineer),
        )
    )
    await db.commit()
    await db.refresh(engineer)
    return (await _engineer_reads(db, [engineer], current_week=clock.week))[0]


@router.patch("/{engineer_id}", response_model=EngineerRead)
async def update_engineer(
    engineer_id: uuid.UUID,
    body: EngineerUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
    clock: PlanClock = Depends(get_plan_clock),
) -> EngineerRead:
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    # P38 (ADR 0053 §7): an inactive engineer's only editable field is
    # `name` (a correction / GDPR rectification); reactivate first.
    _require_name_only_if_inactive(engineer, body)

    if body.hub_id is not None:
        hub = (await db.execute(select(Hub).where(Hub.id == body.hub_id))).scalar_one_or_none()
        if hub is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown hub_id"
            )
        if not is_hub_in_scope(current_user, body.hub_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot move an engineer to a hub outside your assigned hub scope.",
            )
        _require_capacity_hub(hub)
    if "counts_in_capacity" in body.model_fields_set:
        _require_capacity_admin(current_user)
    await check_eligibility_codes(
        db, body.allowed_categories, loc=("body", "allowed_categories")
    )

    # P38 (R38-5): the engineer row is locked (after lookup + authorisation)
    # and re-read, so a concurrent deactivation is seen before the write.
    await lock_engineers(db, [engineer.id], share=False)
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    _require_name_only_if_inactive(engineer, body)
    updates = body.model_dump(exclude_unset=True, exclude={"base"})
    # P47 (ADR 0059 C1): compared on the locked, re-read row.
    await check_base(
        db,
        current_user,
        entity="engineer",
        entity_id=engineer.id,
        label=engineer.name,
        base=body.base,
        requested=updates,
        current=lambda name: getattr(engineer, name, None),
        refs=field_refs("Engineer", str(engineer.id)),
        hub_id=engineer.hub_id,
    )

    before_state = engineer_audit_state(engineer)
    for field_name, value in updates.items():
        setattr(engineer, field_name, value)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _integrity_http_error(exc, "update") from None
    after_state = engineer_audit_state(engineer)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="engineer.update",
            entity_type="Engineer",
            entity_id=str(engineer.id),
            hub_id=engineer.hub_id,
            before_state=before_state,
            after_state=after_state,
        )
    )
    await db.commit()
    await db.refresh(engineer)
    return (await _engineer_reads(db, [engineer], current_week=clock.week))[0]


@router.delete(
    "/{engineer_id}",
    status_code=status.HTTP_410_GONE,
    responses={410: {"description": "ENGINEER_DELETE_RETIRED: deactivate instead (P38)."}},
)
async def delete_engineer(
    engineer_id: uuid.UUID,
    current_user: Principal = Depends(_write),
) -> None:
    """Retired (P38, ADR 0053 §1): engineers are never deleted, so stored
    runs, the audit log and history keep their names. Every caller with
    Capacity Planning write gets 410 `ENGINEER_DELETE_RETIRED`; nothing is
    looked up, deleted or audited. Callers without the permission keep their
    401 / 403 from `_write`."""

    raise CodedHTTPException(
        status.HTTP_410_GONE,
        "ENGINEER_DELETE_RETIRED",
        "Engineers can no longer be deleted. Deactivate the engineer instead.",
    )


# --- P38: deactivate / reactivate (docs/API_CONTRACT_P38.md §2) --------------------------

#: Per user: a burst of 10 status changes, then one every 6 seconds; previews a
#: burst of 20, then one every 2 seconds. Per API process (`services.rate_limit`).
ENGINEER_STATUS_RATE_LIMIT = TokenBucketLimiter(capacity=10, refill_per_second=1 / 6)
DEACTIVATION_PREVIEW_RATE_LIMIT = TokenBucketLimiter(capacity=20, refill_per_second=1 / 2)


def _require_name_only_if_inactive(engineer: Engineer, body: EngineerUpdateRequest) -> None:
    if not engineer.active and body.model_fields_set - {"name", "base"}:
        raise CodedHTTPException(
            status.HTTP_409_CONFLICT,
            "ENGINEER_INACTIVE",
            "This engineer is inactive: only the name can be edited. Reactivate them first.",
        )


def _require_status_admin(principal: Principal) -> None:
    """ADR 0053 §1: Admin / Super Admin only (OQ #93: a Hub Planner may not,
    until answered)."""

    if not (principal.roles & CAPACITY_ROSTER_ADMIN_ROLES):
        raise CodedHTTPException(
            status.HTTP_403_FORBIDDEN,
            "ENGINEER_STATUS_ADMIN_ONLY",
            "Only an Admin can deactivate or reactivate an engineer.",
        )


def _rate_limited(limiter: TokenBucketLimiter, key: str) -> None:
    allowed, retry_after = limiter.allow(key)
    if not allowed:
        raise CodedHTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many requests. Please wait a moment and try again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )


def _already_inactive() -> CodedHTTPException:
    return CodedHTTPException(
        status.HTTP_409_CONFLICT,
        "ENGINEER_ALREADY_INACTIVE",
        "This engineer is already inactive.",
    )


def _out_of_scope_projects() -> CodedHTTPException:
    """A hub-scoped Admin cannot see every project the engineer leads, so the
    dialog could not name the exact open set: refused without listing them."""

    return CodedHTTPException(
        status.HTTP_403_FORBIDDEN,
        "ENGINEER_STATUS_OUT_OF_SCOPE",
        "This engineer leads projects outside your hubs. An Admin with access to "
        "those hubs must deactivate them.",
    )


def _row_error(index: int, code: str, message: str) -> dict[str, Any]:
    return {
        "loc": ["body", "reassignments", index, "leader_engineer_id"],
        "msg": message,
        "type": code.lower(),
        "code": code,
        "row_index": index,
    }


@router.get("/{engineer_id}/deactivation-preview", response_model=DeactivationPreview)
async def deactivation_preview(
    engineer_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> DeactivationPreview:
    """The Deactivate dialog's read model (contract §2): the engineer's open
    projects (status not Commercialized / Cancelled) with per-row facts and
    eligible candidates, the supply effect and `led_projects_token`. Writes
    nothing and takes no lock."""

    _require_status_admin(current_user)
    _rate_limited(DEACTIVATION_PREVIEW_RATE_LIMIT, f"deactivation-preview:{current_user.user_id}")
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    if not engineer.active:
        raise _already_inactive()
    projects = await open_projects(db, engineer.id)
    if projects_out_of_scope(current_user, projects):
        raise _out_of_scope_projects()
    cmap = await load_capacity_hub_map(db)
    return await build_preview(db, current_user, engineer, projects, cmap, clock)


@router.post("/{engineer_id}/deactivate", response_model=DeactivateResponse)
async def deactivate_engineer(
    engineer_id: uuid.UUID,
    body: DeactivateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> DeactivateResponse:
    """Deactivate an engineer and apply every reassignment / clear in one
    transaction, then at most one greedy recalculation (contract §2, R38-3,
    R38-5).

    Order: RBAC → Admin → rate limit → scoped lookup (plain SELECTs, no lock)
    → engineer row `FOR UPDATE`, target leaders `FOR SHARE`, open projects
    `FOR UPDATE` in id order (lock timeout → 503 `ENGINEER_STATUS_BUSY`) →
    409 `LED_PROJECTS_CHANGED` when the token or the id set differs from the
    set under lock → per-row 422s → writes, audit, leader history → dispatch
    iff a schedulable project changed leader or the active run books the
    engineer after the deactivation week; else `not_needed`.
    """

    _require_status_admin(current_user)
    # ADR 0058 D1.3: deactivating is Super Admin only; reactivating stays an
    # Admin right (`_require_status_admin` alone).
    ensure_super_admin(current_user)
    _rate_limited(ENGINEER_STATUS_RATE_LIMIT, f"engineer-status:{current_user.user_id}")
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    if not engineer.active:
        raise _already_inactive()

    # --- Locks (R38-5): engineer row, then targets, then projects by id. ---------
    await lock_engineers(db, [engineer.id], share=False)
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    if not engineer.active:
        await db.rollback()
        raise _already_inactive()
    target_ids = {
        r.leader_engineer_id
        for r in body.reassignments
        if r.leader_engineer_id is not None and r.leader_engineer_id != engineer.id
    }
    targets = await lock_engineers(db, target_ids, share=True)
    projects = await open_projects(db, engineer.id, lock=True)
    if projects_out_of_scope(current_user, projects):
        await db.rollback()
        raise _out_of_scope_projects()

    fresh_ids = [p.id for p in projects]
    token = led_projects_token(fresh_ids)
    if body.led_projects_token != token or {r.project_id for r in body.reassignments} != set(
        fresh_ids
    ):
        await db.rollback()
        # The fresh list (no lock held any more), so the dialog can refresh.
        engineer = await _get_engineer_or_404(db, engineer_id, current_user)
        fresh = await open_projects(db, engineer.id)
        cmap = await load_capacity_hub_map(db)
        preview = await build_preview(db, current_user, engineer, fresh, cmap, clock)
        raise CodedHTTPException(
            status.HTTP_409_CONFLICT,
            "LED_PROJECTS_CHANGED",
            {
                "message": "The engineer's open projects changed since the dialog was "
                "opened. Review the refreshed list.",
                "open_projects": [r.model_dump(mode="json") for r in preview.open_projects],
                "led_projects_token": preview.led_projects_token,
            },
        )

    # --- Per-row checks (422, with the row index). -------------------------------
    by_id = {p.id: p for p in projects}
    errors: list[dict[str, Any]] = []
    for index, row in enumerate(body.reassignments):
        project = by_id[row.project_id]
        leader_id = row.leader_engineer_id
        if leader_id is None:
            if project.frozen:
                errors.append(
                    _row_error(
                        index,
                        "FROZEN_NEEDS_LEADER",
                        "A frozen project must get a leader. Unfreeze it on the Gantt first "
                        "to leave it without one.",
                    )
                )
            continue
        if leader_id == engineer.id:
            errors.append(
                _row_error(index, "LEADER_INACTIVE", "The engineer being deactivated.")
            )
            continue
        target = targets.get(leader_id)
        if target is None or not is_hub_in_scope(current_user, target.hub_id):
            errors.append(_row_error(index, "UNKNOWN_LEADER", "Unknown leader_engineer_id"))
        elif not target.active or float(target.fte) <= 0:
            errors.append(
                _row_error(
                    index, "LEADER_INACTIVE", "The new leader must be an active engineer."
                )
            )
    if errors:
        await db.rollback()
        raise CodedHTTPException(HTTP_422, errors[0]["code"], errors)

    # --- Writes (one transaction). -----------------------------------------------
    cmap = await load_capacity_hub_map(db)
    category_workflow = (await load_catalog(db)).workflow_by_code
    engineer_before = engineer_audit_state(engineer)
    engineer.active = False
    engineer.deactivated_at = datetime.now(UTC)
    engineer.deactivated_week = clock.week
    engineer.deactivated_plan_year = clock.plan_year
    engineer.deactivated_by_user_id = current_user.user_id
    engineer.deactivation_reason = body.reason
    db.add(
        EngineerInactivePeriod(
            id=uuid.uuid4(),
            engineer_id=engineer.id,
            from_plan_year=clock.plan_year,
            from_week=clock.week,
        )
    )

    warnings: list[DeactivationWarning] = []
    cleared: list[uuid.UUID] = []
    schedulable_changed: list[Project] = []
    for row in sorted(body.reassignments, key=lambda r: r.project_id):
        project = by_id[row.project_id]
        before = project_audit_state(project)
        project.leader_engineer_id = row.leader_engineer_id
        project.leader_is_provisional = False
        if project.status not in NON_SCHEDULABLE_STATUSES:
            project.schedule_stale = True
            schedulable_changed.append(project)
        after = project_audit_state(project)
        after["cause"] = CAUSE_ENGINEER_DEACTIVATED
        db.add(
            AuditLogEntry(
                actor_user_id=current_user.user_id,
                action="project.update",
                entity_type="Project",
                entity_id=str(project.id),
                hub_id=project.hub_id,
                before_state=before,
                after_state=after,
            )
        )
        await record_leader_change(
            db,
            project_id=project.id,
            old_leader_id=engineer.id,
            new_leader_id=row.leader_engineer_id,
            cause=CAUSE_ENGINEER_DEACTIVATED,
            actor_user_id=current_user.user_id,
            clock=clock,
        )
        if row.leader_engineer_id is None:
            cleared.append(project.id)
            continue
        target = targets[row.leader_engineer_id]
        if target.hub_id != cmap.resolve(project.hub_id):
            warnings.append(DeactivationWarning(project_id=project.id, code="NOT_IN_CAPACITY_HUB"))
        if category_not_allowed(project, target, cmap, category_workflow):
            warnings.append(DeactivationWarning(project_id=project.id, code="CAT_NOT_ALLOWED"))

    engineer_after = engineer_audit_state(engineer)
    engineer_after["deactivated_by_user_id"] = str(current_user.user_id)
    engineer_after["reassigned"] = len(body.reassignments) - len(cleared)
    engineer_after["left_without_leader"] = len(cleared)
    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="engineer.deactivate",
            entity_type="Engineer",
            entity_id=str(engineer.id),
            hub_id=engineer.hub_id,
            before_state=engineer_before,
            after_state=engineer_after,
        )
    )
    await db.flush()

    # --- One recalculation (R38-5): (a) or (b), else not_needed. -------------------
    needs_run = bool(schedulable_changed) or await active_run_books_after(
        db, engineer.id, clock.week
    )
    recalc, baseline_id = await decide_auto_recalc_batch(
        db, needs_run=needs_run, trigger_reason=ENGINEER_DEACTIVATED_TRIGGER
    )
    outcome = await dispatch_auto_recalc_batch(
        db,
        schedulable_changed,
        current_user,
        recalc=recalc,
        baseline_id=baseline_id,
        trigger_reason=ENGINEER_DEACTIVATED_TRIGGER,
    )
    await db.refresh(engineer)
    read = (await _engineer_reads(db, [engineer], current_week=clock.week))[0]
    run_status = outcome.recalc_status
    return DeactivateResponse(
        engineer=read,
        reassigned=len(body.reassignments) - len(cleared),
        left_without_leader=len(cleared),
        left_without_leader_project_ids=sorted(cleared),
        warnings=warnings,
        run=DeactivationRun(
            status=run_status,
            run_id=outcome.schedule_run_id if run_status == "queued" else None,
        ),
    )


@router.post("/{engineer_id}/reactivate", response_model=EngineerRead)
async def reactivate_engineer(
    engineer_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> EngineerRead:
    """Close the open period and set `active = true` (contract §2). Gives back
    no project and dispatches no run; supply updates at once. Audit
    `engineer.reactivate`."""

    _require_status_admin(current_user)
    _rate_limited(ENGINEER_STATUS_RATE_LIMIT, f"engineer-status:{current_user.user_id}")
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    if engineer.active:
        raise _already_active()
    await lock_engineers(db, [engineer.id], share=False)
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    if engineer.active:
        await db.rollback()
        raise _already_active()

    before = engineer_audit_state(engineer)
    period = await open_period(db, engineer.id)
    if period is not None:
        to = (clock.plan_year, clock.week)
        # A lowered week pin can put "now" before the period's start: the
        # period then covers nothing (same-week rule), never a negative span.
        if to < (period.from_plan_year, period.from_week):
            to = (period.from_plan_year, period.from_week)
        period.to_plan_year, period.to_week = to
        period.closed_at = datetime.now(UTC)
    engineer.active = True
    engineer.deactivated_at = None
    engineer.deactivated_week = None
    engineer.deactivated_plan_year = None
    engineer.deactivated_by_user_id = None
    engineer.deactivation_reason = None
    after = engineer_audit_state(engineer)
    if period is not None:
        after["reactivated_week"] = period.to_week
        after["reactivated_plan_year"] = period.to_plan_year
    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="engineer.reactivate",
            entity_type="Engineer",
            entity_id=str(engineer.id),
            hub_id=engineer.hub_id,
            before_state=before,
            after_state=after,
        )
    )
    await db.commit()
    await db.refresh(engineer)
    return (await _engineer_reads(db, [engineer], current_week=clock.week))[0]


def _already_active() -> CodedHTTPException:
    return CodedHTTPException(
        status.HTTP_409_CONFLICT,
        "ENGINEER_ALREADY_ACTIVE",
        "This engineer is already active.",
    )
