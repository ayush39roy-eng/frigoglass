"""The exclusive run-outcome buckets and the band labels (P42, ADR 0056).

docs/DOMAIN_RULES.md "Priority band meaning", ruling P42-T01 R42-1, R42-4,
R42-6 and invariant I53.

One precedence for every surface that buckets a stored outcome row:

    NOT_SCHEDULED_PRIORITY > QUEUED > BLOCKED > WITHIN_YEAR > SPILLOVER > LEFT_OUT

- `NOT_SCHEDULED_PRIORITY`: `not_scheduled_priority` (a non-frozen P4/Q
  project in a schedulable status, R42-3).
- `QUEUED`: `counts_toward_year` is false (a queued P3, or a frozen P4/Q).
- The other four are the pre-P42 buckets, so they now hold counting rows
  only, and every denominator built from them excludes queued and P4 rows
  automatically (R42-6).
- A row in none of the six (a status-excluded On Hold / Cancelled / Draft
  project, or a data error) has no bucket (`None`), as before P42.

Every helper reads the STORED flags only (I50, I53). Nothing here derives a
flag from the live project's priority or status.

The SQL helpers return SQLAlchemy expressions (no string SQL).
"""

from __future__ import annotations

from typing import Literal, Protocol

from sqlalchemy import ColumnElement, and_

import domain_constants as dc
from models.schedule import ScheduleRunProjectOutcome
from scheduling.weeks import week_of_year

OutcomeBucket = Literal[
    "NOT_SCHEDULED_PRIORITY", "QUEUED", "BLOCKED", "WITHIN_YEAR", "SPILLOVER", "LEFT_OUT"
]

#: R42-6 precedence order (also the served order of bucket lists).
BUCKET_ORDER: tuple[OutcomeBucket, ...] = (
    "NOT_SCHEDULED_PRIORITY",
    "QUEUED",
    "BLOCKED",
    "WITHIN_YEAR",
    "SPILLOVER",
    "LEFT_OUT",
)

#: R42-3 display copy for a not-scheduled project.
NOT_SCHEDULED_LABEL = "Not scheduled (P4)"


class _OutcomeFlags(Protocol):
    """Anything with the stored outcome flags (an ORM row, the scheduler's
    `ProjectScheduleOutcome`, a What-if `ProjectResult`)."""

    @property
    def within_year(self) -> bool: ...
    @property
    def spillover(self) -> bool: ...
    @property
    def left_out(self) -> bool: ...
    @property
    def blocked(self) -> bool: ...
    @property
    def counts_toward_year(self) -> bool: ...
    @property
    def not_scheduled_priority(self) -> bool: ...


def outcome_bucket(outcome: _OutcomeFlags | None) -> OutcomeBucket | None:
    """The R42-6 exclusive bucket of one stored outcome; `None` for a row in
    none of the six (or no row)."""

    if outcome is None:
        return None
    if outcome.not_scheduled_priority:
        return "NOT_SCHEDULED_PRIORITY"
    if not outcome.counts_toward_year:
        return "QUEUED"
    if outcome.blocked:
        return "BLOCKED"
    if outcome.within_year:
        return "WITHIN_YEAR"
    if outcome.spillover:
        return "SPILLOVER"
    if outcome.left_out:
        return "LEFT_OUT"
    return None


def priority_label(priority: object) -> str | None:
    """R42-1: the band's label (`domain_constants.PRIORITY_LABELS`), or
    `None` for no band. Accepts the enum or its wire value."""

    if priority is None:
        return None
    value = getattr(priority, "value", priority)
    return dc.PRIORITY_LABELS.get(str(value))


def queued_display(
    *, left_out: bool, projected_end_week: int | None, year_end_week: int = 52
) -> str:
    """R42-4 display of a queued project: "Queued — fits by W{n}",
    "Queued — after W52" or "Queued — no slot". P53 (R53-2): only pre-P53
    rows are ever QUEUED; `year_end_week` is that run's plan-year end (52 for
    every stored run, since every pre-P53 run is a 2026 run)."""

    if left_out or projected_end_week is None:
        return "Queued — no slot"
    if projected_end_week <= year_end_week:
        return f"Queued — fits by W{week_of_year(projected_end_week)}"
    return f"Queued — after W{week_of_year(year_end_week)}"


def outcome_label(outcome: _OutcomeFlags | None, projected_end_week: int | None) -> str | None:
    """The served display text of a non-counting outcome: "Not scheduled
    (P4)" (R42-3) or the R42-4 queued text; `None` for a counting row or no
    row (the surface keeps its pre-P42 copy)."""

    bucket = outcome_bucket(outcome)
    if bucket == "NOT_SCHEDULED_PRIORITY":
        return NOT_SCHEDULED_LABEL
    if bucket == "QUEUED" and outcome is not None:
        return queued_display(left_out=outcome.left_out, projected_end_week=projected_end_week)
    return None


# --- SQL expressions over `ScheduleRunProjectOutcome` --------------------------

_O = ScheduleRunProjectOutcome


def sql_counting() -> ColumnElement[bool]:
    """Counting rows only (R42-6, I53)."""

    return and_(_O.counts_toward_year.is_(True), _O.not_scheduled_priority.is_(False))


def sql_bucket_within_year() -> ColumnElement[bool]:
    """The exclusive `WITHIN_YEAR` bucket."""

    return and_(sql_counting(), _O.blocked.is_(False), _O.within_year.is_(True))


def sql_bucket_spillover() -> ColumnElement[bool]:
    return and_(
        sql_counting(), _O.blocked.is_(False), _O.within_year.is_(False), _O.spillover.is_(True)
    )


def sql_bucket_left_out() -> ColumnElement[bool]:
    return and_(
        sql_counting(),
        _O.blocked.is_(False),
        _O.within_year.is_(False),
        _O.spillover.is_(False),
        _O.left_out.is_(True),
    )


def sql_bucket_queued() -> ColumnElement[bool]:
    return and_(_O.not_scheduled_priority.is_(False), _O.counts_toward_year.is_(False))


def sql_bucket_not_scheduled() -> ColumnElement[bool]:
    return _O.not_scheduled_priority.is_(True)


__all__ = [
    "BUCKET_ORDER",
    "NOT_SCHEDULED_LABEL",
    "OutcomeBucket",
    "outcome_bucket",
    "outcome_label",
    "priority_label",
    "queued_display",
    "sql_bucket_left_out",
    "sql_bucket_not_scheduled",
    "sql_bucket_queued",
    "sql_bucket_spillover",
    "sql_bucket_within_year",
    "sql_counting",
]
