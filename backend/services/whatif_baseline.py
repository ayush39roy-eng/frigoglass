"""Build the What-if engine's `WhatIfBaseline` from the database (P18-T02).

The baseline is the WHOLE plan, never the caller's slice: lab capacity is
shared by a lab region, so a Hub Planner's answer is only right if the other
hubs' projects and the region's chambers are in the simulation. Hub scoping is
applied to what is RETURNED (`services.whatif`), never to what is simulated.

The baseline carries real engineer names (the scheduler input has them). It is
an in-process object only: it is never serialised, logged, cached across
requests or handed to the chat model.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from core.principal import Principal
from models.chamber import Chamber
from models.hub import Hub, HubWorkCalendar
from scheduling.whatif import ChamberSupplyInput, HubCalendarInput, WhatIfBaseline
from services.schedule_persistence import build_schedule_input_from_db


@dataclass(frozen=True)
class Scope:
    """Which hubs and lab regions the caller may see figures for.

    `hubs` / `lab_regions` are names. For an unrestricted caller they hold all
    six hubs / three regions, so membership tests need no special case; the
    `all_hubs` flag only says whether any filtering happens at all.
    """

    all_hubs: bool
    hubs: frozenset[str]
    lab_regions: frozenset[str]

    def hub_ok(self, hub: str) -> bool:
        return hub in self.hubs

    def region_ok(self, region: str) -> bool:
        return region in self.lab_regions


@dataclass(frozen=True)
class WhatIfContext:
    baseline: WhatIfBaseline
    scope: Scope
    #: engineer id -> hub name, project id -> hub name, chamber id -> lab
    #: region: lets the scope check treat an out-of-scope id exactly like an
    #: unknown one (no existence leak).
    engineer_hub: dict[str, str]
    project_hub: dict[str, str]
    chamber_region: dict[str, str]
    #: The caller's user id (text). Keys the per-user in-flight limit
    #: (`services.whatif.run_capped`, S18-M1). Empty = no limit (internal use).
    user_key: str = ""


async def resolve_scope(db: AsyncSession, principal: Principal) -> Scope:
    """The caller's hubs and lab regions (the Capacity surface's rule: a Hub
    Planner sees every chamber of the region of their hub). A restricted
    caller with no hubs gets an empty scope (default closed)."""

    all_hubs = frozenset(dc.HUB_LAB_REGION)
    all_regions = frozenset(dc.HUB_LAB_REGION.values())
    if principal.hub_scope_all:
        return Scope(True, all_hubs, all_regions)
    if not principal.hub_ids:
        return Scope(False, frozenset(), frozenset())
    rows = (
        await db.execute(
            select(Hub.name, Hub.lab_region).where(Hub.id.in_(list(principal.hub_ids)))
        )
    ).all()
    return Scope(
        False,
        frozenset(name.value for name, _ in rows),
        frozenset(region.value for _, region in rows),
    )


async def load_context(db: AsyncSession, principal: Principal) -> WhatIfContext:
    schedule = await build_schedule_input_from_db(db)
    calendars = tuple(
        HubCalendarInput(
            hub=hub_name.value,
            weekdays_per_week=cal.weekdays_per_week,
            national_holiday_days=float(cal.national_holiday_days),
            medical_leave_days=float(cal.medical_leave_days),
            casual_leave_days=float(cal.casual_leave_days),
            annual_leave_days=float(cal.annual_leave_days),
            weeks_in_year=cal.weeks_in_year,
        )
        for hub_name, cal in (
            await db.execute(
                select(Hub.name, HubWorkCalendar)
                .join(Hub, HubWorkCalendar.hub_id == Hub.id)
                .order_by(Hub.name)
            )
        ).all()
    )
    chamber_rows = (await db.execute(select(Chamber).order_by(Chamber.code))).scalars().all()
    supply = tuple(
        ChamberSupplyInput(
            chamber_id=str(c.id),
            lab_region=c.lab_region.value,
            platforms=c.platforms,
            efficiency=float(c.efficiency),
            maintenance_weeks=float(c.maintenance_weeks),
            breakdown_weeks=float(c.breakdown_weeks),
            calibration_weeks=float(c.calibration_weeks),
        )
        for c in chamber_rows
    )
    scope = await resolve_scope(db, principal)
    return WhatIfContext(
        baseline=WhatIfBaseline(schedule=schedule, calendars=calendars, chamber_supply=supply),
        scope=scope,
        engineer_hub={e.engineer_id: e.hub for e in schedule.engineers},
        project_hub={p.project_id: p.hub for p in schedule.projects},
        chamber_region={str(c.id): c.lab_region.value for c in chamber_rows},
        user_key=str(principal.user_id),
    )


def principal_audit_hub_id(principal: Principal) -> uuid.UUID | None:
    """The hub id to put on an audit row: the single hub of a one-hub planner,
    else none."""

    if principal.hub_scope_all or len(principal.hub_ids) != 1:
        return None
    return next(iter(principal.hub_ids))
