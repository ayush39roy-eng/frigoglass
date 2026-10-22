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
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.db import get_db
from api.deps import require_permission
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.engineer import Engineer
from models.enums import RoleName
from models.hub import Hub, HubWorkCalendar
from schemas.capacity import YearRemaining
from schemas.engineer import EngineerCreateRequest, EngineerRead, EngineerUpdateRequest
from services.audit_helpers import engineer_audit_state
from services.capacity_hubs import engineer_hub_filter, load_capacity_hub_map
from services.capacity_supply import (
    design_capacity,
    fte_sum,
    hub_weekdays_per_week,
    round2,
    to_days,
)
from services.hub_scope import hub_scope_filter, is_hub_in_scope

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


async def _engineer_reads(db: AsyncSession, engineers: list[Engineer]) -> list[EngineerRead]:
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
        year, remaining = design_capacity(cal, fte_sum([e.fte]), dc.CURRENT_WEEK)
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
    hub_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[EngineerRead]:
    """List engineers, optionally filtered by hub.

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
    result = await db.execute(stmt.order_by(Engineer.name))
    return await _engineer_reads(db, list(result.scalars().all()))


@router.get("/{engineer_id}", response_model=EngineerRead)
async def get_engineer(
    engineer_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> EngineerRead:
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    return (await _engineer_reads(db, [engineer]))[0]


@router.post("", response_model=EngineerRead, status_code=status.HTTP_201_CREATED)
async def create_engineer(
    body: EngineerCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
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
    return (await _engineer_reads(db, [engineer]))[0]


@router.patch("/{engineer_id}", response_model=EngineerRead)
async def update_engineer(
    engineer_id: uuid.UUID,
    body: EngineerUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> EngineerRead:
    engineer = await _get_engineer_or_404(db, engineer_id, current_user)

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

    before_state = engineer_audit_state(engineer)
    for field_name, value in body.model_dump(exclude_unset=True).items():
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
    return (await _engineer_reads(db, [engineer]))[0]


@router.delete("/{engineer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_engineer(
    engineer_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> None:
    """Delete an engineer. Fails with 409 if the engineer is still referenced
    (e.g. as a project leader, or an assigned engineer on a workflow step or
    schedule-run snapshot) — those foreign keys have no `ON DELETE CASCADE`
    (P1-T02 migration), by design: deleting an engineer must never silently
    orphan or rewrite historical schedule data.
    """

    engineer = await _get_engineer_or_404(db, engineer_id, current_user)
    before_state = engineer_audit_state(engineer)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="engineer.delete",
            entity_type="Engineer",
            entity_id=str(engineer.id),
            hub_id=engineer.hub_id,
            before_state=before_state,
            after_state=None,
        )
    )
    await db.delete(engineer)
    try:
        await db.commit()
    except IntegrityError:
        # FK references only; raised `from None` so the DB message (row
        # values) never reaches a traceback in the log (P19-R01).
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete engineer: still referenced by existing projects/schedule data.",
        ) from None
