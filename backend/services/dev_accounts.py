"""ADR 0058 L1: the two dev-mode test logins.

| Username     | Email                    | Role        | Hubs |
|--------------|--------------------------|-------------|------|
| `superadmin` | `superadmin@example.com` | Super Admin | all  |
| `admin`      | `admin@example.com`      | Admin       | all  |

The password of each is its username. It is checked by `POST /me/dev-login`
(`api/routers/me.py`), never stored.

**Provisioning.** `provision_dev_accounts` is idempotent:
- a missing account is created (full name, role, `hub_scope_all`, active);
- an existing account missing its role gets the role added, and an inactive
  one is reactivated;
- nothing else is changed (name, other roles, hub scope, manager, engineer
  link are left alone), and an account already in shape writes nothing.

Each create or repair writes one `user.dev_provision` audit row with a NULL
actor (system), like the other system writes (`services/run_dispatch.py`).
The work runs under one transaction-scoped advisory lock, so several API
workers starting together do not race on the unique email.

It runs on API startup only when `core.config.is_dev_mode()` is true
(`provision_dev_accounts_at_startup`, called from `api/main.py`'s lifespan),
and by hand:

    RPD_DEV_MODE=true RPD_DATABASE_URL=... python -m scripts.provision_dev_accounts

Outside dev mode nothing runs. This is not security: in dev mode any seeded
user can still be impersonated with `X-Dev-User-Email` (ADR 0010 §4,
OQ #107). OIDC SSO replaces all of it before go-live.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.config import is_dev_mode
from models.audit import AuditLogEntry
from models.enums import RoleName
from models.user import Role, User, UserRole

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DevLoginAccount:
    username: str
    email: str
    full_name: str
    role: RoleName


#: ADR 0058 L1, in the order the login screen lists them.
DEV_LOGIN_ACCOUNTS: tuple[DevLoginAccount, ...] = (
    DevLoginAccount("superadmin", "superadmin@example.com", "Super Admin", RoleName.SUPER_ADMIN),
    DevLoginAccount("admin", "admin@example.com", "Admin", RoleName.ADMIN),
)

DEV_LOGIN_EMAILS: tuple[str, ...] = tuple(a.email for a in DEV_LOGIN_ACCOUNTS)

#: Key for `pg_advisory_xact_lock` serialising provisioning across workers.
#: Any fixed bigint works; this one spells "RPDDEV" in ASCII hex.
DEV_ACCOUNTS_LOCK = 0x525044444556

AUDIT_ACTION = "user.dev_provision"

Outcome = Literal["created", "repaired", "unchanged"]


def account_for_login(identifier: str) -> DevLoginAccount | None:
    """The account a login identifier names: the username or the full email,
    case-insensitive, surrounding spaces ignored. Anything else is None."""

    key = identifier.strip().lower()
    for account in DEV_LOGIN_ACCOUNTS:
        if key in (account.username, account.email):
            return account
    return None


def _state(
    email: str, full_name: str, is_active: bool, roles: list[str], hub_scope_all: bool
) -> dict[str, Any]:
    return {
        "email": email,
        "full_name": full_name,
        "is_active": is_active,
        "roles": sorted(roles),
        "hub_scope_all": hub_scope_all,
    }


async def _role(db: AsyncSession, name: RoleName) -> Role:
    role = (await db.execute(select(Role).where(Role.name == name.value))).scalar_one_or_none()
    if role is None:
        # `GET /roles` falls back to its built-in description for a NULL one.
        role = Role(name=name.value, description=None)
        db.add(role)
        await db.flush()
    return role


async def _provision_one(db: AsyncSession, account: DevLoginAccount) -> Outcome:
    user = (
        await db.execute(
            select(User)
            .options(selectinload(User.roles).selectinload(UserRole.role))
            .where(func.lower(User.email) == account.email)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    role = await _role(db, account.role)

    if user is None:
        user = User(
            email=account.email,
            full_name=account.full_name,
            is_active=True,
            hub_scope_all=True,
        )
        db.add(user)
        await db.flush()
        db.add(UserRole(user_id=user.id, role_id=role.id))
        before = None
        after = _state(account.email, account.full_name, True, [account.role.value], True)
        outcome: Outcome = "created"
    else:
        held = [str(ur.role.name) for ur in user.roles if ur.role is not None]
        before = _state(user.email, user.full_name, user.is_active, held, user.hub_scope_all)
        missing_role = account.role.value not in held
        if user.is_active and not missing_role:
            return "unchanged"
        if not user.is_active:
            user.is_active = True
        if missing_role:
            db.add(UserRole(user_id=user.id, role_id=role.id))
            held = [*held, account.role.value]
        after = _state(user.email, user.full_name, True, held, user.hub_scope_all)
        outcome = "repaired"

    await db.flush()
    db.add(
        AuditLogEntry(
            actor_user_id=None,
            action=AUDIT_ACTION,
            entity_type="User",
            entity_id=str(user.id),
            hub_id=None,
            before_state=before,
            after_state=after,
        )
    )
    return outcome


async def provision_dev_accounts(db: AsyncSession) -> dict[str, Outcome]:
    """Create or repair the two accounts; returns `{username: outcome}`.
    Flushes, never commits: the caller owns the transaction."""

    await db.execute(select(func.pg_advisory_xact_lock(DEV_ACCOUNTS_LOCK)))
    out: dict[str, Outcome] = {}
    for account in DEV_LOGIN_ACCOUNTS:
        out[account.username] = await _provision_one(db, account)
    await db.flush()
    return out


async def provision_dev_accounts_at_startup() -> None:
    """API startup hook: dev mode only. A failure (no database yet, a
    migration not applied) is logged by exception type and does not stop the
    API; the next start, or the script, retries."""

    if not is_dev_mode():
        return
    from api.db import get_session_factory

    try:
        async with get_session_factory()() as session:
            outcomes = await provision_dev_accounts(session)
            await session.commit()
    except Exception as exc:  # noqa: BLE001 - startup must not fail on this
        logger.warning("dev login provisioning skipped: %s", type(exc).__name__)
        return
    logger.info("dev login accounts provisioned: %s", outcomes)
