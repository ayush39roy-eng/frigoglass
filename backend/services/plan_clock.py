"""The plan clock: the one source of "today" (ADR 0052 §1–§3, P37-T04).

DOMAIN_RULES "Horizon constants" → "The current week follows the calendar":

    plan_year            = RPD_PLAN_YEAR (default 2026)
    (iso_year, iso_week) = ISO week-date of today in Europe/Athens (every hub)
    week = RPD_CURRENT_WEEK                  if set (pin, 1..52, validated at startup)
         = min(iso_week, 52)                 if iso_year == plan_year   (W53 → 52, not closed)
         = 52, plan_year_closed = true       if iso_year >  plan_year
         = 1                                 if iso_year <  plan_year
    weeks_left_in_year = 52 − week

Rules for using it:

- It is read **late**: once per request through the `get_plan_clock` FastAPI
  dependency (FastAPI caches a dependency within one request, so every field
  of a response sees one week, I40), and once when a schedule run row is
  created (`services.run_dispatch.create_queued_schedule_run`, or the request
  of a synchronous solve). The worker builds the solver input with the row's
  stored week (R37-2), never with the clock.
- It is never read at import time, and no function parameter defaults to it
  (a default is bound at import). `domain_constants` carries no current week.
- This module is the only place that reads `RPD_CURRENT_WEEK` and
  `RPD_PLAN_YEAR` (a grep test enforces it). Both are read on every call, so a
  test can change them with `monkeypatch.setenv`; `validate_environment()`
  runs at process startup (API lifespan, Celery worker import) and stops the
  process on a bad value, with a message naming the variable.
- Tests inject "now" with `override_now(...)` (a context manager) or by
  calling `compute(...)` directly.
- A pin wins over the date and never closes the year: a pinned stack behaves
  exactly as before P37 (both test suites pin 31).
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Final, Literal
from zoneinfo import ZoneInfo

import domain_constants as dc

#: Every hub, India included, runs on the Athens week (ADR 0052 §1).
PLAN_TIMEZONE: Final[ZoneInfo] = ZoneInfo("Europe/Athens")

PIN_ENV: Final[str] = "RPD_CURRENT_WEEK"
PLAN_YEAR_ENV: Final[str] = "RPD_PLAN_YEAR"
DEFAULT_PLAN_YEAR: Final[int] = 2026
#: API_CONTRACT_P37 §4: `RPD_PLAN_YEAR` must be an integer in 2000..2100.
PLAN_YEAR_MIN: Final[int] = 2000
PLAN_YEAR_MAX: Final[int] = 2100

WeekSource = Literal["calendar", "pinned"]


class PlanClockConfigError(RuntimeError):
    """A bad `RPD_CURRENT_WEEK` / `RPD_PLAN_YEAR`. Raised at startup."""


@dataclass(frozen=True)
class PlanClock:
    """One reading of the clock. Every field derives from the same instant."""

    as_of_date: date
    iso_year: int
    iso_week: int
    #: The plan week, 1..52 (I41). The "calendar week" of DOMAIN_RULES.
    week: int
    plan_year: int
    plan_year_closed: bool
    source: WeekSource
    #: The next Monday 00:00 Europe/Athens, an aware datetime.
    week_ends_at: datetime

    @property
    def weeks_left_in_year(self) -> int:
        """`52 − week`; the current week is not counted (OQ #91)."""

        return max(0, dc.WITHIN_YEAR_WEEK - self.week)


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
    """The pinned week (1..52), or None when `RPD_CURRENT_WEEK` is unset or empty."""

    env = os.environ if environ is None else environ
    raw = env.get(PIN_ENV)
    if raw is None or raw.strip() == "":
        return None
    return _parse_int(PIN_ENV, raw, 1, dc.WITHIN_YEAR_WEEK)


def read_plan_year(environ: Mapping[str, str] | None = None) -> int:
    """`RPD_PLAN_YEAR` (2000..2100), default 2026."""

    env = os.environ if environ is None else environ
    raw = env.get(PLAN_YEAR_ENV)
    if raw is None or raw.strip() == "":
        return DEFAULT_PLAN_YEAR
    return _parse_int(PLAN_YEAR_ENV, raw, PLAN_YEAR_MIN, PLAN_YEAR_MAX)


def validate_environment(environ: Mapping[str, str] | None = None) -> None:
    """Startup check of both variables (ADR 0052 §3, API_CONTRACT_P37 §4).

    Raises `PlanClockConfigError` naming the variable; the caller lets it
    propagate so the process stops before serving requests.
    """

    read_pin(environ)
    read_plan_year(environ)


# --- The clock ----------------------------------------------------------------------


def compute(instant: datetime, *, plan_year: int, pin: int | None) -> PlanClock:
    """The pure rule. `instant` must be timezone-aware."""

    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("plan_clock.compute needs an aware datetime")
    local = instant.astimezone(PLAN_TIMEZONE)
    today = local.date()
    iso_year, iso_week, iso_weekday = today.isocalendar()
    next_monday = today + timedelta(days=8 - iso_weekday)
    week_ends_at = datetime.combine(next_monday, time(0, 0), tzinfo=PLAN_TIMEZONE)

    closed = False
    source: WeekSource
    if pin is not None:
        week, source = pin, "pinned"
    else:
        source = "calendar"
        if iso_year == plan_year:
            week = min(iso_week, dc.WITHIN_YEAR_WEEK)
        elif iso_year > plan_year:
            week, closed = dc.WITHIN_YEAR_WEEK, True
        else:
            week = 1
    return PlanClock(
        as_of_date=today,
        iso_year=iso_year,
        iso_week=iso_week,
        week=week,
        plan_year=plan_year,
        plan_year_closed=closed,
        source=source,
        week_ends_at=week_ends_at,
    )


def now() -> PlanClock:
    """Read the clock once. Never call this at import time."""

    return compute(_now_source(), plan_year=read_plan_year(), pin=read_pin())


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
