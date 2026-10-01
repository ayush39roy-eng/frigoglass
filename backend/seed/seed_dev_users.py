"""P3-T02 — seed local `User`/`Role`/`UserRole` rows matching the dev
Keycloak realm's test users (`dev/keycloak/rpd-realm.json`, six users, one
per RBAC role — see that file's own comments) plus, since P9-T01, the
Super Admin (`sam.super@example.com`, ADR 0010), so P3-T02's OIDC integration
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
installed) — run `seed_demo_data.py` FIRST so the P9-F04 Engineer/Hub
lookups below have real rows to find (best-effort otherwise, see
`_CAROL_ENGINEER_NAME`/`_BOB_HUB_NAME`):

    RPD_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/rpd \\
        python -m seed.seed_demo_data
    RPD_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/rpd \\
        python -m seed.seed_dev_users [--reset]

P9-F04: `carol.eng` is linked to a real `Engineer` row (own-assignments view)
and `bob.hub` gets a real, non-"all" hub scope (hub-scoped row filtering) —
previously every dev user, Hub Planner included, saw every hub, so
`services.hub_scope`'s row-level filtering had no Hub Planner to exercise
against real data in dev.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from models import Engineer, Hub, Role, User, UserHubScope, UserRole  # noqa: E402
from models.enums import HubName, RoleName  # noqa: E402

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
    # 2026-09-27 (ADR 0010, P9-T01): the all-rights Super Admin. Not in the
    # Keycloak dev realm yet (that file is not this task's to edit); in dev
    # mode it is selectable via `X-Dev-User-Email` (P9-T03).
    ("sam.super@example.com", "Sam SuperAdmin", RoleName.SUPER_ADMIN),
)

#: P9-F04: link `carol.eng` to a real `Engineer` row (the first engineer in
#: `seed_demo_data.py`'s dataset, `prototype_seed_data.json`'s "engineers"
#: list, R&D-Greece) so the Engineer role's "own assignments" view has real
#: data to exercise in dev. Looked up by name at seed time, not hardcoded by
#: id — best-effort: if `seed_demo_data` has not been run yet (e.g. this
#: script's own isolated test), the row simply is not found and carol is
#: seeded exactly as before (no Engineer link), never a hard failure.
_CAROL_ENGINEER_NAME = "Dimopoulou"

#: P9-F04: `bob.hub` gets a real, non-"all" hub scope (Hub Planner is the
#: only role that carries the "(own hub)" qualifier per
#: `docs/PROJECT_AND_STACK.md` §5) so hub-scoped row filtering
#: (`services.hub_scope`) has a real Hub Planner to exercise in dev, instead
#: of every dev user seeing every hub. Same best-effort lookup-by-name as
#: `_CAROL_ENGINEER_NAME`: if the hub row is not found, bob falls back to
#: `hub_scope_all=True` (the previous behaviour) rather than being left
#: scoped to zero hubs, which `models.user.User.hub_scope_all`'s own
#: docstring calls out as a misconfiguration that must never happen.
_BOB_HUB_NAME = HubName.PD_INDIA


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
                # for its tables. P9-F04: this now also has to (a) null out
                # any `Engineer.user_id` this script previously set (a plain
                # FK with no ON DELETE action — deleting a still-referenced
                # User would otherwise raise), and (b) clear any
                # `UserHubScope` rows this script previously added for
                # `bob.hub`, both BEFORE deleting `User` rows, for the same
                # FK reason.
                await session.execute(
                    update(Engineer).where(Engineer.user_id.is_not(None)).values(user_id=None)
                )
                await session.execute(delete(UserHubScope))
                await session.execute(delete(UserRole))
                await session.execute(delete(User))
                await session.flush()
            else:
                await _guard_against_duplicate_seed(session)

            # P9-F04: best-effort lookups — `None` when `seed_demo_data` has
            # not been run yet (e.g. this module's own isolated
            # `test_seed_dev_users_duplicate_guard_and_reset`), in which case
            # the two dev users below fall back to their pre-P9-F04
            # behaviour (no Engineer link; `hub_scope_all=True`).
            carol_engineer = (
                await session.execute(
                    select(Engineer).where(Engineer.name == _CAROL_ENGINEER_NAME)
                )
            ).scalar_one_or_none()
            bob_hub = (
                await session.execute(select(Hub).where(Hub.name == _BOB_HUB_NAME))
            ).scalar_one_or_none()

            # P10-T01 (ADR 0012): `bob.hub` (a Hub Planner, created before
            # `carol.eng` in `DEV_USERS`' order) becomes `carol.eng`'s
            # manager, so `services.project_access.can_manage_grant`'s
            # delegation rule (I18) has a real manager -> direct-report link
            # to exercise in dev/tests — bob's own effective access on a
            # PD-India project is Admin (rule 3 of the resolver), so bob can
            # grant/revoke carol's project access on that hub's projects.
            bob_user_id: uuid.UUID | None = None

            for email, full_name, role_name in DEV_USERS:
                role = await _get_or_create_role(session, role_name)
                bob_scoped = email == "bob.hub@example.com" and bob_hub is not None
                # P10-F01 (security remediation, High): `carol.eng` (the only
                # Engineer in this seed) must never get `hub_scope_all=True`
                # — that combination is exactly the live-exploited bypass the
                # P10 gate security-auditor found (an Engineer-role account
                # with `hub_scope_all=True` silently skips own-assignment row
                # scoping and reads every project). Prior to this fix, the
                # blanket `hub_scope_all=not bob_scoped` below gave every
                # non-bob dev user (including carol) `hub_scope_all=True` by
                # default — the real, unguarded misconfiguration the auditor
                # flagged, not a contrived edge case. `schemas/user_admin.py`
                # now also rejects this combination at the API layer (belt
                # and suspenders), but the seed itself must set the correct
                # value directly too.
                engineer_only = role_name == RoleName.ENGINEER
                user = User(
                    email=email,
                    full_name=full_name,
                    is_active=True,
                    hub_scope_all=not bob_scoped and not engineer_only,
                    oidc_subject=None,  # JIT-linked on first login, by design
                    manager_id=bob_user_id if email == "carol.eng@example.com" else None,
                )
                session.add(user)
                await session.flush()
                session.add(UserRole(user_id=user.id, role_id=role.id))
                # `bob_scoped` already implies `bob_hub is not None`, but the
                # explicit re-check (rather than trusting that boolean alone)
                # is what lets mypy narrow `bob_hub` to `Hub` here too.
                if bob_scoped and bob_hub is not None:
                    session.add(UserHubScope(user_id=user.id, hub_id=bob_hub.id))
                if email == "carol.eng@example.com" and carol_engineer is not None:
                    carol_engineer.user_id = user.id
                    session.add(carol_engineer)
                if email == "bob.hub@example.com":
                    bob_user_id = user.id

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
