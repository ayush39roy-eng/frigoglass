"""User / Role Admin (docs/API_CONTRACT_P9.md §2, ADR 0010 §1/§3).

**RBAC.** Surface `user_role_admin`: Admin and Super Admin, READ + WRITE.
The matrix's "(non-admin roles)" qualifier for Admin is enforced here:

- An Admin may not grant `Admin` or `Super Admin` (403,
  `ADMIN_ROLE_REQUIRES_SUPER_ADMIN`).
- An Admin may not modify an account that currently holds `Admin` or
  `Super Admin`, and that includes the Admin's own account (403,
  `ADMIN_ACCOUNT_REQUIRES_SUPER_ADMIN`).
- A Super Admin may do both.

**Last Super Admin guard.** A change that would leave no *active* Super
Admin gets 409 `LAST_SUPER_ADMIN`: deactivating the last one, or removing
the role from them. P9-R02 (security S-01): every PATCH that touches
`roles` or `is_active` first takes one transaction-scoped advisory lock
(`pg_advisory_xact_lock(SUPER_ADMIN_MEMBERSHIP_LOCK)`), then reads the
target and counts. Concurrent demotions are therefore serialised. A deadlock
or serialization failure maps to 409, never 500. The earlier row-lock
version let two demotions of *different* Super Admins both pass;
`tests/test_super_admin_race.py` reproduces that race.

**Audit.** Every create/update writes one `AuditLogEntry` (`user.create`,
`user.update`) with before/after snapshots of the account's roles, scopes,
active flag and engineer link, plus actor and target.

**Hub scoping.** Not applicable. User accounts are not project data, and
only `hub_scope_all` roles reach this surface.

**`GET /users/mention-search` and OQ#8.** It always returns `[]` while
docs/OPEN_QUESTIONS.md #8 is open. The P3-T09 withholding pattern shows a
person's name only to that person. A mention search exists to show *other*
people's names, and it would also let any workspace writer enumerate
accounts. Nothing is resolved until the DPO signs off. The route and its
response shape exist now, so the frontend can build against them. It
requires Project Workspace READ, the surface that uses it.

**`GET /users/me/manageable-projects` (2026-09-30, P10-F02).** Deliberately
NOT gated by `user_role_admin` READ (or any surface permission at all) —
just `Depends(get_current_principal)`. The Project Access tab's project
picker previously (mis)used `GET /projects`, gated by `project_registration`
READ, which Engineer/Executive Viewer/Auditor all lack even when one of them
is a manager-delegate who could otherwise manage their reports' grants
(`services.project_access.can_manage_grant`, ADR 0012 I18) — this endpoint
gives that picker a data source every authenticated principal can call.
It cannot leak anything the caller could not already reach one project at a
time via the existing `/projects/{id}/access` endpoints: it returns exactly
the projects where the caller's OWN `effective_project_access` resolves to
`"admin"` (`services.project_access.manageable_projects`), the same ceiling
`can_manage_grant`'s manager branch already requires. See that function's
own docstring for why this is a bounded per-caller resolver scan, not a
bespoke bulk query.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import get_current_principal, require_permission
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.engineer import Engineer
from models.enums import RoleName
from models.hub import Hub
from models.user import Role, User, UserHubScope, UserRole
from schemas.project_access import ManageableProjectRead
from schemas.user_admin import (
    MentionCandidate,
    RoleRead,
    UserCreateRequest,
    UserList,
    UserRead,
    UserUpdateRequest,
)
from services.project_access import manageable_projects

router = APIRouter(tags=["user-admin"])

_read = require_permission(Surface.USER_ROLE_ADMIN, Action.READ)
_write = require_permission(Surface.USER_ROLE_ADMIN, Action.WRITE)
_workspace_read = require_permission(Surface.PROJECT_WORKSPACE, Action.READ)

ADMIN_ROLES: frozenset[RoleName] = frozenset({RoleName.ADMIN, RoleName.SUPER_ADMIN})

#: Key for `pg_advisory_xact_lock` serialising Super Admin membership changes
#: (S-01). Any fixed bigint works; this one spells "RPDSA" in ASCII hex.
SUPER_ADMIN_MEMBERSHIP_LOCK = 0x5250445341
#: 40P01 deadlock_detected, 40001 serialization_failure.
_RETRYABLE_SQLSTATES = frozenset({"40P01", "40001"})


def _sqlstate(exc: DBAPIError) -> str | None:
    orig = exc.orig
    return getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)

ROLE_DESCRIPTIONS: dict[RoleName, str] = {
    RoleName.PORTFOLIO_MANAGER: "Portfolio-wide planning; writes Matrix, Registration, Workspace.",
    RoleName.HUB_PLANNER: "Plans their own hub(s): Capacity, Gantt, Registration, Workspace.",
    RoleName.ENGINEER: "Reads the Gantt and Project Workspace for their own assignments.",
    RoleName.EXECUTIVE_VIEWER: "Read-only view of every hub's dashboards and projects.",
    RoleName.AUDITOR: "Reads the append-only audit log.",
    RoleName.ADMIN: "Read/write on every planning surface; administers non-admin users.",
    RoleName.SUPER_ADMIN: "Every right, including admin roles and Workflow Settings.",
}


def _is_super_admin(principal: Principal) -> bool:
    return RoleName.SUPER_ADMIN in principal.roles


def _role_sort_key(role: RoleName) -> int:
    return list(RoleName).index(role)


def _user_roles(user: User) -> list[RoleName]:
    return sorted(
        (RoleName(ur.role.name) for ur in user.roles if ur.role is not None), key=_role_sort_key
    )


def _user_read(user: User, engineer_id: uuid.UUID | None) -> UserRead:
    return UserRead(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        is_active=user.is_active,
        roles=_user_roles(user),
        hub_scope_all=user.hub_scope_all,
        hub_ids=sorted((hs.hub_id for hs in user.hub_scopes), key=str),
        engineer_id=engineer_id,
        manager_id=user.manager_id,
        oidc_linked=user.oidc_subject is not None,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


def _audit_state(user: User, engineer_id: uuid.UUID | None) -> dict[str, Any]:
    return {
        "id": str(user.id),
        "email": user.email,
        "full_name": user.full_name,
        "is_active": user.is_active,
        "roles": [r.value for r in _user_roles(user)],
        "hub_scope_all": user.hub_scope_all,
        "hub_ids": sorted(str(hs.hub_id) for hs in user.hub_scopes),
        "engineer_id": str(engineer_id) if engineer_id else None,
        "manager_id": str(user.manager_id) if user.manager_id else None,
        "oidc_linked": user.oidc_subject is not None,
    }


async def _would_create_manager_cycle(
    db: AsyncSession, user_id: uuid.UUID, new_manager_id: uuid.UUID
) -> bool:
    """2026-09-30 (ADR 0012, P10-T02): walks UP the reporting chain from
    `new_manager_id` (via `User.manager_id`), looking for `user_id`. If found,
    setting `user_id`'s manager to `new_manager_id` would close a loop
    (`user_id -> new_manager_id -> ... -> user_id`). The trivial 1-hop
    self-cycle (`new_manager_id == user_id`) is caught by this same walk on
    its first iteration, and is also enforced as a DB CHECK
    (`ck_users_manager_id_not_self`) as a second line of defence. Bounded
    (the reporting graph is small, per this task's brief) rather than
    recursive, so a corrupt/cyclic chain already in the DB can never hang
    this request.
    """

    current: uuid.UUID | None = new_manager_id
    hops = 0
    while current is not None and hops < 10_000:
        if current == user_id:
            return True
        current = (
            await db.execute(select(User.manager_id).where(User.id == current))
        ).scalar_one_or_none()
        hops += 1
    return False


async def _load_user(db: AsyncSession, user_id: uuid.UUID) -> User | None:
    return (
        await db.execute(
            select(User)
            .options(
                selectinload(User.roles).selectinload(UserRole.role),
                selectinload(User.hub_scopes),
            )
            .where(User.id == user_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def _engineer_ids_by_user(
    db: AsyncSession, user_ids: list[uuid.UUID]
) -> dict[uuid.UUID, uuid.UUID]:
    if not user_ids:
        return {}
    rows = await db.execute(
        select(Engineer.user_id, Engineer.id).where(Engineer.user_id.in_(user_ids))
    )
    return {uid: eid for uid, eid in rows.all() if uid is not None}


async def _get_or_create_role(db: AsyncSession, name: RoleName) -> Role:
    role = (await db.execute(select(Role).where(Role.name == name.value))).scalar_one_or_none()
    if role is None:
        role = Role(name=name.value, description=ROLE_DESCRIPTIONS[name])
        db.add(role)
        await db.flush()
    return role


async def _validate_hubs(db: AsyncSession, hub_ids: list[uuid.UUID]) -> None:
    if not hub_ids:
        return
    found = set((await db.execute(select(Hub.id).where(Hub.id.in_(hub_ids)))).scalars().all())
    missing = [str(h) for h in hub_ids if h not in found]
    if missing:
        raise CodedHTTPException(
            HTTP_422, "UNKNOWN_HUB", f"Unknown hub_id(s): {missing}"
        )


async def _validate_engineer(
    db: AsyncSession, engineer_id: uuid.UUID, for_user_id: uuid.UUID | None
) -> Engineer:
    engineer = await db.get(Engineer, engineer_id)
    if engineer is None:
        raise CodedHTTPException(
            HTTP_422, "UNKNOWN_ENGINEER", "Unknown engineer_id"
        )
    if engineer.user_id is not None and engineer.user_id != for_user_id:
        raise CodedHTTPException(
            status.HTTP_409_CONFLICT,
            "ENGINEER_ALREADY_LINKED",
            "That engineer is already linked to another user account.",
        )
    return engineer


async def _email_taken(db: AsyncSession, email: str, except_user_id: uuid.UUID | None) -> bool:
    stmt = select(User.id).where(func.lower(User.email) == email.lower())
    if except_user_id is not None:
        stmt = stmt.where(User.id != except_user_id)
    return (await db.execute(stmt)).first() is not None


def _forbid_admin_roles_for_admin(principal: Principal, roles: list[RoleName]) -> None:
    if not _is_super_admin(principal) and ADMIN_ROLES.intersection(roles):
        raise CodedHTTPException(
            status.HTTP_403_FORBIDDEN,
            "ADMIN_ROLE_REQUIRES_SUPER_ADMIN",
            "Only a Super Admin may grant or revoke the Admin / Super Admin roles.",
        )


def _forbid_engineer_hub_scope_all(roles: list[RoleName], hub_scope_all: bool) -> None:
    """P10-F01 (security remediation, High): the definitive, DB-state-aware
    version of `schemas.user_admin`'s per-model `model_validator`s (which can
    only see one request's own fields in isolation). `roles`/`hub_scope_all`
    here must always be the fully merged (current DB state + this request's
    own patch) final values — never a partial view — so this also catches a
    PATCH that sets only `hub_scope_all=True` on an account that is already
    Engineer-only, or only `roles` to Engineer-only on an account that
    already has `hub_scope_all=True` from before this fix existed (the real
    `seed_dev_users.py`/`tests/factories.py::make_user` default prior to
    P10-F01). An Engineer-only account must never carry
    `hub_scope_all=True` — see `services.hub_scope.is_engineer_self_scoped`'s
    docstring for why this invariant matters (it is what makes that
    function's own defense-in-depth fix actually hold in practice, not just
    in theory).
    """

    if set(roles) == {RoleName.ENGINEER} and hub_scope_all:
        raise CodedHTTPException(
            HTTP_422,
            "ENGINEER_HUB_SCOPE_ALL_NOT_ALLOWED",
            "An Engineer-only account may not have hub_scope_all=True — Engineer is always "
            "scoped to their own assignments, never to every hub.",
        )


async def _set_roles(db: AsyncSession, user_id: uuid.UUID, roles: list[RoleName]) -> None:
    await db.execute(delete(UserRole).where(UserRole.user_id == user_id))
    for name in roles:
        role = await _get_or_create_role(db, name)
        db.add(UserRole(user_id=user_id, role_id=role.id))


async def _set_hub_scopes(db: AsyncSession, user_id: uuid.UUID, hub_ids: list[uuid.UUID]) -> None:
    await db.execute(delete(UserHubScope).where(UserHubScope.user_id == user_id))
    for hub_id in dict.fromkeys(hub_ids):
        db.add(UserHubScope(user_id=user_id, hub_id=hub_id))


async def _link_engineer(
    db: AsyncSession, user_id: uuid.UUID, engineer_id: uuid.UUID | None
) -> None:
    await db.execute(
        update(Engineer)
        .where(Engineer.user_id == user_id)
        .values(user_id=None)
        .execution_options(synchronize_session=False)
    )
    if engineer_id is not None:
        await db.execute(
            update(Engineer)
            .where(Engineer.id == engineer_id)
            .values(user_id=user_id)
            .execution_options(synchronize_session=False)
        )


@router.get("/users", response_model=UserList)
async def list_users(
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> UserList:
    stmt = select(User)
    if q and q.strip():
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(func.lower(User.email).like(needle), func.lower(User.full_name).like(needle))
        )
    count_stmt = select(func.count()).select_from(stmt.with_only_columns(User.id).subquery())
    total = (await db.execute(count_stmt)).scalar_one()
    users = (
        (
            await db.execute(
                stmt.options(
                    selectinload(User.roles).selectinload(UserRole.role),
                    selectinload(User.hub_scopes),
                )
                .order_by(User.email)
                .limit(limit)
                .offset(offset)
            )
        )
        .scalars()
        .all()
    )
    engineers = await _engineer_ids_by_user(db, [u.id for u in users])
    return UserList(
        total_count=int(total), items=[_user_read(u, engineers.get(u.id)) for u in users]
    )


@router.get("/roles", response_model=list[RoleRead])
async def list_roles(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[RoleRead]:
    stored: dict[str, str | None] = {
        str(r.name): r.description for r in (await db.execute(select(Role))).scalars().all()
    }
    is_super = _is_super_admin(current_user)
    return [
        RoleRead(
            name=role,
            description=stored.get(role.value) or ROLE_DESCRIPTIONS[role],
            assignable=is_super or role not in ADMIN_ROLES,
        )
        for role in RoleName
    ]


@router.post("/users", response_model=UserRead, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> UserRead:
    _forbid_admin_roles_for_admin(current_user, body.roles)
    _forbid_engineer_hub_scope_all(body.roles, body.hub_scope_all)
    if await _email_taken(db, body.email, None):
        raise CodedHTTPException(
            status.HTTP_409_CONFLICT, "EMAIL_TAKEN", "A user with that email already exists."
        )
    await _validate_hubs(db, body.hub_ids)
    if body.engineer_id is not None:
        await _validate_engineer(db, body.engineer_id, None)

    user = User(
        email=body.email,
        full_name=body.full_name,
        is_active=True,
        hub_scope_all=body.hub_scope_all,
    )
    db.add(user)
    await db.flush()
    await _set_roles(db, user.id, body.roles)
    await _set_hub_scopes(db, user.id, body.hub_ids)
    if body.engineer_id is not None:
        await _link_engineer(db, user.id, body.engineer_id)
    await db.flush()

    created = await _load_user(db, user.id)
    assert created is not None
    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="user.create",
            entity_type="User",
            entity_id=str(created.id),
            hub_id=None,
            before_state=None,
            after_state=_audit_state(created, body.engineer_id),
        )
    )
    await db.commit()
    return _user_read(created, body.engineer_id)


@router.patch("/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> UserRead:
    try:
        return await _update_user(user_id, body, db, current_user)
    except DBAPIError as exc:
        # S-01: a deadlock or serialization failure between concurrent
        # membership changes is a conflict, never a 500.
        if _sqlstate(exc) in _RETRYABLE_SQLSTATES:
            await db.rollback()
            raise CodedHTTPException(
                status.HTTP_409_CONFLICT,
                "LAST_SUPER_ADMIN",
                "A concurrent change to Super Admin membership won; reload and retry.",
            ) from exc
        raise


async def _update_user(
    user_id: uuid.UUID, body: UserUpdateRequest, db: AsyncSession, current_user: Principal
) -> UserRead:
    updates = body.model_dump(exclude_unset=True)
    if "roles" in updates or "is_active" in updates:
        # S-01 (P9-R02): every change that can alter Super Admin membership
        # takes one transaction-scoped advisory lock *before* reading the
        # target or counting. Concurrent demotions therefore run one after
        # the other, and the second one's count sees the first one's commit.
        # (Locking only the *other* Super Admins' rows, as before, let two
        # demotions lock different rows and both pass.)
        await db.execute(select(func.pg_advisory_xact_lock(SUPER_ADMIN_MEMBERSHIP_LOCK)))
    user = await _load_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    current_roles = _user_roles(user)
    is_super = _is_super_admin(current_user)
    if not is_super and ADMIN_ROLES.intersection(current_roles):
        raise CodedHTTPException(
            status.HTTP_403_FORBIDDEN,
            "ADMIN_ACCOUNT_REQUIRES_SUPER_ADMIN",
            "Only a Super Admin may modify an Admin or Super Admin account.",
        )
    for key in ("email", "full_name", "hub_scope_all", "is_active", "roles", "hub_ids"):
        if key in updates and updates[key] is None:
            raise CodedHTTPException(
                HTTP_422, "NULL_NOT_ALLOWED", f"{key} may not be null"
            )
    new_roles: list[RoleName] = updates["roles"] if "roles" in updates else current_roles
    if "roles" in updates:
        _forbid_admin_roles_for_admin(current_user, new_roles)
    effective_hub_scope_all = (
        updates["hub_scope_all"] if "hub_scope_all" in updates else user.hub_scope_all
    )
    _forbid_engineer_hub_scope_all(new_roles, effective_hub_scope_all)

    # --- Last Super Admin guard (ADR 0010 §1) ------------------------------
    was_active_super = user.is_active and RoleName.SUPER_ADMIN in current_roles
    will_be_active_super = updates.get("is_active", user.is_active) and (
        RoleName.SUPER_ADMIN in new_roles
    )
    if was_active_super and not will_be_active_super:
        others = (
            await db.execute(
                select(User.id)
                .join(UserRole, UserRole.user_id == User.id)
                .join(Role, Role.id == UserRole.role_id)
                .where(
                    Role.name == RoleName.SUPER_ADMIN.value,
                    User.is_active.is_(True),
                    User.id != user.id,
                )
            )
        ).all()
        if not others:
            raise CodedHTTPException(
                status.HTTP_409_CONFLICT,
                "LAST_SUPER_ADMIN",
                "This change would leave no active Super Admin.",
            )

    if "email" in updates and await _email_taken(db, updates["email"], user.id):
        raise CodedHTTPException(
            status.HTTP_409_CONFLICT, "EMAIL_TAKEN", "A user with that email already exists."
        )
    if "hub_ids" in updates:
        await _validate_hubs(db, updates["hub_ids"])
    if updates.get("engineer_id") is not None:
        await _validate_engineer(db, updates["engineer_id"], user.id)
    if updates.get("manager_id") is not None:
        # 2026-09-30 (ADR 0012, P10-T02): self-cycle and multi-hop cycle
        # rejection, both at the API layer (the DB only enforces the
        # trivial 1-hop CHECK). See `_would_create_manager_cycle`'s
        # docstring.
        new_manager_id = updates["manager_id"]
        if new_manager_id == user.id:
            raise CodedHTTPException(
                HTTP_422, "MANAGER_SELF_CYCLE", "A user cannot be their own manager."
            )
        manager = await db.get(User, new_manager_id)
        if manager is None:
            raise CodedHTTPException(HTTP_422, "UNKNOWN_MANAGER", "Unknown manager_id")
        if await _would_create_manager_cycle(db, user.id, new_manager_id):
            raise CodedHTTPException(
                status.HTTP_409_CONFLICT,
                "MANAGER_CYCLE",
                "This manager assignment would create a reporting-line cycle.",
            )

    engineers_before = await _engineer_ids_by_user(db, [user.id])
    before_state = _audit_state(user, engineers_before.get(user.id))

    for key in ("email", "full_name", "hub_scope_all", "is_active", "manager_id"):
        if key in updates:
            setattr(user, key, updates[key])
    if "roles" in updates:
        await _set_roles(db, user.id, new_roles)
    if "hub_ids" in updates:
        await _set_hub_scopes(db, user.id, updates["hub_ids"])
    if "engineer_id" in updates:
        await _link_engineer(db, user.id, updates["engineer_id"])
    await db.flush()

    updated = await _load_user(db, user.id)
    assert updated is not None
    engineer_id = (await _engineer_ids_by_user(db, [user.id])).get(user.id)
    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="user.update",
            entity_type="User",
            entity_id=str(updated.id),
            hub_id=None,
            before_state=before_state,
            after_state=_audit_state(updated, engineer_id),
        )
    )
    await db.commit()
    return _user_read(updated, engineer_id)


@router.get("/users/mention-search", response_model=list[MentionCandidate])
async def mention_search(
    q: str = Query(default="", max_length=200),
    current_user: Principal = Depends(_workspace_read),
) -> list[MentionCandidate]:
    """Always `[]` while docs/OPEN_QUESTIONS.md #8 is open. See the module
    docstring.
    """

    return []


@router.get("/users/me/manageable-projects", response_model=list[ManageableProjectRead])
async def list_manageable_projects(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> list[ManageableProjectRead]:
    """P10-F02. See the module docstring's own entry for this route for the
    authorization rationale (no surface gate, by design) and why it cannot
    leak beyond what the caller could already reach one project at a time.
    """

    projects = await manageable_projects(db, current_user)
    return sorted(
        (ManageableProjectRead(id=p.id, name=p.name, hub_id=p.hub_id) for p in projects),
        key=lambda p: p.name,
    )
