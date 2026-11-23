"""Priority "Not applicable" for Commercialized and Cancelled projects (P57,
ADR 0067, docs/DOMAIN_RULES.md "Priority not applicable").

A read-time rule, no data change:

    effective priority = NULL ("Not applicable") when status ∈ {Commercialized, Cancelled}
                       = the stored priority otherwise

The stored `projects.priority` is never cleared or rewritten; it applies again
if the status goes back to a schedulable one. Every by-priority count, chart,
column, filter, export and What-if result reads the effective value; such a
project never appears under P1/P2/P3/P4/Q (it goes to "Not applicable", or to
"Other" where the surface has that row). Scheduler placement is unchanged.

`effective_priority_expr()` is the same rule as a SQLAlchemy expression for
SQL groupings and filters (parameterised, no string SQL).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Final, Literal

from sqlalchemy import ColumnElement, and_, case, or_

from api.errors import CodedHTTPException
from models.enums import PRIORITY_NOT_APPLICABLE_STATUSES, ProjectPriority, ProjectStatus
from models.project import Project
from services.outcome_buckets import priority_label

#: Display copy (long and short), shared by exports and served labels.
PRIORITY_NOT_APPLICABLE_LABEL: Final[str] = "Not applicable"
PRIORITY_NOT_APPLICABLE_SHORT: Final[str] = "N/A"

#: 409 code for a priority change on such a project.
PRIORITY_NOT_APPLICABLE_CODE: Final[str] = "PRIORITY_NOT_APPLICABLE"

#: Deterministic order for the SQL IN list.
_NA_STATUSES: Final[tuple[ProjectStatus, ...]] = tuple(
    sorted(PRIORITY_NOT_APPLICABLE_STATUSES, key=lambda s: s.value)
)


def _status_member(status: object) -> ProjectStatus | None:
    if status is None:
        return None
    if isinstance(status, ProjectStatus):
        return status
    try:
        return ProjectStatus(getattr(status, "value", status))
    except ValueError:
        return None


def priority_applicable(status: object) -> bool:
    """False when the project's priority is "Not applicable" (ADR 0067).
    Accepts the enum or its stored string; an unknown / missing status is
    treated as applicable (the stored priority is shown)."""

    return _status_member(status) not in PRIORITY_NOT_APPLICABLE_STATUSES


def effective_priority[P](status: object, priority: P | None) -> P | None:
    """The priority every grouping / count / filter / display uses: `None`
    for a Commercialized or Cancelled project, else `priority` unchanged
    (enum in, enum out; string in, string out)."""

    return priority if priority_applicable(status) else None


def effective_priority_expr(status_col: Any = None, priority_col: Any = None) -> ColumnElement[Any]:
    """SQL form of `effective_priority`: ``CASE WHEN status IN (...) THEN NULL
    ELSE priority END``. Defaults to `Project.status` / `Project.priority`.
    The result keeps the priority column's type, so `.in_([...])` and
    `GROUP BY` compare enum values exactly as the stored column does."""

    status = Project.status if status_col is None else status_col
    priority = Project.priority if priority_col is None else priority_col
    return case((status.in_(_NA_STATUSES), None), else_=priority)


#: ADR 0067: the priority filter value selecting exactly the Commercialized /
#: Cancelled projects (also the What-if import `by_priority` key).
NOT_APPLICABLE_FILTER: Final = "not_applicable"
PriorityFilterValue = ProjectPriority | Literal["not_applicable"]


def priority_filter_predicate(
    values: Sequence[PriorityFilterValue] | None, *, queue_includes_unset: bool = False
) -> ColumnElement[bool] | None:
    """The server-side priority filter (ADR 0067). Bands match the EFFECTIVE
    priority, so "P4" never matches a Commercialized / Cancelled project;
    `not_applicable` matches exactly those. With `queue_includes_unset`
    (Gantt's Queue bucket), "Q" also matches an applicable project with no
    priority. `None` when there is nothing to filter. Bound parameters only."""

    if not values:
        return None
    distinct = list(dict.fromkeys(values))
    bands = [ProjectPriority(v) for v in distinct if v != NOT_APPLICABLE_FILTER]
    clauses: list[ColumnElement[bool]] = []
    if bands:
        clauses.append(effective_priority_expr().in_(bands))
        if queue_includes_unset and ProjectPriority.Q in bands:
            clauses.append(and_(Project.priority.is_(None), priority_applicable_expr()))
    if NOT_APPLICABLE_FILTER in distinct:
        clauses.append(Project.status.in_(_NA_STATUSES))
    return clauses[0] if len(clauses) == 1 else or_(*clauses)


def priority_applicable_expr(status_col: Any = None) -> ColumnElement[bool]:
    """SQL: true when the priority applies (status not Commercialized /
    Cancelled). Use it to AND onto a stored-priority filter."""

    status = Project.status if status_col is None else status_col
    return status.not_in(_NA_STATUSES)


def served_priority_label(status: object, priority: object) -> str | None:
    """The served `priority_label`: "Not applicable" for such a project, else
    the R42-1 band label (`None` with no band)."""

    if not priority_applicable(status):
        return PRIORITY_NOT_APPLICABLE_LABEL
    return priority_label(priority)


def ensure_priority_applicable(status: object) -> None:
    """409 `PRIORITY_NOT_APPLICABLE` when `status` is Commercialized /
    Cancelled: the priority of such a project cannot be changed (ADR 0067).
    The project name / priority value are not echoed."""

    if not priority_applicable(status):
        raise CodedHTTPException(
            409,
            PRIORITY_NOT_APPLICABLE_CODE,
            "Priority is not applicable to a Commercialized or Cancelled project, "
            "so it cannot be changed. Change the status first.",
        )


def effective_priority_display(status: object, priority: object) -> str:
    """Export / text cell: "Not applicable" for such a project, the stored
    band value otherwise ("" when unset)."""

    if not priority_applicable(status):
        return PRIORITY_NOT_APPLICABLE_LABEL
    if priority is None:
        return ""
    return str(getattr(priority, "value", priority))


__all__ = [
    "NOT_APPLICABLE_FILTER",
    "PRIORITY_NOT_APPLICABLE_CODE",
    "PriorityFilterValue",
    "priority_filter_predicate",
    "PRIORITY_NOT_APPLICABLE_LABEL",
    "PRIORITY_NOT_APPLICABLE_SHORT",
    "PRIORITY_NOT_APPLICABLE_STATUSES",
    "effective_priority",
    "effective_priority_display",
    "effective_priority_expr",
    "ensure_priority_applicable",
    "priority_applicable",
    "priority_applicable_expr",
    "served_priority_label",
]
