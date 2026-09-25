"""P3-T02 — seed local `User`/`Role`/`UserRole` rows matching the dev
Keycloak realm's test users (`dev/keycloak/rpd-realm.json`, six users, one
per RBAC role — see that file's own comments), so P3-T02's OIDC integration
is live-testable end-to-end: a real Keycloak-issued token's `email` claim
resolves to a real, role-provisioned local account via
`api.deps._resolve_user`'s email-lookup/JIT-link path.

Deliberately does NOT create a local row for `nobody.unprovisioned@example.com`
(present in the Keycloak realm) — that email is used by this task's live
smoke test to confirm the "no auto-provisioning" 401 path against a real,
validly-signed token for an identity with no local account at all.

Standalone script, same pattern as `seed_currency_rates.py`/`seed_demo_data.py`
(argparse CLI, own duplicate-seed guard, not imported by the API process at
request time).

Usage (from `backend/`, with a `.venv` that has this project's deps
installed):

    RPD_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/rpd \\
        python -m seed.seed_dev_users [--reset]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from models import Role, User, UserRole  # noqa: E402
from models.enums import RoleName  # noqa: E402

#: (email, full_name, role) — matches dev/keycloak/rpd-realm.json's test
#: users exactly (excluding nobody.unprovisioned@example.com — see module
#: docstring).
DEV_USERS: tuple[tuple[str, str, RoleName], ...] = (
    ("alice.pm@example.com", "Alice PortfolioManager", RoleName.PORTFOLIO_MANAGER),
    ("bob.hub@example.com", "Bob HubPlanner", RoleName.HUB_PLANNER),
    ("carol.eng@example.com", "Carol Engineer", RoleName.ENGINEER),
    ("dave.exec@example.com", "Dave ExecutiveViewer", RoleName.EXECUTIVE_VIEWER),
    ("erin.audit@example.com", "Erin Auditor", RoleName.AUDITOR),
    ("frank.admin@example.com", "Frank Admin", RoleName.ADMIN),
)


def _database_url() -> str:
    url = os.environ.get("RPD_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "RPD_DATABASE_URL is not set (async postgresql+asyncpg:// DSN). "
            "See backend/alembic/env.py / backend/seed/seed_demo_data.py for the same convention."
        )
    return url


async def _row_count(session: AsyncSession) -> int:
    return await session.scalar(select(func.count()).select_from(User)) or 0


async def _guard_against_duplicate_seed(session: AsyncSession) -> None:
    count = await _row_count(session)
    if count:
        raise RuntimeError(
            f"users already has {count} row(s) — re-run with --reset to truncate "
            "first, or this script would create duplicates."
        )


async def _get_or_create_role(session: AsyncSession, name: RoleName) -> Role:
    existing = (await session.execute(select(Role).where(Role.name == name))).scalar_one_or_none()
    if existing is not None:
        return existing
    role = Role(name=name)
    session.add(role)
    await session.flush()
    return role


async def run(reset_first: bool) -> dict:
    engine = create_async_engine(_database_url())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as session:
            if reset_first:
                # `user_roles`/`user_hub_scopes` cascade via FK on delete? No
                # ON DELETE CASCADE is defined (P1-T02, by design — see
                # models/engineer.py's docstring for the general "never
                # silently orphan history" convention) so child rows for
                # dev-seeded users must be removed first, in dependency
                # order, exactly like seed_demo_data.py's own --reset does
                # for its tables.
                await session.execute(delete(UserRole))
                await session.execute(delete(User))
                await session.flush()
            else:
                await _guard_against_duplicate_seed(session)

            for email, full_name, role_name in DEV_USERS:
                role = await _get_or_create_role(session, role_name)
                user = User(
                    email=email,
                    full_name=full_name,
                    is_active=True,
                    hub_scope_all=True,
                    oidc_subject=None,  # JIT-linked on first login, by design
                )
                session.add(user)
                await session.flush()
                session.add(UserRole(user_id=user.id, role_id=role.id))

            await session.commit()
            verified = await _row_count(session)
    finally:
        await engine.dispose()
    return {"users": len(DEV_USERS), "_verified_from_db": {"users": verified}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Delete existing users/user_roles rows before reseeding.",
    )
    args = parser.parse_args()
    counts = asyncio.run(run(reset_first=args.reset))
    print(json.dumps(counts, indent=2, default=str))


if __name__ == "__main__":
    main()
