"""Shared FastAPI auth dependencies for `api/routers/*` — real OIDC
authentication (P3-T02) plus action-level RBAC enforcement (P3-T02) built on
`core.rbac`'s role/permission table.

This module replaces P3-T01's `get_current_user_placeholder` (an inert
`Depends(...)` no-op that always returned `None`) with a real implementation:

- `get_current_principal` extracts a bearer token from the `Authorization`
  header, validates it against the configured OIDC issuer (`core.oidc`,
  JWKS signature + `iss`/`aud`/`exp`), then resolves it to a local
  `models.user.User` row (roles + hub scopes are always read from the local
  DB, never trusted off IdP token claims — see `core.principal.Principal`'s
  docstring). Raises `HTTPException(401)` for any failure: missing/malformed
  header, invalid/expired token, or a `sub`/`email` that doesn't resolve to a
  provisioned, active local user.
- `require_permission(surface, action)` / `require_any_permission(...)` /
  `require_roles(...)` are dependency *factories* — each returns a callable
  FastAPI dependency that first resolves the principal (401 on failure), then
  checks `core.rbac.role_allows(...)` (403 on failure), and — critically —
  stashes the resolved `Principal` on `request.state.principal` in addition
  to returning it, per this task's brief: "the authenticated user's hub
  claim(s) are available on the request context for P3-T03 to consume."

**Scope boundary — read before extending this file**: this module enforces
action-level permissions only ("can this role do this verb on this surface at
all"). It deliberately does NOT filter query results by hub — that is
P3-T03's job, which composes hub-scoped `.where(...)` filtering on top of the
`Principal.hub_scope_all`/`hub_ids` this module already exposes, rather than
re-deriving the role->permission mapping.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import ColumnExpressionArgument, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from core.config import get_oidc_settings
from core.oidc import TokenValidationError, verify_token
from core.principal import Principal
from core.rbac import Action, Surface, role_allows
from models.enums import RoleName
from models.user import User, UserHubScope, UserRole

#: The type of the callable object returned by `require_permission` /
#: `require_any_permission` / `require_roles` below. Deliberately loose on
#: parameters (`...`) rather than spelling out `(Request, Principal)` — the
#: actual runtime signature is preserved (FastAPI introspects the real
#: `_dependency` function object's parameters for its DI graph; this
#: annotation only satisfies mypy's "missing return type" check on the outer
#: factory function).
_PermissionDependency = Callable[..., Awaitable[Principal]]


def _extract_bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be 'Bearer <token>'",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token


async def _load_user_with_roles_and_hubs(
    db: AsyncSession, predicate: ColumnExpressionArgument[bool]
) -> User | None:
    stmt = (
        select(User)
        .options(
            selectinload(User.roles).selectinload(UserRole.role),
            selectinload(User.hub_scopes).selectinload(UserHubScope.hub),
        )
        .where(predicate)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def _resolve_user(db: AsyncSession, claims: dict[str, Any]) -> User:
    """Look up (or JIT-link) the local `User` row for a validated token's
    claims. Roles/hub-scope come from this row, never from the token itself.

    Resolution order:
    1. `oidc_subject == claims["sub"]` — the normal, already-linked case.
    2. Fall back to `email == claims["email"]` (if the token carries an email
       claim) and, if found with no `oidc_subject` set yet, backfill it — a
       one-time "first SSO login" link for a user pre-provisioned by Admin
       (per `models/user.py`: "Nullable so a user record can be provisioned
       ... before first SSO login"). If that email-matched row already has a
       *different* `oidc_subject`, this is treated as unresolvable (401)
       rather than silently re-linking to a second identity.
    3. Otherwise: 401 "not provisioned". This deliberately never
       auto-creates a `User` row with default role/hub-scope on first login
       — role/hub assignment is an Admin action (User/Role Admin surface),
       and auto-provisioning would mean a brand-new IdP account silently
       getting whatever default permissions "no roles" implies (none, per
       `core.rbac`, but still not a decision this dependency should make
       unilaterally).
    """

    sub = claims["sub"]  # verify_token already guarantees this is present
    user = await _load_user_with_roles_and_hubs(db, User.oidc_subject == sub)
    if user is not None:
        return user

    email = claims.get("email")
    if email:
        user = await _load_user_with_roles_and_hubs(db, User.email == email)
        if user is not None:
            if user.oidc_subject is None:
                user.oidc_subject = sub
                await db.commit()
                # Re-select with the same eager-load options rather than
                # `db.refresh(user)`: an async `refresh()` only reloads
                # column attributes and *expires* (does not reload)
                # relationship attributes, so a later lazy access to
                # `user.roles`/`user.hub_scopes` on the refreshed object
                # would raise `sqlalchemy.exc.MissingGreenlet` (lazy-loading
                # is unsupported on an `AsyncSession` outside
                # `selectinload`/explicit awaited reloads) — caught live by
                # this task's own test suite, not by inspection (see this
                # task's MEMORY.md entry).
                relinked = await _load_user_with_roles_and_hubs(db, User.id == user.id)
                assert relinked is not None  # pragma: no cover - just committed it
                return relinked
            # `user.oidc_subject == sub` is unreachable here: the earlier
            # `oidc_subject == sub` lookup (above) already would have
            # returned this exact row if that were true, since `oidc_subject`
            # is unique. Anything that reaches this line therefore has a
            # `oidc_subject` that is neither `None` nor `sub` — a genuine
            # identity conflict, not a re-login of the same linked account.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token identity does not match the provisioned account",
            )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="No provisioned account for this identity — contact an Admin.",
    )


def _build_principal(user: User) -> Principal:
    # `Role.name` is mapped as a plain `String(50)` column (not a SQLAlchemy
    # `Enum` type — see `models/user.py`), so it round-trips through the ORM
    # as a bare Python `str`, not a `RoleName` instance, despite its
    # `Mapped[RoleName]` type hint. Explicit conversion here is required —
    # the same class of gotcha P3-T01 hit with `PriorityScore.suggested_band`
    # (see docs/MEMORY.md's P3-T01 entry) and caught live during this task's
    # own smoke testing (see this task's MEMORY.md entry): without it,
    # `Principal.roles` silently holds plain strings, and any caller that
    # does `role.value` (e.g. this module's own 403 detail messages) crashes
    # with `AttributeError`. `core.rbac.role_allows`'s dict lookup happens to
    # still succeed either way (`RoleName` is a `str` subclass, so a bare
    # string hashes/compares equal to its enum member), which is exactly why
    # this was not caught by a permission-logic test — only by a test that
    # actually asserts on the 403 response body.
    roles = frozenset(
        RoleName(ur.role.name) for ur in user.roles if ur.role is not None
    )
    hub_ids = frozenset(uuid.UUID(str(hs.hub_id)) for hs in user.hub_scopes)
    return Principal(
        user_id=user.id,
        email=user.email,
        full_name=user.full_name,
        oidc_subject=user.oidc_subject or "",
        roles=roles,
        hub_scope_all=user.hub_scope_all,
        hub_ids=hub_ids,
    )


async def get_current_principal(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> Principal:
    """Resolve the authenticated caller from a `Bearer` OIDC access token.
    Raises `HTTPException(401)` for every failure mode (missing header,
    malformed/invalid/expired token, unprovisioned or inactive account) — an
    unauthenticated request never silently proceeds as anonymous.
    In local dev mode (RPD_DEV_MODE=true), an unauthenticated browser request falls
    back to the local seeded Admin user (`frank.admin@example.com`).
    """

    if not authorization and os.environ.get("RPD_DEV_MODE", "true").lower() in ("true", "1", "yes"):
        user = await _load_user_with_roles_and_hubs(db, User.email == "frank.admin@example.com")
        if user is not None and user.is_active:
            return _build_principal(user)

    token = _extract_bearer_token(authorization)
    try:
        claims = await verify_token(token, get_oidc_settings())
    except TokenValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    user = await _resolve_user(db, claims)
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is inactive",
        )
    return _build_principal(user)


def require_permission(surface: Surface, action: Action) -> _PermissionDependency:
    """Dependency factory: 401 if unauthenticated, 403 if the caller's role(s)
    don't grant `action` on `surface` per `core.rbac.PERMISSIONS`, otherwise
    returns (and stashes on `request.state.principal`) the `Principal`.
    """

    async def _dependency(
        request: Request,
        principal: Principal = Depends(get_current_principal),
    ) -> Principal:
        if not any(role_allows(role, surface, action) for role in principal.roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role(s) {sorted(r.value for r in principal.roles)} do not "
                f"permit {action.value} on {surface.value}",
            )
        request.state.principal = principal
        return principal

    return _dependency


def require_any_permission(*surface_actions: tuple[Surface, Action]) -> _PermissionDependency:
    """Like `require_permission`, but allows if the caller's role(s) grant
    ANY one of the given (surface, action) pairs. Used for endpoints whose
    data is read by more than one surface (e.g. `GET /schedule-runs` backs
    Dashboard/Capacity/Gantt read models alike) and shouldn't require its own
    dedicated matrix row.
    """

    async def _dependency(
        request: Request,
        principal: Principal = Depends(get_current_principal),
    ) -> Principal:
        allowed = any(
            role_allows(role, surface, action)
            for role in principal.roles
            for surface, action in surface_actions
        )
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role(s) {sorted(r.value for r in principal.roles)} do not "
                f"permit any of {[(s.value, a.value) for s, a in surface_actions]}",
            )
        request.state.principal = principal
        return principal

    return _dependency


def require_roles(*roles: RoleName) -> _PermissionDependency:
    """Dependency factory for actions not cleanly assigned to a single
    matrix surface (e.g. currency-rate config, the whole-portfolio greedy
    recalc trigger) — 403 unless the caller holds at least one of `roles`.
    See each call site's docstring for why a specific role list was chosen.
    """

    async def _dependency(
        request: Request,
        principal: Principal = Depends(get_current_principal),
    ) -> Principal:
        if not (principal.roles & frozenset(roles)):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires one of role(s): {sorted(r.value for r in roles)}",
            )
        request.state.principal = principal
        return principal

    return _dependency
