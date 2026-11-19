"""One absolute week line, the open search limit and the R53 counting split
(ADR 0063 as ruled at R53-1 / R53-2 / R53-5, invariants I57 / I58; DOMAIN_RULES
"One week line, open horizon, delivery by year").

Pure helpers with no dependency on `domain_constants` or on any other module
of this package, so any layer (services, routers, scripts) may import them
directly (`from scheduling.weeks import year_of`). This is the single backend
implementation of `year_of` / `week_of_year` (I57).

Week continuum (R53-1): week 1 is ISO week 1 of `WEEK_BASE_YEAR` (2026) and
weeks are never re-based; year `Y` owns weeks `year_start(Y) .. year_end(Y)`
(52 weeks; ISO week 53 folds into week 52 of its ISO year)::

    year_of(w)      = 2026 + floor((w - 1) / 52)
    week_of_year(w) = (w - 1) mod 52 + 1
    year_start(Y)   = 52 * (Y - 2026) + 1
    year_end(Y)     = 52 * (Y - 2026 + 1)
    abs_week(iso_year, iso_week) = 52 * (iso_year - 2026) + min(iso_week, 52)

Search limit (R53-2): `H = horizon_for(cw, N) = cw + 52 * N`, N in 1..10,
default 5. No fixed calendar week or year is a search limit anywhere (I58).
"""

from __future__ import annotations

from collections.abc import Iterator

#: R53-1: the year of absolute week 1. A constant forever: changing it would
#: re-base every stored week.
WEEK_BASE_YEAR: int = 2026
#: Weeks in one plan year (ISO week 53 folds into week 52).
PLAN_YEAR_WEEKS: int = 52

#: R53-2: the Admin setting `scheduling_horizon_years` (N) — range and default.
DEFAULT_HORIZON_YEARS: int = 5
MIN_HORIZON_YEARS: int = 1
MAX_HORIZON_YEARS: int = 10

#: R53-5: the CP-SAT model window margin past the within-year cut-off
#: (`W_cp = min(within_year_week + 26, H)`). Not a search limit.
CP_SAT_WINDOW_MARGIN_WEEKS: int = 26

#: R53-1 environment sanity bound for an absolute week (100 years), not a
#: calendar cap.
MAX_ABSOLUTE_WEEK: int = 5200

# R42-3 / R53-2 band and status sets, restated here so this module has no
# dependency (they equal `domain_constants.NOT_SCHEDULED_PRIORITIES`,
# `SCHEDULABLE_STATUS_ORDER` keys and `QUEUED_STATUS`; a test pins that).
_NOT_SCHEDULED_PRIORITIES: frozenset[str] = frozenset({"P4", "Q"})
_SCHEDULABLE_STATUSES: frozenset[str] = frozenset(
    {"In Buyoff", "Under Industrialization", "In Development", "In Queue"}
)
_QUEUED_STATUS: str = "In Queue"


def _check_week(week: object, name: str = "week") -> int:
    if isinstance(week, bool) or not isinstance(week, int):
        raise TypeError(f"{name} must be an int week, got {week!r}")
    if week < 1:
        raise ValueError(f"{name} {week} must be >= 1 (absolute week from {WEEK_BASE_YEAR} W1)")
    return week


def _check_year(year: object) -> int:
    if isinstance(year, bool) or not isinstance(year, int):
        raise TypeError(f"year must be an int, got {year!r}")
    if year < WEEK_BASE_YEAR:
        raise ValueError(f"year {year} is before the week base year {WEEK_BASE_YEAR}")
    return year


def year_of(week: int) -> int:
    """The calendar (plan) year of absolute week `week` (>= 1)."""

    return WEEK_BASE_YEAR + (_check_week(week) - 1) // PLAN_YEAR_WEEKS


def week_of_year(week: int) -> int:
    """The week of its year (1..52) of absolute week `week` (>= 1)."""

    return (_check_week(week) - 1) % PLAN_YEAR_WEEKS + 1


def year_start(year: int) -> int:
    """The first absolute week of `year` (>= WEEK_BASE_YEAR)."""

    return PLAN_YEAR_WEEKS * (_check_year(year) - WEEK_BASE_YEAR) + 1


def year_end(year: int) -> int:
    """The last absolute week of `year` (>= WEEK_BASE_YEAR)."""

    return PLAN_YEAR_WEEKS * (_check_year(year) - WEEK_BASE_YEAR + 1)


def abs_week(iso_year: int, iso_week: int) -> int:
    """R53-1 / I41: the absolute week of an ISO week-date. ISO week 53 folds
    into week 52 of its year; an ISO year before the base gives 1."""

    if isinstance(iso_week, bool) or not isinstance(iso_week, int) or not 1 <= iso_week <= 53:
        raise ValueError(f"iso_week {iso_week!r} must be an int in 1..53")
    if isinstance(iso_year, bool) or not isinstance(iso_year, int):
        raise TypeError(f"iso_year must be an int, got {iso_year!r}")
    if iso_year < WEEK_BASE_YEAR:
        return 1
    return PLAN_YEAR_WEEKS * (iso_year - WEEK_BASE_YEAR) + min(iso_week, PLAN_YEAR_WEEKS)


def year_relative_to_abs(plan_year: int, week: int) -> int:
    """R53-1 (F2): convert a year-relative `(plan_year, week 1..52)` row of the
    engineer tables to an absolute week: `year_start(y) - 1 + w`. A year
    before the base year gives a week <= 0 (a period that began before
    2026 W1); callers clip."""

    if isinstance(week, bool) or not isinstance(week, int) or not 1 <= week <= PLAN_YEAR_WEEKS:
        raise ValueError(f"week {week!r} must be an int in 1..{PLAN_YEAR_WEEKS}")
    if isinstance(plan_year, bool) or not isinstance(plan_year, int):
        raise TypeError(f"plan_year must be an int, got {plan_year!r}")
    return PLAN_YEAR_WEEKS * (plan_year - WEEK_BASE_YEAR) + week


def plan_year_start_week(current_week: int) -> int:
    """`year_start(year_of(cw))`."""

    return year_start(year_of(current_week))


def plan_year_end_week(current_week: int) -> int:
    """`year_end(year_of(cw))`: the within-year cut-off of a live, What-if or
    scenario run (I50 amended)."""

    return year_end(year_of(current_week))


def weeks_left_in_year(current_week: int) -> int:
    """I40 (amended): `plan_year_end_week - current_week` (current week not
    counted)."""

    return plan_year_end_week(current_week) - current_week


def check_horizon_years(n: object) -> int:
    """R53-2: N is an int in 1..10. Returns it or raises."""

    if isinstance(n, bool) or not isinstance(n, int):
        raise TypeError(f"horizon years must be an int, got {n!r}")
    if not MIN_HORIZON_YEARS <= n <= MAX_HORIZON_YEARS:
        raise ValueError(
            f"horizon years {n} is outside {MIN_HORIZON_YEARS}..{MAX_HORIZON_YEARS} (R53-2)"
        )
    return n


def horizon_for(current_week: int, horizon_years: int = DEFAULT_HORIZON_YEARS) -> int:
    """R53-2 / I58: the search limit `H = cw + 52 * N`. Every solve path takes
    its horizon from here."""

    return _check_week(current_week, "current_week") + PLAN_YEAR_WEEKS * check_horizon_years(
        horizon_years
    )


def cp_sat_window(within_year_week: int, horizon_weeks: int) -> int:
    """R53-5 / I60: the CP-SAT model window `W_cp = min(within_year_week + 26, H)`."""

    return min(within_year_week + CP_SAT_WINDOW_MARGIN_WEEKS, horizon_weeks)


def year_windows(first_week: int, last_week: int) -> Iterator[tuple[int, int, int]]:
    """R53-4: one `(year, a, b)` window per calendar year from `year_of(first)`
    to `year_of(last)`; the first starts at `first_week`, the last is clipped
    to `last_week`. Empty when `last_week < first_week`."""

    if last_week < first_week:
        return
    for year in range(year_of(first_week), year_of(last_week) + 1):
        yield year, max(first_week, year_start(year)), min(last_week, year_end(year))


def plan_until_presets(current_week: int, horizon_weeks: int) -> tuple[tuple[int, int], ...]:
    """R53-4: `(year, year_end(year))` for every year from `year_of(cw)` to
    `year_of(H)` whose year end lies within `H` (a preset past the search
    limit could not be chosen, `u <= H`)."""

    return tuple(
        (year, year_end(year))
        for year in range(year_of(current_week), year_of(horizon_weeks) + 1)
        if year_end(year) <= horizon_weeks
    )


# --- R53-2: counting vs scheduling tier --------------------------------------


def counts_toward_year(priority: str | None, status: str) -> bool:
    """R53-2 (amends R42-4)::

        counts_toward_year(p) = NOT (p.status ∈ SCHEDULABLE ∧ p.priority ∈ {P4, Q})

    A queued P3 counts. A status-excluded project is True. A frozen P4/Q
    books but never counts."""

    return not (status in _SCHEDULABLE_STATUSES and priority in _NOT_SCHEDULED_PRIORITIES)


def queue_tier(priority: str | None, status: str) -> bool:
    """R53-2: the scheduling tier (the old R42-4 negation, unchanged values)::

        queue_tier(p) = p.status ∈ SCHEDULABLE ∧ (p.priority ∈ {P4, Q}
                         ∨ (p.priority = P3 ∧ p.status = "In Queue"))

    Drives sort key 1a (`¬queue_tier` first), CP-SAT model membership (R42-5)
    and the I51 / I52 checks, so placement order is unchanged by R53."""

    if status not in _SCHEDULABLE_STATUSES:
        return False
    if priority in _NOT_SCHEDULED_PRIORITIES:
        return True
    return priority == "P3" and status == _QUEUED_STATUS


# --- R53-2b: delivered year of a Commercialized project -----------------------


def commercialized_within_year(actual_end_week: int | None, current_week: int) -> bool:
    """R53-2b / I61: a Commercialized project counts within year Y0 =
    `year_of(cw)` iff its actual end week lies in Y0 or later, or it has no
    actual end week and Y0 is 2026. Identical to the pre-P53 rule (always
    True) for every run in 2026."""

    y0 = year_of(current_week)
    if actual_end_week is None:
        return y0 == WEEK_BASE_YEAR
    return actual_end_week >= year_start(y0)


__all__ = [
    "CP_SAT_WINDOW_MARGIN_WEEKS",
    "DEFAULT_HORIZON_YEARS",
    "MAX_ABSOLUTE_WEEK",
    "MAX_HORIZON_YEARS",
    "MIN_HORIZON_YEARS",
    "PLAN_YEAR_WEEKS",
    "WEEK_BASE_YEAR",
    "abs_week",
    "check_horizon_years",
    "commercialized_within_year",
    "counts_toward_year",
    "cp_sat_window",
    "horizon_for",
    "plan_until_presets",
    "plan_year_end_week",
    "plan_year_start_week",
    "queue_tier",
    "week_of_year",
    "weeks_left_in_year",
    "year_end",
    "year_of",
    "year_relative_to_abs",
    "year_start",
    "year_windows",
]
