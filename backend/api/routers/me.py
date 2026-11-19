"""Session endpoints (docs/API_CONTRACT_P9.md §1, ADR 0010 §2/§4).

- `GET /me`: any authenticated principal. It returns who the caller is and
  the resolved `permissions[surface] = {read, write}` table. The frontend
  gates navigation and write controls on it, but the server stays the
  enforcement point. Every other endpoint still checks `core.rbac` itself.
- `GET /me/dev-users`: dev mode only (`RPD_DEV_MODE=true`), 404 otherwise.
  It lists the accounts the dev-only role switcher can pick for
  `X-Dev-User-Email`. It is a 404 rather than a 403 outside dev mode, so a
  production deployment does not even reveal that the switcher exists.
  ADR 0058 L1: it lists only the two test logins
  (`services.dev_accounts.DEV_LOGIN_ACCOUNTS`), when active.
- `POST /me/dev-login`: dev mode only, 404 otherwise (ADR 0058 L1). Checks
  `{username, password}` on the server (password = username, constant-time)
  and answers the `DevUser`, or one generic 401. Rate-limited per client
  address (`_dev_login_client_key`).
  The password is never logged, stored or echoed.
"""

from __future__ import annotations

import hmac
import math

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import get_current_principal
from api.errors import CodedHTTPException
from core.config import is_dev_mode
from core.principal import Principal
from core.rbac import Action, Surface, role_allows
from models.engineer import Engineer
from models.enums import RoleName
from models.user import User, UserRole
from scheduling.weeks import WEEK_BASE_YEAR, horizon_for
from schemas.session import (
    DevLoginRequest,
    DevUser,
    MeResponse,
    PlanWeek,
    SurfacePermission,
    SurfacePermissions,
)
from services.dev_accounts import DEV_LOGIN_EMAILS, account_for_login
from services.plan_clock import PlanClock, get_plan_clock
from services.plan_week import plan_week_state
from services.project_access import has_any_manageable_project
from services.rate_limit import TokenBucketLimiter
from services.scheduling_settings import read_horizon_years

router = APIRouter(prefix="/me", tags=["session"])

#: ADR 0058 L1 / P46-R01 (security L-1): per client address, a burst of 10
#: login attempts, then one every 3 seconds. Per API process
#: (`services.rate_limit`). At most `_DEV_LOGIN_MAX_KEYS` buckets are kept
#: (least recently used evicted), because the key comes from a header.
DEV_LOGIN_RATE_LIMIT = TokenBucketLimiter(
    capacity=10, refill_per_second=1 / 3, max_keys=10_000
)

#: Longest `X-Forwarded-For` entry used as a key (an IPv6 address is at most
#: 45 chars); a longer one falls back to the peer address.
_MAX_FORWARDED_LEN = 64


def _dev_login_client_key(request: Request) -> str:
    """The rate-limit key for `POST /me/dev-login`: the left-most
    `X-Forwarded-For` entry when present, else the peer address.

    DEV MODE ONLY, and only for this limiter. On the hosted demo the API sits
    behind Render's proxy and uvicorn does not trust `X-Forwarded-For`, so the
    peer address is the proxy's and every caller would share one bucket; one
    client could then block everyone's sign-in. The left-most entry is what
    the client claims, so a caller can spoof it, but that only lets them dodge
    their own limit on a test login whose password equals its username. It is
    never used for authorisation, logging or anything outside dev mode.
    """

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",", 1)[0].strip()
        if first and len(first) <= _MAX_FORWARDED_LEN:
            return f"xff:{first}"
    return f"peer:{request.client.host if request.client else 'unknown'}"


#: Longest identifier / password even looked at; anything longer is the 401.
_DEV_LOGIN_MAX_LEN = 320

_DEV_LOGIN_FAILED = "Invalid username or password."


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
    clock: PlanClock = Depends(get_plan_clock),
) -> MeResponse:
    engineer_id = (
        await db.execute(select(Engineer.id).where(Engineer.user_id == principal.user_id))
    ).scalar_one_or_none()
    horizon_years = await read_horizon_years(db)
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
        current_week=clock.week,
        weeks_left_in_year=clock.weeks_left_in_year,
        as_of_date=clock.as_of_date,
        plan_year=clock.plan_year,
        week_base_year=WEEK_BASE_YEAR,
        plan_year_start_week=clock.plan_year_start_week,
        plan_year_end_week=clock.plan_year_end_week,
        horizon_years=horizon_years,
        horizon_weeks=horizon_for(clock.week, horizon_years),
        plan_year_closed=False,
        week_source=clock.source,
        week_ends_at=clock.week_ends_at,
        plan_week=(
            PlanWeek(run_week=state[0], run_version=state[1], status=state[2])
            if (state := await plan_week_state(db, clock)) is not None
            else None
        ),
    )


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")


def _dev_user(user: User) -> DevUser:
    return DevUser(
        email=user.email,
        full_name=user.full_name,
        roles=sorted(
            (RoleName(ur.role.name) for ur in user.roles if ur.role is not None),
            key=_role_sort_key,
        ),
    )


async def _active_dev_login_users(db: AsyncSession) -> dict[str, User]:
    """The active test-login accounts that hold a role, by lower-cased email."""

    users = (
        (
            await db.execute(
                select(User)
                .options(selectinload(User.roles).selectinload(UserRole.role))
                .where(
                    func.lower(User.email).in_(DEV_LOGIN_EMAILS),
                    User.is_active.is_(True),
                )
            )
        )
        .scalars()
        .all()
    )
    return {u.email.lower(): u for u in users if u.roles}


@router.get("/dev-users", response_model=list[DevUser])
async def list_dev_users(
    db: AsyncSession = Depends(get_db),
) -> list[DevUser]:
    # Deliberately no `get_current_principal` dependency: this is the one
    # endpoint the login page calls BEFORE any session exists, to decide
    # whether to show the dev picker or the SSO button (module docstring).
    # Requiring a principal here would 401 on a request with no Authorization
    # header before this line ever ran — which is exactly the frontend's
    # actual unauthenticated call — masking the intended "404 outside dev
    # mode" behaviour.
    if not is_dev_mode():
        raise _not_found()

    # ADR 0058 L1: only the two test logins, in their fixed order. Every other
    # seeded user stays in the database but is not offered here.
    found = await _active_dev_login_users(db)
    return [_dev_user(found[email]) for email in DEV_LOGIN_EMAILS if email in found]


async def _dev_mode_only() -> None:
    """Runs before body validation, so outside dev mode every request to the
    route is the same 404, whatever its body."""

    if not is_dev_mode():
        raise _not_found()


@router.post(
    "/dev-login",
    response_model=DevUser,
    dependencies=[Depends(_dev_mode_only)],
    responses={
        401: {"description": "Any failure: one generic message."},
        404: {"description": "Not in dev mode."},
        429: {"description": "RATE_LIMITED, with Retry-After."},
    },
)
async def dev_login(
    body: DevLoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> DevUser:
    """ADR 0058 L1. `username` is `superadmin` / `admin` or the full email
    (case-insensitive); `password` must equal the account's username,
    compared in constant time. Answers the account's `DevUser`; the client
    then sends that `email` as `X-Dev-User-Email`. Any failure (unknown
    user, wrong password, account missing, inactive or without a role) is
    the same 401. The password is never logged or echoed."""

    allowed, retry_after = DEV_LOGIN_RATE_LIMIT.allow(_dev_login_client_key(request))
    if not allowed:
        raise CodedHTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many sign-in attempts. Please wait a moment and try again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )

    failed = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_DEV_LOGIN_FAILED)
    if len(body.username) > _DEV_LOGIN_MAX_LEN or len(body.password) > _DEV_LOGIN_MAX_LEN:
        raise failed
    account = account_for_login(body.username)
    # Compared even for an unknown username, so both paths do the same work.
    expected = account.username if account is not None else "\x00" * 16
    password_ok = hmac.compare_digest(body.password.encode(), expected.encode())
    if account is None or not password_ok:
        raise failed
    user = (await _active_dev_login_users(db)).get(account.email)
    if user is None:
        raise failed
    return _dev_user(user)
