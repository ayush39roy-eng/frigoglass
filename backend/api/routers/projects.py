"""Project Registration surface — full CRUD on `Project`
(`docs/PROJECT_AND_STACK.md` §2), including the Draft hard-gate.

**RBAC (P3-T02)**: every endpoint below requires a real, validated OIDC
token (`api.deps.get_current_principal` — 401 if missing/invalid) and
action-level permission on the `PROJECT_REGISTRATION` surface
(`core.rbac.Surface.PROJECT_REGISTRATION`) per `docs/PROJECT_AND_STACK.md`
§5: reads need `READ`, mutations need `WRITE` (Portfolio Manager, Hub
Planner, Admin only — Engineer/Executive Viewer/Auditor get 403 on
everything here).

**Hub-scoped (P3-T03)**: every read/write below is additionally filtered to
the caller's own hub(s) via `services.hub_scope`, unless
`current_user.hub_scope_all` (Portfolio Manager/Admin — Executive Viewer is
READ-only elsewhere and has no access to this surface at all per the
matrix). A Hub Planner's list is silently filtered; a direct `GET
/projects/{id}` (or PATCH/submit) on an out-of-scope project 404s exactly
like a nonexistent one, never 200s with cross-hub data. Creating/moving a
project to a hub outside the caller's scope 403s (`services.hub_scope.
is_hub_in_scope`) — there is no existing row to scope-filter a lookup
against for a `POST`/for a `hub_id` reassignment, so that check is explicit.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.enums import ProjectCategory, ProjectPriority, ProjectStatus, ProjectType
from models.hub import Hub
from models.project import Project
from schemas.project import (
    HardGateStatus,
    ProjectCreateRequest,
    ProjectListItem,
    ProjectRead,
    ProjectSubmitRequest,
    ProjectUpdateRequest,
)
from services.audit_helpers import project_audit_state
from services.hub_scope import hub_scope_filter, is_hub_in_scope
from services.project_hard_gates import missing_hard_gate_fields

router = APIRouter(prefix="/projects", tags=["projects"])

_read = require_permission(Surface.PROJECT_REGISTRATION, Action.READ)
_write = require_permission(Surface.PROJECT_REGISTRATION, Action.WRITE)


async def _get_project_or_404(
    db: AsyncSession, project_id: uuid.UUID, principal: Principal
) -> Project:
    stmt = select(Project).where(Project.id == project_id)
    hub_filter = hub_scope_filter(principal, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


@router.get("", response_model=list[ProjectListItem])
async def list_projects(
    hub_id: uuid.UUID | None = None,
    category: ProjectCategory | None = None,
    status_: ProjectStatus | None = None,
    priority: ProjectPriority | None = None,
    type_: ProjectType | None = None,
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[Project]:
    """List/filter projects. Requires READ on the Project Registration
    surface (401/403 enforced by `_read`, P3-T02) and is hub-scoped
    (P3-T03): a Hub Planner only ever sees their own hub(s)' projects here,
    server-side (`services.hub_scope.hub_scope_filter`), regardless of what
    `hub_id` the caller passes — an explicit out-of-scope `hub_id` query
    param simply yields an empty list (the AND of both filters), not a 403,
    matching this endpoint's existing "filter narrows silently" convention
    for its other query params.
    """

    if limit < 1 or limit > 500:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 500")
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be >= 0")

    stmt = select(Project)
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    if hub_id is not None:
        stmt = stmt.where(Project.hub_id == hub_id)
    if category is not None:
        stmt = stmt.where(Project.category == category)
    if status_ is not None:
        stmt = stmt.where(Project.status == status_)
    if priority is not None:
        stmt = stmt.where(Project.priority == priority)
    if type_ is not None:
        stmt = stmt.where(Project.type == type_)
    stmt = stmt.order_by(Project.name).limit(limit).offset(offset)

    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/{project_id}", response_model=ProjectRead)
async def get_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> Project:
    return await _get_project_or_404(db, project_id, current_user)


@router.get("/{project_id}/hard-gate-status", response_model=HardGateStatus)
async def get_hard_gate_status(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> HardGateStatus:
    """Which required fields are still missing before this project can leave
    `Draft` (`services.project_hard_gates.missing_hard_gate_fields`). Read-only
    — does not mutate anything, so no audit row.
    """

    project = await _get_project_or_404(db, project_id, current_user)
    missing = missing_hard_gate_fields(project)
    return HardGateStatus(can_leave_draft=not missing, missing_fields=missing)


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Project:
    """Create a new project — always starts in `Draft`
    (`ProjectStatus.DRAFT`), regardless of how fully the body is filled in.
    """

    hub = (await db.execute(select(Hub).where(Hub.id == body.hub_id))).scalar_one_or_none()
    if hub is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown hub_id"
        )
    if not is_hub_in_scope(current_user, body.hub_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot create a project for a hub outside your assigned hub scope.",
        )

    data = body.model_dump()
    project = Project(**data, status=ProjectStatus.DRAFT)
    db.add(project)
    await db.flush()

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project.create",
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state=None,
            after_state=project_audit_state(project),
        )
    )
    await db.commit()
    await db.refresh(project)
    return project


@router.patch("/{project_id}", response_model=ProjectRead)
async def update_project(
    project_id: uuid.UUID,
    body: ProjectUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Project:
    """Partial update. See `schemas.project.ProjectUpdateRequest`'s docstring:
    `frozen` is not settable here (use the Gantt freeze toggle), and `status`
    may not be used to leave `Draft` here (use `POST /{id}/submit`, which
    runs the hard-gate check).
    """

    project = await _get_project_or_404(db, project_id, current_user)
    updates = body.model_dump(exclude_unset=True)

    if "status" in updates and project.status == ProjectStatus.DRAFT:
        new_status = updates["status"]
        if new_status != ProjectStatus.DRAFT:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Cannot change status away from Draft via PATCH — use "
                    f"POST /projects/{project_id}/submit, which runs the hard-gate check."
                ),
            )

    if "hub_id" in updates and updates["hub_id"] is not None:
        hub_result = await db.execute(select(Hub).where(Hub.id == updates["hub_id"]))
        hub = hub_result.scalar_one_or_none()
        if hub is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown hub_id"
            )
        # Moving a project to a different hub is itself a hub-scoped write —
        # a Hub Planner may not reassign a project (even one already in
        # their own scope) to a hub outside it.
        if not is_hub_in_scope(current_user, updates["hub_id"]):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot move a project to a hub outside your assigned hub scope.",
            )

    before_state = project_audit_state(project)
    for field_name, value in updates.items():
        setattr(project, field_name, value)
    await db.flush()
    after_state = project_audit_state(project)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project.update",
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


@router.post("/{project_id}/submit", response_model=ProjectRead)
async def submit_project(
    project_id: uuid.UUID,
    body: ProjectSubmitRequest = ProjectSubmitRequest(),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Project:
    """Leave `Draft` status, per `docs/PROJECT_AND_STACK.md` §2's hard gate:
    "Hard gates enforce required fields before a project can leave draft
    status." 422s with the list of missing fields if any hard-gate field is
    still unset; otherwise transitions to `body.target_status` (default
    `In Queue`).
    """

    project = await _get_project_or_404(db, project_id, current_user)
    if project.status != ProjectStatus.DRAFT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Project is not in Draft status (currently {project.status.value!r})",
        )
    disallowed_targets = (ProjectStatus.DRAFT, ProjectStatus.COMMERCIALIZED, ProjectStatus.ON_HOLD)
    if body.target_status in disallowed_targets:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"target_status must be one of the four schedulable statuses "
                f"(In Buyoff/Under Industrialization/In Development/In Queue), "
                f"got {body.target_status.value!r}"
            ),
        )

    missing = missing_hard_gate_fields(project)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": "Project cannot leave Draft status: required fields missing.",
                "missing_fields": missing,
            },
        )

    before_state = project_audit_state(project)
    project.status = body.target_status
    await db.flush()
    after_state = project_audit_state(project)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project.submit",
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
