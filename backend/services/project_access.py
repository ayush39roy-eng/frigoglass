"""ADR 0012's single project-grain access resolver, plus the I18
delegation-authorization check.

**`effective_project_access`** is the one function every endpoint that needs
project-grain authorization must call — Project Workspace / Registration /
Gantt-row detail reads and writes, `ProjectAccessGrant` management, and
Ask-the-agent (ADR 0014). It composes with, and never duplicates,
`core.rbac.role_allows` (surface-level: "can this role do this verb on this
surface at all") and `services.hub_scope` (list-grain row filtering) — this
module additionally gates the *detail* of one specific, already-visible
project, and is the sole basis for granting access to a project a
principal's role/hub would not otherwise surface (an active
`ProjectAccessGrant`, ADR 0012 rule 5).

The six rules below are a MAX, never a first-match: a principal never loses
access one rule would give them because another rule alone would deny it,
and a grant is additive-only — it can never reduce what rules 1-4/6 already
give (`docs/DOMAIN_RULES.md` "Project access grants and delegation").
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import principal_can
from core.principal import Principal
from core.rbac import Action, Surface
from models.engineer import Engineer
from models.enums import RoleName
from models.project import Project
from models.project_access import ProjectAccessGrant
from models.schedule import ScheduleRunProjectStep
from models.user import User
from services.active_run import get_active_run
from services.hub_scope import is_hub_in_scope

#: A project-scoped role, per `models.enums.ProjectAccessRole` — kept as a
#: plain `Literal[str]` here (rather than importing the DB enum type) since
#: every caller of this module compares/ranks it as a bare string, exactly
#: like `ProjectAccessRole`'s own `str` base.
ProjectRole = Literal["viewer", "editor", "admin"]

_RANK: dict[ProjectRole, int] = {"viewer": 1, "editor": 2, "admin": 3}


def _max_role(a: ProjectRole | None, b: ProjectRole | None) -> ProjectRole | None:
    if a is None:
        return b
    if b is None:
        return a
    return a if _RANK[a] >= _RANK[b] else b


def meets_minimum(role: ProjectRole | None, minimum: ProjectRole) -> bool:
    """Whether a resolved role is at least `minimum` on the Viewer < Editor <
    Admin ladder. `role=None` (no access at all) never meets any minimum.
    """

    return role is not None and _RANK[role] >= _RANK[minimum]


async def _active_grant_role(
    db: AsyncSession, user_id: uuid.UUID, project_id: uuid.UUID
) -> ProjectRole | None:
    """Rule 5: an active `ProjectAccessGrant` for `(user, project)`, if any."""

    role = (
        await db.execute(
            select(ProjectAccessGrant.project_role).where(
                ProjectAccessGrant.user_id == user_id,
                ProjectAccessGrant.project_id == project_id,
                ProjectAccessGrant.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    return role.value if role is not None else None


async def _own_engineer_id(db: AsyncSession, principal: Principal) -> uuid.UUID | None:
    """Deliberately a small, self-contained duplicate of
    `services.workspace.own_engineer_id` (same one-line query) rather than an
    import from that module: `services.workspace.get_scoped_project_or_404`
    itself calls into THIS module (to fold rule 5 into its existing
    hub/engineer scoping), so importing the other direction here would be a
    module-level cycle. The query is trivial enough that duplicating it is
    cheaper than restructuring either module's boundary for this task.
    """

    return (
        await db.execute(select(Engineer.id).where(Engineer.user_id == principal.user_id))
    ).scalar_one_or_none()


async def _has_own_assignment(db: AsyncSession, principal: Principal, project: Project) -> bool:
    """Rule 6: "an Engineer linked to an Engineer row assigned to at least
    one ProjectWorkflowStep on the project" — unchanged from the existing
    Gantt/Workspace "own assignments" derivation
    (`services.hub_scope.is_engineer_self_scoped` /
    `services.workspace.get_scoped_project_or_404`): the project's leader, or
    a step of the *active* schedule run assigned to this engineer. Not a
    grant and not revocable via `ProjectAccessGrant`.
    """

    engineer_id = await _own_engineer_id(db, principal)
    if engineer_id is None:
        return False
    if project.leader_engineer_id == engineer_id:
        return True
    active = await get_active_run(db)
    if active is None:
        return False
    row = (
        await db.execute(
            select(ScheduleRunProjectStep.id)
            .where(
                ScheduleRunProjectStep.project_id == project.id,
                ScheduleRunProjectStep.schedule_run_id == active.id,
                ScheduleRunProjectStep.assigned_engineer_id == engineer_id,
            )
            .limit(1)
        )
    ).first()
    return row is not None


async def effective_project_access(
    db: AsyncSession, principal: Principal, project: Project
) -> ProjectRole | None:
    """The MAX over every applicable rule of `docs/DOMAIN_RULES.md`'s
    "Project access grants and delegation" section (ADR 0012 §3):

    1. Super Admin -> Admin, unconditionally.
    2. Admin (global) or Portfolio Manager -> Admin, unconditionally.
    3. Hub Planner, project's hub in the caller's hub scope -> Admin.
    4. Executive Viewer -> Viewer, unconditionally.
    5. An active `ProjectAccessGrant` for `(user, project)` -> the grant's
       role.
    6. An Engineer linked to an assignment on the project -> Viewer.
    7. Otherwise -> `None`.
    """

    if RoleName.SUPER_ADMIN in principal.roles:
        return "admin"  # nothing outranks Admin; short-circuit is safe.

    role: ProjectRole | None = None

    if RoleName.ADMIN in principal.roles or RoleName.PORTFOLIO_MANAGER in principal.roles:
        role = _max_role(role, "admin")

    if RoleName.HUB_PLANNER in principal.roles and is_hub_in_scope(principal, project.hub_id):
        role = _max_role(role, "admin")

    if RoleName.EXECUTIVE_VIEWER in principal.roles:
        role = _max_role(role, "viewer")

    role = _max_role(role, await _active_grant_role(db, principal.user_id, project.id))

    if RoleName.ENGINEER in principal.roles and await _has_own_assignment(db, principal, project):
        role = _max_role(role, "viewer")

    return role


async def manageable_projects(db: AsyncSession, principal: Principal) -> list[Project]:
    """P10-F02: every project where `principal`'s OWN
    `effective_project_access` resolves to `"admin"` — exactly the ADR 0012
    ceiling for who they could grant/revoke access on anyway
    (`can_manage_grant`'s manager branch requires precisely this), so this
    cannot leak anything the caller could not already reach one project at a
    time via the existing `GET/POST/DELETE /projects/{id}/access` endpoints
    — it is only a convenience list for `GET /users/me/manageable-projects`.

    A bounded per-caller scan (one `effective_project_access` call per
    project) rather than a bespoke bulk SQL query: cheap at this app's real
    scale (~236 projects portfolio-wide, per CLAUDE.md), and keeps this list
    provably consistent with the one-project-at-a-time resolver every other
    grant endpoint already calls, rather than risking a second, divergent
    implementation of the same six-rule MAX. Shared with
    `has_any_manageable_project` below (P10-F03's `/me` signal), which scans
    the same way but short-circuits at the first hit.
    """

    projects = (await db.execute(select(Project))).scalars().all()
    result: list[Project] = []
    for project in projects:
        if await effective_project_access(db, principal, project) == "admin":
            result.append(project)
    return result


async def has_any_manageable_project(db: AsyncSession, principal: Principal) -> bool:
    """Same scan as `manageable_projects`, short-circuiting at the first
    `"admin"` hit — used where only the yes/no answer is needed (P10-F03's
    `GET /me` `is_delegate_manager` signal), so a caller who would resolve
    `"admin"` on nearly every project (e.g. a global Admin/Portfolio
    Manager/in-scope Hub Planner, via rules 1-3) does not pay for scanning
    the full portfolio just to answer yes. Callers of this function are
    expected to have already cheaply ruled out "no direct reports at all"
    first (see `api/routers/me.py::get_me`) — that is the common case for
    most principals, and skips this scan entirely.
    """

    projects = (await db.execute(select(Project))).scalars().all()
    for project in projects:
        if await effective_project_access(db, principal, project) == "admin":
            return True
    return False


def can_manage_grant(
    actor: Principal, target_user: User, actor_effective_role_on_project: ProjectRole | None
) -> bool:
    """I18: a `ProjectAccessGrant` write (grant or revoke) is authorized only
    when the actor is Super Admin, global Admin, or a manager
    granting/revoking their own direct report on a project where the
    manager's own effective access is Admin.

    `actor_effective_role_on_project` is the caller's OWN
    `effective_project_access(db, actor, project)` result, computed by the
    caller (this function stays synchronous/pure so it is trivially unit
    testable without a DB session) — i.e. `M`'s own access must already be
    `"admin"` for the manager branch. A manager can grant any of
    Viewer/Editor/Admin once that condition holds: their own Admin-level
    access on the project is already the ceiling, so this function does not
    branch on the *requested* role at all.

    No principal can grant a project role to themselves, to a non-report, or
    on a project they cannot themselves administer: the manager branch below
    requires `target_user.manager_id == actor.user_id`, which is never true
    of `actor` itself (a manager can never be their own manager — the
    self-cycle CHECK on `users.manager_id` guarantees `target_user.id ==
    actor.user_id` and `target_user.manager_id == actor.user_id` cannot both
    hold), so self-grant is already impossible through this branch. Super
    Admin/global Admin granting to themselves is harmless by construction:
    they already have unconditional Admin access via rules 1/2 of
    `effective_project_access`, so such a grant can never increase (or
    decrease) their own effective access.
    """

    if RoleName.SUPER_ADMIN in actor.roles or RoleName.ADMIN in actor.roles:
        return True
    return (
        target_user.manager_id == actor.user_id and actor_effective_role_on_project == "admin"
    )


async def authorize_project_action(
    db: AsyncSession,
    principal: Principal,
    project: Project,
    *,
    surface: Surface,
    action: Action,
    min_grant_role: ProjectRole,
) -> None:
    """The single composition point for gating a project-scoped mutation:
    403s unless EITHER the caller's global role already grants `action` on
    `surface` (the unchanged ADR 0010 matrix, via `api.deps.principal_can`)
    OR their resolved project-grain access (`effective_project_access`) is
    at least `min_grant_role`. Callers pass `min_grant_role="editor"` for
    the three actions ADR 0012 lets an Editor grant perform (stage-progress
    PATCH, file upload, comment post) and `"admin"` for everything else a
    project-scoped Admin grant should unlock (Registration writes, and every
    other currently role-gated Workspace mutation) — never `"viewer"`,
    which never authorizes a write.
    """

    if principal_can(principal, surface, action):
        return
    role = await effective_project_access(db, principal, project)
    if meets_minimum(role, min_grant_role):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            f"Neither role {sorted(r.value for r in principal.roles)} nor project-level "
            f"access permits this action (requires at least {min_grant_role!r} on this "
            "project)."
        ),
    )
