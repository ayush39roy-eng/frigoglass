"""The plan clock: the one source of "today" (ADR 0052 §1–§3, P37-T04;
rewritten for one absolute week line at P53-T03, ADR 0063 R53-1, I41).

DOMAIN_RULES "One week line, open horizon, delivery by year":

    (iso_year, iso_week) = ISO week-date of today in Europe/Athens (every hub)
    week = RPD_CURRENT_WEEK                       if set (pin, absolute, 1..5200)
         = abs_week(iso_year, iso_week)           otherwise
           (= 52 × (iso_year − 2026) + min(iso_week, 52); 1 when iso_year < 2026)
    plan_year          = year_of(week)
    weeks_left_in_year = year_end(plan_year) − week

ISO week 53 folds into week 52 of its ISO year (28 Dec 2026 – 3 Jan 2027 → 52);
4 Jan 2027 reads 53 and the plan year is 2027, automatically. There is no
closed year (`PLAN_YEAR_CLOSED` retired, R53-1); `plan_year_closed` is always
False and is served only for one release.

Rules for using it:

- It is read **late**: once per request through the `get_plan_clock` FastAPI
  dependency (FastAPI caches a dependency within one request, so every field
  of a response sees one week, I40), and once when a schedule run row is
  created (`services.run_dispatch.create_queued_schedule_run`, or the request
  of a synchronous solve). The worker builds the solver input with the row's
  stored week (R37-2), never with the clock.
- It is never read at import time, and no function parameter defaults to it.
- This module is the only place that reads `RPD_CURRENT_WEEK` and
  `RPD_PLAN_YEAR` (a grep test enforces it). `validate_environment()` runs at
  process startup (API lifespan, Celery worker import) and stops the process on
  a bad value. `RPD_PLAN_YEAR` is retired: unset is normal, `2026` is accepted
  with a deprecation log, any other value stops startup (it would move the
  base).
- Tests inject "now" with `override_now(...)` or call `compute(...)` directly.
- The year-relative engineer tables (deactivation, inactive periods, leader
  history) are written as `(plan_year, week_of_year)` of this clock.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Final, Literal
from zoneinfo import ZoneInfo

from scheduling.weeks import (
    MAX_ABSOLUTE_WEEK,
    WEEK_BASE_YEAR,
    abs_week,
    week_of_year,
    year_end,
    year_of,
    year_start,
)

logger = logging.getLogger(__name__)

#: Every hub, India included, runs on the Athens week (ADR 0052 §1).
PLAN_TIMEZONE: Final[ZoneInfo] = ZoneInfo("Europe/Athens")

PIN_ENV: Final[str] = "RPD_CURRENT_WEEK"
#: Retired at P53 (R53-1). Only `WEEK_BASE_YEAR` is accepted, with a
#: deprecation log; any other value stops startup.
PLAN_YEAR_ENV: Final[str] = "RPD_PLAN_YEAR"

WeekSource = Literal["calendar", "pinned"]


class PlanClockConfigError(RuntimeError):
    """A bad `RPD_CURRENT_WEEK` / `RPD_PLAN_YEAR`. Raised at startup."""


@dataclass(frozen=True)
class PlanClock:
    """One reading of the clock. Every field derives from the same instant."""

    as_of_date: date
    iso_year: int
    iso_week: int
    #: The absolute plan week from 2026 W1 (I41). The "calendar week".
    week: int
    source: WeekSource
    #: The next Monday 00:00 Europe/Athens, an aware datetime.
    week_ends_at: datetime

    @property
    def plan_year(self) -> int:
        """`year_of(week)` (R53-1)."""

        return year_of(self.week)

    @property
    def week_of_year(self) -> int:
        """1..52: the week inside `plan_year` (for the year-relative tables)."""

        return week_of_year(self.week)

    @property
    def plan_year_start_week(self) -> int:
        return year_start(self.plan_year)

    @property
    def plan_year_end_week(self) -> int:
        return year_end(self.plan_year)

    @property
    def plan_year_closed(self) -> bool:
        """Retired (R53-1): always False. Served for one release only."""

        return False

    @property
    def weeks_left_in_year(self) -> int:
        """`plan_year_end_week − week`; the current week not counted (OQ #91)."""

        return self.plan_year_end_week - self.week


def _utc_now() -> datetime:
    return datetime.now(UTC)


#: The injectable source of "now". Tests replace it with `override_now`.
_now_source: Callable[[], datetime] = _utc_now


# --- Environment ------------------------------------------------------------------


def _parse_int(name: str, raw: str, lo: int, hi: int) -> int:
    text = raw.strip()
    try:
        value = int(text, 10)
    except ValueError:
        raise PlanClockConfigError(
            f"{name} must be an integer between {lo} and {hi}; got {raw!r}"
        ) from None
    if not lo <= value <= hi:
        raise PlanClockConfigError(f"{name} must be an integer between {lo} and {hi}; got {value}")
    return value


def read_pin(environ: Mapping[str, str] | None = None) -> int | None:
    """The pinned absolute week (1..5200), or None when `RPD_CURRENT_WEEK` is
    unset or empty. 5200 is a 100-year sanity bound, not a calendar cap."""

    env = os.environ if environ is None else environ
    raw = env.get(PIN_ENV)
    if raw is None or raw.strip() == "":
        return None
    return _parse_int(PIN_ENV, raw, 1, MAX_ABSOLUTE_WEEK)


def check_retired_plan_year(environ: Mapping[str, str] | None = None) -> None:
    """R53-1: `RPD_PLAN_YEAR` is retired. Unset (or empty) is the normal
    state; `2026` is accepted with a deprecation log; anything else raises."""

    env = os.environ if environ is None else environ
    raw = env.get(PLAN_YEAR_ENV)
    if raw is None or raw.strip() == "":
        return
    if raw.strip() != str(WEEK_BASE_YEAR):
        raise PlanClockConfigError(
            f"{PLAN_YEAR_ENV} is retired (ADR 0063): unset it. Only {WEEK_BASE_YEAR} is "
            f"tolerated, because any other value would move the week base; got {raw!r}"
        )
    logger.warning("%s is retired (ADR 0063) and ignored; unset it.", PLAN_YEAR_ENV)


def validate_environment(environ: Mapping[str, str] | None = None) -> None:
    """Startup check (R53-1). Raises `PlanClockConfigError` naming the
    variable; the caller lets it propagate so the process stops."""

    read_pin(environ)
    check_retired_plan_year(environ)


# --- The clock ----------------------------------------------------------------------


def compute(instant: datetime, *, pin: int | None) -> PlanClock:
    """The pure rule. `instant` must be timezone-aware."""

    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("plan_clock.compute needs an aware datetime")
    local = instant.astimezone(PLAN_TIMEZONE)
    today = local.date()
    iso_year, iso_week, iso_weekday = today.isocalendar()
    next_monday = today + timedelta(days=8 - iso_weekday)
    week_ends_at = datetime.combine(next_monday, time(0, 0), tzinfo=PLAN_TIMEZONE)

    source: WeekSource
    if pin is not None:
        week, source = pin, "pinned"
    else:
        week, source = abs_week(iso_year, iso_week), "calendar"
    return PlanClock(
        as_of_date=today,
        iso_year=iso_year,
        iso_week=iso_week,
        week=week,
        source=source,
        week_ends_at=week_ends_at,
    )


def now() -> PlanClock:
    """Read the clock once. Never call this at import time."""

    return compute(_now_source(), pin=read_pin())


def current_week() -> int:
    """Shorthand for `now().week`, for callers that need only the week (a run
    row's creation, a script). A request handler uses `get_plan_clock`."""

    return now().week


@contextmanager
def override_now(source: datetime | Callable[[], datetime]) -> Iterator[None]:
    """Tests: make `now()` read `source` (a fixed aware datetime or a callable)."""

    global _now_source
    previous = _now_source
    if isinstance(source, datetime):
        fixed = source
        _now_source = lambda: fixed  # noqa: E731
    else:
        _now_source = source
    try:
        yield
    finally:
        _now_source = previous


async def get_plan_clock() -> PlanClock:
    """FastAPI dependency: one clock reading per request (I40)."""

    return now()
