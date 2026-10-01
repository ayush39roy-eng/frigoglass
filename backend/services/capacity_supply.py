"""Capacity *supply* formulas — docs/DOMAIN_RULES.md "Capacity supply"
(2026-09-27, ADR 0008), evaluated on the stored `HubWorkCalendar` and
`Chamber` rows. Plain functions with no DB access; the Capacity surface
(`api/routers/capacity.py`), Workflow Settings (`api/routers/
workflow_settings.py`) and the chamber read model (`api/routers/chambers.py`)
all call these, so the figures cannot drift between surfaces (Invariant I17).
The formula functions are pure; `load_calendars_by_region` at the bottom is
the one DB read they share.

    deduction_weeks             = Σ(days / weekdays_per_week)
    working_weeks_per_engineer  = weeks_in_year − deduction_weeks
    yearly_design_capacity      = working_weeks_per_engineer × Σ fte
    remaining_fraction          = (weeks_in_year − CURRENT_WEEK) / weeks_in_year
    remaining_design_capacity   = ((weeks_in_year − CURRENT_WEEK)
                                   − deduction_weeks × remaining_fraction) × Σ fte

    working_weeks_per_chamber   = 52 − holiday_weeks − maintenance − breakdown − calibration
    efficient_lab_weeks         = working_weeks_per_chamber × efficiency × platforms
    yearly_lab_capacity         = Σ efficient_lab_weeks over the region's chambers
    remaining_lab_capacity      = yearly_lab_capacity × (52 − CURRENT_WEEK) / 52

DOMAIN_RULES writes the literal 52. The per-hub formulas use the calendar's
`weeks_in_year` (seeded 52, so the results are identical), because ADR 0008
says each hub uses its *own* remaining fraction. The chamber formulas have no
calendar of their own and use `domain_constants.WITHIN_YEAR_WEEK` (52).

**Region holiday weeks (judgement call, see docs/MEMORY.md P9-T03).**
DOMAIN_RULES defines a chamber's `holiday_weeks` as "the region's
national_holiday_days / weekdays_per_week". A lab region can contain several
hubs with their own calendars; India has four. The region value is the
*largest* `national_holiday_days / weekdays_per_week` over the region's hub
calendars. That is the conservative choice: it gives the smallest supply.
All seeded calendars in a region are identical, so today the choice has no
numeric effect. Tracked under docs/OPEN_QUESTIONS.md #16.

Rounding happens only at the API boundary (`round2`). Intermediate values
are kept at full precision.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from models.chamber import Chamber
from models.enums import LabRegion
from models.hub import Hub, HubWorkCalendar


def round2(value: float) -> float:
    # `+ 0.0` turns a rounded `-0.0` into `0.0` so JSON never shows "-0.0".
    return round(value, 2) + 0.0


@dataclass(frozen=True)
class CalendarFigures:
    deduction_weeks: float
    working_weeks_per_engineer: float
    remaining_fraction: float
    remaining_working_weeks: float


def calendar_figures(
    calendar: HubWorkCalendar | None, current_week: int = dc.CURRENT_WEEK
) -> CalendarFigures:
    """Per-hub calendar intermediates. A hub with no calendar row has zero
    deductions (the whole year is working time). That is a data gap, not a
    formula choice; every seeded hub has a calendar.
    """

    weeks_in_year = float(calendar.weeks_in_year) if calendar is not None else 52.0
    if calendar is None:
        deduction = 0.0
    else:
        weekdays = float(calendar.weekdays_per_week)
        deduction = (
            float(calendar.national_holiday_days)
            + float(calendar.medical_leave_days)
            + float(calendar.casual_leave_days)
            + float(calendar.annual_leave_days)
        ) / weekdays
    remaining_weeks = max(0.0, weeks_in_year - current_week)
    remaining_fraction = remaining_weeks / weeks_in_year
    return CalendarFigures(
        deduction_weeks=deduction,
        working_weeks_per_engineer=weeks_in_year - deduction,
        remaining_fraction=remaining_fraction,
        remaining_working_weeks=remaining_weeks - deduction * remaining_fraction,
    )


def holiday_weeks(calendar: HubWorkCalendar) -> float:
    return float(calendar.national_holiday_days) / float(calendar.weekdays_per_week)


def region_holiday_weeks(
    calendars_by_region: dict[LabRegion, list[HubWorkCalendar]], region: LabRegion
) -> float:
    """The largest holiday-week figure over the region's hub calendars (see
    module docstring). `0.0` for a region with no calendar at all.
    """

    values = [holiday_weeks(c) for c in calendars_by_region.get(region, [])]
    return max(values) if values else 0.0


@dataclass(frozen=True)
class ChamberFigures:
    working_weeks_per_chamber: float
    efficient_lab_weeks: float


def chamber_figures(chamber: Chamber, region_holidays: float) -> ChamberFigures:
    working = (
        float(dc.WITHIN_YEAR_WEEK)
        - region_holidays
        - float(chamber.maintenance_weeks)
        - float(chamber.breakdown_weeks)
        - float(chamber.calibration_weeks)
    )
    return ChamberFigures(
        working_weeks_per_chamber=working,
        efficient_lab_weeks=working * float(chamber.efficiency) * chamber.platforms,
    )


def lab_remaining_fraction(current_week: int = dc.CURRENT_WEEK) -> float:
    year = float(dc.WITHIN_YEAR_WEEK)
    return max(0.0, year - current_week) / year


def gap_and_completion(load: float, capacity: float) -> tuple[float, float | None]:
    """`gap = load − capacity`; `completion_pct = capacity / load`, `None` when
    `load == 0` (DOMAIN_RULES "Capacity supply").
    """

    completion = None if load == 0 else capacity / load
    return load - capacity, completion


def calendars_by_region(
    rows: Iterable[tuple[LabRegion, HubWorkCalendar]],
) -> dict[LabRegion, list[HubWorkCalendar]]:
    out: dict[LabRegion, list[HubWorkCalendar]] = {}
    for region, cal in rows:
        out.setdefault(region, []).append(cal)
    return out


async def load_calendars_by_region(db: AsyncSession) -> dict[LabRegion, list[HubWorkCalendar]]:
    """Every hub calendar, grouped by the hub's lab region. Not hub-scoped on
    purpose: a chamber's holiday weeks depend on its whole region, and only
    the derived number leaves this function.
    """

    rows = (
        await db.execute(
            select(Hub.lab_region, HubWorkCalendar).join(Hub, HubWorkCalendar.hub_id == Hub.id)
        )
    ).all()
    return calendars_by_region((region, cal) for region, cal in rows)
