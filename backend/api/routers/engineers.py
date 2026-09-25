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
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.engineer import Engineer
from models.hub import Hub
from schemas.engineer import EngineerCreateRequest, EngineerRead, EngineerUpdateRequest
from services.audit_helpers import engineer_audit_state
from services.hub_scope import hub_scope_filter, is_hub_in_scope

router = APIRouter(prefix="/engineers", tags=["capacity-planning", "engineers"])

_read = require_permission(Surface.CAPACITY_PLANNING, Action.READ)
_write = require_permission(Surface.CAPACITY_PLANNING, Action.WRITE)


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


@router.get("", response_model=list[EngineerRead])
async def list_engineers(
    hub_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[Engineer]:
    """List engineers, optionally filtered by hub.

    Requires READ on Capacity Planning (401/403 enforced by `_read`,
    P3-T02) and is hub-scoped (P3-T03): a Hub Planner's list is silently
    filtered to their own hub(s) server-side, regardless of what `hub_id`
    the caller passes.
    """

    stmt = select(Engineer)
    hub_filter = hub_scope_filter(current_user, Engineer.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    if hub_id is not None:
        stmt = stmt.where(Engineer.hub_id == hub_id)
    result = await db.execute(stmt.order_by(Engineer.name))
    return list(result.scalars().all())


@router.get("/{engineer_id}", response_model=EngineerRead)
async def get_engineer(
    engineer_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> Engineer:
    return await _get_engineer_or_404(db, engineer_id, current_user)


@router.post("", response_model=EngineerRead, status_code=status.HTTP_201_CREATED)
async def create_engineer(
    body: EngineerCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Engineer:
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

    engineer = Engineer(**body.model_dump())
    db.add(engineer)
    await db.flush()

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
    return engineer


@router.patch("/{engineer_id}", response_model=EngineerRead)
async def update_engineer(
    engineer_id: uuid.UUID,
    body: EngineerUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Engineer:
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

    before_state = engineer_audit_state(engineer)
    for field_name, value in body.model_dump(exclude_unset=True).items():
        setattr(engineer, field_name, value)
    await db.flush()
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
    return engineer


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
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete engineer: still referenced by existing projects/schedule data.",
        ) from exc
