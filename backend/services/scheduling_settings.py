"""The scheduling horizon setting N (P53-T03, ADR 0063 R53-2,
docs/API_CONTRACT_P53.md §2).

- `read_horizon_years(db)`: N, read once when a run row is created (I58) and
  when `/me` answers. No row = the default 5.
- `update_horizon_years(...)`: Admin / Super Admin (the router checks),
  optimistic `version`, one audit row `settings.scheduling_horizon_updated`.
  It dispatches nothing (Rescheduling is explicit); the UI offers Recalculate.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import CodedHTTPException
from core.principal import Principal
from models.audit import AuditLogEntry
from models.scheduling_settings import SchedulingSettings
from scheduling.weeks import DEFAULT_HORIZON_YEARS, check_horizon_years, horizon_for

AUDIT_ACTION = "settings.scheduling_horizon_updated"
VERSION_CONFLICT = "VERSION_CONFLICT"


def _audit_hub_id(principal: Principal) -> uuid.UUID | None:
    """The single hub of a one-hub caller, else none (as
    `services.whatif_baseline.principal_audit_hub_id`; not imported, to keep
    this module free of the schedule-persistence import cycle)."""

    if principal.hub_scope_all or len(principal.hub_ids) != 1:
        return None
    return next(iter(principal.hub_ids))


async def _row(db: AsyncSession, *, lock: bool = False) -> SchedulingSettings | None:
    stmt = select(SchedulingSettings).where(SchedulingSettings.id == 1)
    if lock:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def read_settings(db: AsyncSession) -> tuple[int, int, datetime | None]:
    """`(horizon_years, version, updated_at)`; no row → `(5, 0, None)`."""

    row = await _row(db)
    if row is None:
        return DEFAULT_HORIZON_YEARS, 0, None
    return row.scheduling_horizon_years, row.version, row.updated_at


async def read_horizon_years(db: AsyncSession) -> int:
    """N (1..10). A stored value outside the range cannot exist (CHECK)."""

    return (await read_settings(db))[0]


async def horizon_weeks_for(db: AsyncSession, current_week: int) -> int:
    """`H = current_week + 52 × N` with the stored N (R53-2)."""

    return horizon_for(current_week, await read_horizon_years(db))


async def update_horizon_years(
    db: AsyncSession, principal: Principal, *, horizon_years: int, version: int
) -> None:
    """Store N under the optimistic lock and write the audit row. The caller
    commits."""

    check_horizon_years(horizon_years)
    row = await _row(db, lock=True)
    stored_version = 0 if row is None else row.version
    if version != stored_version:
        raise CodedHTTPException(
            409,
            VERSION_CONFLICT,
            "Someone else changed the scheduling horizon. Reload and try again.",
        )
    before = DEFAULT_HORIZON_YEARS if row is None else row.scheduling_horizon_years
    if row is None:
        row = SchedulingSettings(
            id=1,
            version=1,
            scheduling_horizon_years=horizon_years,
            updated_by=principal.user_id,
        )
        db.add(row)
    else:
        row.version = stored_version + 1
        row.scheduling_horizon_years = horizon_years
        row.updated_by = principal.user_id
        row.updated_at = datetime.now(UTC)
    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action=AUDIT_ACTION,
            entity_type="SchedulingSettings",
            entity_id="1",
            hub_id=_audit_hub_id(principal),
            before_state={"version": stored_version, "horizon_years": before},
            after_state={"version": stored_version + 1, "horizon_years": horizon_years},
        )
    )
    await db.flush()
