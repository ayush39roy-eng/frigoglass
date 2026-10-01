"""Session endpoints (docs/API_CONTRACT_P9.md §1, ADR 0010 §2/§4).

- `GET /me`: any authenticated principal. It returns who the caller is and
  the resolved `permissions[surface] = {read, write}` table. The frontend
  gates navigation and write controls on it, but the server stays the
  enforcement point. Every other endpoint still checks `core.rbac` itself.
- `GET /me/dev-users`: dev mode only (`RPD_DEV_MODE=true`), 404 otherwise.
  It lists the accounts the dev-only role switcher can pick for
  `X-Dev-User-Email`. It is a 404 rather than a 403 outside dev mode, so a
  production deployment does not even reveal that the switcher exists.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import get_current_principal
from core.config import is_dev_mode
from core.principal import Principal
from core.rbac import Action, Surface, role_allows
from models.engineer import Engineer
from models.enums import RoleName
from models.user import User, UserRole
from schemas.session import DevUser, MeResponse, SurfacePermission, SurfacePermissions
from services.project_access import has_any_manageable_project

router = APIRouter(prefix="/me", tags=["session"])

#: Upper bound on the dev switcher list. A dev database has a handful of
#: seeded users; the cap only keeps the query bounded.
_DEV_USERS_LIMIT = 100


def _role_sort_key(role: RoleName) -> int:
    return list(RoleName).index(role)


def resolve_permissions(roles: frozenset[RoleName]) -> SurfacePermissions:
    """The union of every held role's row of `core.rbac.PERMISSIONS`."""

    cells = {
        surface.value: SurfacePermission(
            read=any(role_allows(r, surface, Action.READ) for r in roles),
            write=any(role_allows(r, surface, Action.WRITE) for r in roles),
        )
        for surface in Surface
    }
    return SurfacePermissions(**cells)


async def _is_delegate_manager(db: AsyncSession, principal: Principal) -> bool:
    """P10-F03: true iff the caller has >=1 direct report AND >=1 project
    where their own `effective_project_access` resolves to `"admin"`. The
    cheap "any direct report at all" check runs first and short-circuits
    the common case (most principals manage no one) before ever touching
    `services.project_access.has_any_manageable_project`'s per-project scan.
    """

    has_report = (
        await db.execute(select(User.id).where(User.manager_id == principal.user_id).limit(1))
    ).first() is not None
    if not has_report:
        return False
    return await has_any_manageable_project(db, principal)


@router.get("", response_model=MeResponse)
async def get_me(
    db: AsyncSession = Depends(get_db),
    principal: Principal = Depends(get_current_principal),
) -> MeResponse:
    engineer_id = (
        await db.execute(select(Engineer.id).where(Engineer.user_id == principal.user_id))
    ).scalar_one_or_none()
    return MeResponse(
        user_id=principal.user_id,
        email=principal.email,
        full_name=principal.full_name,
        roles=sorted(principal.roles, key=_role_sort_key),
        hub_scope_all=principal.hub_scope_all,
        hub_ids=sorted(principal.hub_ids, key=str),
        engineer_id=engineer_id,
        permissions=resolve_permissions(principal.roles),
        dev_mode=is_dev_mode(),
        is_delegate_manager=await _is_delegate_manager(db, principal),
    )


@router.get("/dev-users", response_model=list[DevUser])
async def list_dev_users(
    db: AsyncSession = Depends(get_db),
    principal: Principal = Depends(get_current_principal),
) -> list[DevUser]:
    if not is_dev_mode():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")

    users = (
        (
            await db.execute(
                select(User)
                .options(selectinload(User.roles).selectinload(UserRole.role))
                .where(User.is_active.is_(True))
                .order_by(User.email)
                .limit(_DEV_USERS_LIMIT)
            )
        )
        .scalars()
        .all()
    )
    return [
        DevUser(
            email=u.email,
            full_name=u.full_name,
            roles=sorted(
                (RoleName(ur.role.name) for ur in u.roles if ur.role is not None),
                key=_role_sort_key,
            ),
        )
        for u in users
        if u.roles
    ]
