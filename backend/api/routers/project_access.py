"""Project-level access grants (2026-09-30, ADR 0012; I18).

`GET/POST/DELETE /projects/{id}/access` — a Super Admin/global Admin
manages every grant on every project; a manager (per `User.manager_id`)
manages grants only for their own direct reports, only on a project where
their own `effective_project_access` is Admin. All three endpoints run
`services.project_access.can_manage_grant` and 403 (never a silent no-op) on
failure, per I18 and this task's brief.

Every grant/revoke writes an `AuditLogEntry` (actor, target, project, role,
action) — the same append-only audit log every other mutation uses.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import get_current_principal
from api.errors import CodedHTTPException
from core.principal import Principal
from models.audit import AuditLogEntry
from models.enums import RoleName
from models.project import Project
from models.project_access import ProjectAccessGrant
from models.user import User
from schemas.project_access import ProjectAccessGrantCreateRequest, ProjectAccessGrantRead
from services.project_access import can_manage_grant, effective_project_access

router = APIRouter(prefix="/projects", tags=["project-access"])

_MANAGING_ROLES = frozenset({RoleName.SUPER_ADMIN, RoleName.ADMIN})


async def _project_or_404(db: AsyncSession, project_id: uuid.UUID) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


async def _user_or_404(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def _grant_read(grant: ProjectAccessGrant) -> ProjectAccessGrantRead:
    return ProjectAccessGrantRead(
        id=grant.id,
        project_id=grant.project_id,
        user_id=grant.user_id,
        project_role=grant.project_role,
        granted_by_user_id=grant.granted_by_user_id,
        created_at=grant.created_at,
    )


def _audit_state(grant: ProjectAccessGrant) -> dict[str, str | None]:
    return {
        "id": str(grant.id),
        "project_id": str(grant.project_id),
        "user_id": str(grant.user_id),
        "project_role": grant.project_role.value,
        "granted_by_user_id": str(grant.granted_by_user_id),
        "revoked_at": grant.revoked_at.isoformat() if grant.revoked_at else None,
    }


@router.get("/{project_id}/access", response_model=list[ProjectAccessGrantRead])
async def list_access(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> list[ProjectAccessGrantRead]:
    """Super Admin/global Admin see every active grant on the project. A
    manager (non-Super-Admin, non-global-Admin) whose own effective access
    on the project is Admin sees only the grants of their own direct
    reports — the same server-side scoping the `/admin/users` Project
    Access tab relies on so there is one code path, not a "manager mode"
    UI (ADR 0012 §5). Anyone else gets 403.
    """

    project = await _project_or_404(db, project_id)
    is_top = bool(current_user.roles & _MANAGING_ROLES)
    if not is_top:
        actor_role = await effective_project_access(db, current_user, project)
        if actor_role != "admin":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not authorized to view this project's access grants.",
            )

    grants = (
        (
            await db.execute(
                select(ProjectAccessGrant).where(
                    ProjectAccessGrant.project_id == project_id,
                    ProjectAccessGrant.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    if not is_top:
        report_ids = set(
            (
                await db.execute(select(User.id).where(User.manager_id == current_user.user_id))
            )
            .scalars()
            .all()
        )
        grants = [g for g in grants if g.user_id in report_ids]
    return [_grant_read(g) for g in grants]


@router.post(
    "/{project_id}/access", response_model=ProjectAccessGrantRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_access(
    project_id: uuid.UUID,
    body: ProjectAccessGrantCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> ProjectAccessGrantRead:
    project = await _project_or_404(db, project_id)
    target = await _user_or_404(db, body.user_id)
    actor_role = await effective_project_access(db, current_user, project)
    if not can_manage_grant(current_user, target, actor_role):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Not authorized to grant project access — must be Super Admin, global "
                "Admin, or the target's manager with Admin-level access on this project."
            ),
        )

    grant = ProjectAccessGrant(
        project_id=project.id,
        user_id=target.id,
        project_role=body.project_role,
        granted_by_user_id=current_user.user_id,
    )
    db.add(grant)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise CodedHTTPException(
            status.HTTP_409_CONFLICT,
            "ACTIVE_GRANT_EXISTS",
            "This user already has an active grant on this project. Revoke it first.",
        ) from exc

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project_access_grant.create",
            entity_type="ProjectAccessGrant",
            entity_id=str(grant.id),
            hub_id=project.hub_id,
            before_state=None,
            after_state=_audit_state(grant),
        )
    )
    await db.commit()
    await db.refresh(grant)
    return _grant_read(grant)


@router.delete("/{project_id}/access/{grant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_access(
    project_id: uuid.UUID,
    grant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> None:
    project = await _project_or_404(db, project_id)
    grant = await db.get(ProjectAccessGrant, grant_id)
    if grant is None or grant.project_id != project.id or grant.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grant not found")
    target = await _user_or_404(db, grant.user_id)
    actor_role = await effective_project_access(db, current_user, project)
    if not can_manage_grant(current_user, target, actor_role):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Not authorized to revoke project access — must be Super Admin, global "
                "Admin, or the target's manager with Admin-level access on this project."
            ),
        )

    before_state = _audit_state(grant)
    grant.revoked_at = datetime.now(UTC)
    await db.flush()
    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project_access_grant.revoke",
            entity_type="ProjectAccessGrant",
            entity_id=str(grant.id),
            hub_id=project.hub_id,
            before_state=before_state,
            after_state=_audit_state(grant),
        )
    )
    await db.commit()
