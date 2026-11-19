"""Scheduling horizon setting (P53-T03, ADR 0063 R53-2,
docs/API_CONTRACT_P53.md §2).

- `GET /scheduling-settings`: any authenticated role (`/me` serves N too).
- `PUT /scheduling-settings`: Admin or Super Admin; optimistic `version`;
  audited; dispatches no run (Rescheduling is explicit).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import get_current_principal, require_roles
from api.errors import CodedHTTPException
from core.principal import Principal
from models.enums import RoleName
from scheduling.weeks import horizon_for
from schemas.scheduling_settings import SchedulingSettingsIn, SchedulingSettingsOut
from services.plan_clock import PlanClock, get_plan_clock
from services.rate_limit import TokenBucketLimiter
from services.scheduling_settings import read_settings, update_horizon_years

router = APIRouter(prefix="/scheduling-settings", tags=["scheduling-settings"])

_admin = require_roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)

#: Per user: a settings edit is rare.
SETTINGS_RATE_LIMIT = TokenBucketLimiter(capacity=10, refill_per_second=1 / 6)


async def _out(db: AsyncSession, clock: PlanClock) -> SchedulingSettingsOut:
    n, version, updated_at = await read_settings(db)
    return SchedulingSettingsOut(
        horizon_years=n,
        version=version,
        updated_at=updated_at,
        current_week=clock.week,
        horizon_weeks_next_run=horizon_for(clock.week, n),
    )


@router.get("", response_model=SchedulingSettingsOut)
async def get_scheduling_settings(
    db: AsyncSession = Depends(get_db),
    _principal: Principal = Depends(get_current_principal),
    clock: PlanClock = Depends(get_plan_clock),
) -> SchedulingSettingsOut:
    return await _out(db, clock)


@router.put(
    "",
    response_model=SchedulingSettingsOut,
    responses={409: {"description": "VERSION_CONFLICT"}, 429: {"description": "RATE_LIMITED"}},
)
async def put_scheduling_settings(
    body: SchedulingSettingsIn,
    db: AsyncSession = Depends(get_db),
    principal: Principal = Depends(_admin),
    clock: PlanClock = Depends(get_plan_clock),
) -> SchedulingSettingsOut:
    allowed, _retry = SETTINGS_RATE_LIMIT.allow(str(principal.user_id))
    if not allowed:
        raise CodedHTTPException(429, "RATE_LIMITED", "Too many changes. Try again shortly.")
    await update_horizon_years(
        db, principal, horizon_years=body.horizon_years, version=body.version
    )
    await db.commit()
    return await _out(db, clock)
