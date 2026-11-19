"""Engineer active weeks for supply (P38-T03, ADR 0053 §4, ruling R38-1 / R38-2).

Pure helpers and plain data. Nothing here reaches the scheduler: greedy, CP-SAT
and the validator never read it, and it is not part of `ScheduleInput` (the
canonical input and its hash are unchanged). It feeds the What-if and plan-import
*supply* only, through `WhatIfBaseline.engineer_active_weeks`.

Week convention (DOMAIN_RULES "Engineer deactivation", whole-week rule):

- A period opened by a deactivation in week `d` and closed by a reactivation in
  week `r` covers weeks `d + 1 .. r` of its plan year (the deactivation week
  counts as worked; deactivating and reactivating in the same week covers
  nothing).
- An open period runs to week 52 and covers every week of every later plan year.
  A period that began in an earlier plan year starts at week 1.

Covered weeks are **absolute weeks** on the one week line (R53-1, ADR 0063;
`scheduling.weeks`): week 1 is 2026 W1, 53 is 2027 W1. `covered_plan_weeks`
covers `year_start(Y) .. last_week` for the served plan year Y (default
`last_week = year_end(Y + 1)`; a caller passes the run's `horizon_weeks` to
cover the whole search, R53-1 "1..horizon_weeks of the run instead of
1..104"). For Y = 2026 and the default this is exactly the pre-P53 1..104.
The year-relative period rows are converted only by `year_start(y) - 1 + w`.

`A_e(Y, a..b)` (R38-1) is `active_week_count(covered, a, b)`: the number of
weeks in `a..b` not covered.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from scheduling.weeks import (
    MAX_ABSOLUTE_WEEK,
    PLAN_YEAR_WEEKS,
    year_end,
    year_relative_to_abs,
    year_start,
)

WEEKS_PER_PLAN_YEAR = PLAN_YEAR_WEEKS
#: R53-1: the largest absolute week an `EngineerActiveWeeks` may cover (the
#: 100-year sanity bound, not a calendar cap).
MAX_COVERED_WEEK = MAX_ABSOLUTE_WEEK


@dataclass(frozen=True)
class InactivePeriod:
    """One `engineer_inactive_periods` row as plain data.

    `from_week` is the deactivation week `d` (1..52) in `from_plan_year`;
    `to_week` the reactivation week `r` in `to_plan_year`, both `None` while
    the period is open.
    """

    from_plan_year: int
    from_week: int
    to_plan_year: int | None = None
    to_week: int | None = None

    def __post_init__(self) -> None:
        _check_week(self.from_week, "from_week")
        if (self.to_plan_year is None) != (self.to_week is None):
            raise ValueError("to_plan_year and to_week are both set or both None")
        if self.to_week is not None:
            _check_week(self.to_week, "to_week")
            assert self.to_plan_year is not None
            if (self.to_plan_year, self.to_week) < (self.from_plan_year, self.from_week):
                raise ValueError("an inactive period cannot end before it starts")


def _check_week(week: object, name: str) -> None:
    if isinstance(week, bool) or not isinstance(week, int):
        raise TypeError(f"{name} must be an int")
    if not 1 <= week <= WEEKS_PER_PLAN_YEAR:
        raise ValueError(f"{name} must be in 1..{WEEKS_PER_PLAN_YEAR}")


def covered_plan_weeks(
    periods: Iterable[InactivePeriod], plan_year: int, *, last_week: int | None = None
) -> tuple[int, ...]:
    """The absolute weeks in `year_start(plan_year) .. last_week` (default
    `year_end(plan_year + 1)`) that `periods` cover, sorted and unique. This
    is the one place the whole-week rule lives; the services side should
    build `EngineerActiveWeeks.covered_weeks` with it.

    A period covers `abs(d) + 1 .. abs(r)` (open: to `last_week`), with
    `abs(y, w) = year_start(y) - 1 + w` (R53-1)."""

    first_week = year_start(plan_year)
    last = year_end(plan_year + 1) if last_week is None else last_week
    covered: set[int] = set()
    for p in periods:
        lo = max(first_week, year_relative_to_abs(p.from_plan_year, p.from_week) + 1)
        if p.to_plan_year is None or p.to_week is None:
            hi = last
        else:
            hi = min(last, year_relative_to_abs(p.to_plan_year, p.to_week))
        covered.update(range(lo, hi + 1))
    return tuple(sorted(covered))


def active_week_count(covered_weeks: Iterable[int], first: int, last: int) -> int:
    """R38-1 `A_e(Y, first..last)`: weeks in `first..last` not covered.

    An empty range (`last < first`) has 0 weeks.
    """

    if last < first:
        return 0
    cov = {w for w in covered_weeks if first <= w <= last}
    return (last - first + 1) - len(cov)


@dataclass(frozen=True)
class EngineerActiveWeeks:
    """Supply-only data for one *counted* engineer (`counts_in_capacity`) who has
    at least one inactive period, inactive now or reactivated.

    - `engineer_id` / `hub` / `fte`: as on `EngineerInput` (`hub` is the
      engineer's own hub; the capacity hub is derived as for any engineer).
    - `covered_weeks`: absolute weeks (R53-1) the engineer's periods cover;
      sorted, unique. Build it with `covered_plan_weeks`.

    An inactive engineer is absent from `ScheduleInput.engineers` (the builder
    filters them) but still supplies in the weeks before `d + 1`; a reactivated
    engineer is in `ScheduleInput.engineers` as well, and this entry then
    replaces that engineer's supply contribution (never double counted).
    """

    engineer_id: str
    hub: str
    fte: float
    covered_weeks: tuple[int, ...] = ()

    def __post_init__(self) -> None:
        if isinstance(self.fte, bool) or not isinstance(self.fte, int | float):
            raise TypeError("fte must be a number")
        if not self.fte >= 0:
            raise ValueError("fte must be >= 0")
        prev = 0
        for w in self.covered_weeks:
            if isinstance(w, bool) or not isinstance(w, int):
                raise TypeError("covered_weeks must be ints")
            if not prev < w <= MAX_COVERED_WEEK:
                raise ValueError(
                    f"covered_weeks must be strictly increasing, in 1..{MAX_COVERED_WEEK}"
                )
            prev = w

    def active_weeks(self, first: int, last: int) -> int:
        """`A_e(first..last)` for this engineer."""

        return active_week_count(self.covered_weeks, first, last)

    def is_active_in(self, week: int) -> bool:
        return week not in self.covered_weeks
