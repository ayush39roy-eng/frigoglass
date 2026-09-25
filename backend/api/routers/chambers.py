"""Capacity Planning surface — Chamber CRUD (`docs/PROJECT_AND_STACK.md` §2).

**"Apply Logic" / "Auto-assign" are explicitly OUT OF SCOPE here** — see
`api/routers/engineers.py`'s module docstring; the same P3-T06 deferral
applies to Chambers.

**RBAC (P3-T02)**: same enforcement as `api/routers/engineers.py` — reads
need `CAPACITY_PLANNING`/`READ`, mutations need `CAPACITY_PLANNING`/`WRITE`.

**Hub-scoped (P3-T03) — via lab region, not hub_id**: `Chamber` has no
`hub_id` column (`models/chamber.py`) — a lab region is shared by up to four
hubs (`docs/DOMAIN_RULES.md`'s hub/lab-region mapping table: R&D-India,
PD-India, OEM-HCK and OEM-Seltek all map to "India"). A Hub Planner's
visibility here is therefore resolved via `services.hub_scope.
scoped_lab_regions` (their scoped hub_ids -> the `LabRegion`s those hubs map
to) rather than a direct `.where(Chamber.hub_id.in_(...))`, since no such
column exists — see `docs/MEMORY.md`'s P3-T03 entry for the full rationale.
A Hub Planner therefore sees every chamber in their hub's lab region
(shared infrastructure), not zero chambers.
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
from models.chamber import Chamber
from models.enums import WorkflowStepKind
from models.workflow import WorkflowStepTemplate
from schemas.chamber import ChamberCreateRequest, ChamberRead, ChamberUpdateRequest
from services.audit_helpers import chamber_audit_state
from services.hub_scope import is_lab_region_in_scope, scoped_lab_regions

router = APIRouter(prefix="/chambers", tags=["capacity-planning", "chambers"])

_read = require_permission(Surface.CAPACITY_PLANNING, Action.READ)
_write = require_permission(Surface.CAPACITY_PLANNING, Action.WRITE)


async def _get_chamber_or_404(
    db: AsyncSession, chamber_id: uuid.UUID, principal: Principal
) -> Chamber:
    stmt = select(Chamber).where(Chamber.id == chamber_id)
    regions = await scoped_lab_regions(db, principal)
    if regions is not None:
        stmt = stmt.where(Chamber.lab_region.in_(regions))
    result = await db.execute(stmt)
    chamber = result.scalar_one_or_none()
    if chamber is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chamber not found")
    return chamber


async def _validate_allowed_stages(db: AsyncSession, allowed_stages: list[str]) -> None:
    """Per `models/chamber.py`'s docstring: `allowed_stages` should only
    contain lab-kind step IDs — "app-layer validation (P3) should reject
    design-step IDs here." This is that validation.
    """

    if not allowed_stages:
        return
    result = await db.execute(
        select(WorkflowStepTemplate.id, WorkflowStepTemplate.kind).where(
            WorkflowStepTemplate.id.in_(allowed_stages)
        )
    )
    found = {row.id: row.kind for row in result.all()}
    unknown = [s for s in allowed_stages if s not in found]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown workflow step id(s) in allowed_stages: {unknown}",
        )
    non_lab = [s for s in allowed_stages if found[s] != WorkflowStepKind.LAB]
    if non_lab:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"allowed_stages must be lab-kind steps only, got design-kind: {non_lab}",
        )


@router.get("", response_model=list[ChamberRead])
async def list_chambers(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[Chamber]:
    """List chambers, hub-scoped (P3-T03) via lab region: a Hub Planner sees
    every chamber in their hub(s)' lab region(s) (`services.hub_scope.
    scoped_lab_regions`), not just chambers named after their own hub (there
    is no such 1:1 mapping — see module docstring).
    """

    stmt = select(Chamber)
    regions = await scoped_lab_regions(db, current_user)
    if regions is not None:
        stmt = stmt.where(Chamber.lab_region.in_(regions))
    result = await db.execute(stmt.order_by(Chamber.code))
    return list(result.scalars().all())


@router.get("/{chamber_id}", response_model=ChamberRead)
async def get_chamber(
    chamber_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> Chamber:
    return await _get_chamber_or_404(db, chamber_id, current_user)


@router.post("", response_model=ChamberRead, status_code=status.HTTP_201_CREATED)
async def create_chamber(
    body: ChamberCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Chamber:
    await _validate_allowed_stages(db, body.allowed_stages)

    regions = await scoped_lab_regions(db, current_user)
    if not is_lab_region_in_scope(regions, body.lab_region):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot create a chamber in a lab region outside your assigned hub scope.",
        )

    chamber = Chamber(**body.model_dump())
    db.add(chamber)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Chamber code already exists"
        ) from exc

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="chamber.create",
            entity_type="Chamber",
            entity_id=str(chamber.id),
            hub_id=None,
            before_state=None,
            after_state=chamber_audit_state(chamber),
        )
    )
    await db.commit()
    await db.refresh(chamber)
    return chamber


@router.patch("/{chamber_id}", response_model=ChamberRead)
async def update_chamber(
    chamber_id: uuid.UUID,
    body: ChamberUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Chamber:
    chamber = await _get_chamber_or_404(db, chamber_id, current_user)

    if body.allowed_stages is not None:
        await _validate_allowed_stages(db, body.allowed_stages)

    if body.lab_region is not None:
        regions = await scoped_lab_regions(db, current_user)
        if not is_lab_region_in_scope(regions, body.lab_region):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "Cannot move a chamber to a lab region outside your assigned hub scope."
                ),
            )

    before_state = chamber_audit_state(chamber)
    for field_name, value in body.model_dump(exclude_unset=True).items():
        setattr(chamber, field_name, value)

    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Chamber code already exists"
        ) from exc
    after_state = chamber_audit_state(chamber)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="chamber.update",
            entity_type="Chamber",
            entity_id=str(chamber.id),
            hub_id=None,
            before_state=before_state,
            after_state=after_state,
        )
    )
    await db.commit()
    await db.refresh(chamber)
    return chamber


@router.delete("/{chamber_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_chamber(
    chamber_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> None:
    """Delete a chamber. Fails with 409 if still referenced by a workflow step
    or schedule-run snapshot — same rationale as `engineers.delete_engineer`.
    """

    chamber = await _get_chamber_or_404(db, chamber_id, current_user)
    before_state = chamber_audit_state(chamber)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="chamber.delete",
            entity_type="Chamber",
            entity_id=str(chamber.id),
            hub_id=None,
            before_state=before_state,
            after_state=None,
        )
    )
    await db.delete(chamber)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete chamber: still referenced by existing schedule data.",
        ) from exc
