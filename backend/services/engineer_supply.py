"""Engineer active weeks on the Capacity side (P38, ADR 0053 §4, ruling R38-1).

One rule for supply: `A_e(Y, a..b)`, the weeks of `a..b` in plan year Y not
covered by any of the engineer's `engineer_inactive_periods` rows. The
whole-week rule itself lives in `scheduling.covered_plan_weeks` (P38-T03),
so the Capacity side and the What-if / plan-import side read one copy.

    yearly_design_capacity    = wwpe × Σ fte_e × A_e(Y, 1..52) / 52
    remaining_design_capacity = rem_ww × Σ fte_e × A_e(Y, CW+1..52) / (52 − CW)   (0 at CW = 52)

FTE is summed as `Decimal` and the week factor as an exact `Fraction`. When no
engineer of the set has a period, the figure is computed through
`capacity_supply.fte_sum` / `design_capacity` exactly as before P38, so it is
the same float (I43, R38-9).

P38-T04 uses this for the deactivation preview's `supply_effect`; P38-T05
moves every Capacity reader onto it.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.engineer import EngineerInactivePeriod
from models.hub import HubWorkCalendar
from scheduling import InactivePeriod, active_week_count, covered_plan_weeks
from services.capacity_supply import calendar_figures, design_capacity, fte_sum

WEEKS = 52


@dataclass(frozen=True)
class SupplyMember:
    """One engineer's contribution: stored FTE and the plan-horizon weeks its
    periods cover (`None` = no period at all, the pre-P38 path)."""

    fte: Decimal | float
    covered_weeks: tuple[int, ...] | None = None


async def load_inactive_periods(
    db: AsyncSession, engineer_ids: Collection[uuid.UUID] | None = None
) -> dict[uuid.UUID, list[InactivePeriod]]:
    """Every stored period, as `scheduling.InactivePeriod`, by engineer."""

    stmt = select(EngineerInactivePeriod)
    if engineer_ids is not None:
        if not engineer_ids:
            return {}
        stmt = stmt.where(EngineerInactivePeriod.engineer_id.in_(list(engineer_ids)))
    out: dict[uuid.UUID, list[InactivePeriod]] = defaultdict(list)
    for row in (await db.execute(stmt.order_by(EngineerInactivePeriod.created_at))).scalars():
        out[row.engineer_id].append(
            InactivePeriod(
                from_plan_year=row.from_plan_year,
                from_week=row.from_week,
                to_plan_year=row.to_plan_year,
                to_week=row.to_week,
            )
        )
    return dict(out)


def covered_weeks_for(
    periods: Sequence[InactivePeriod] | None, plan_year: int
) -> tuple[int, ...] | None:
    """`None` when the engineer has no period (the pre-P38 path)."""

    if not periods:
        return None
    return covered_plan_weeks(periods, plan_year)


def _dec(value: Decimal | float) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def hub_design_supply(
    calendar: HubWorkCalendar | None,
    members: Sequence[SupplyMember],
    current_week: int,
) -> tuple[float, float]:
    """R38-1 `(yearly, remaining)` design capacity of a set of engineers on one
    hub calendar, full precision (callers round at the boundary)."""

    if all(m.covered_weeks is None for m in members):
        return design_capacity(calendar, fte_sum(m.fte for m in members), current_week)
    cal = calendar_figures(calendar, current_week)
    fte_year = Fraction(0)
    fte_remaining = Fraction(0)
    for m in members:
        fte = Fraction(_dec(m.fte))
        if m.covered_weeks is None:
            fte_year += fte
            fte_remaining += fte
            continue
        fte_year += fte * Fraction(active_week_count(m.covered_weeks, 1, WEEKS), WEEKS)
        if current_week < WEEKS:
            fte_remaining += fte * Fraction(
                active_week_count(m.covered_weeks, current_week + 1, WEEKS),
                WEEKS - current_week,
            )
    return (
        cal.working_weeks_per_engineer * float(fte_year),
        cal.remaining_working_weeks * float(fte_remaining),
    )


__all__ = [
    "SupplyMember",
    "covered_weeks_for",
    "hub_design_supply",
    "load_inactive_periods",
]
