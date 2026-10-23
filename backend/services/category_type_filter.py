"""P31 (docs/API_CONTRACT_P31.md): multi-select `category` / `type` filters.

One predicate builder for every endpoint that filters projects by category or
type, so the semantics cannot drift between surfaces:

- values within one param are ORed (`IN`), different params are ANDed;
- an empty list (or `None`) means no filter;
- a single value builds `column = :value`, the exact predicate used before P31;
- the sentinel `"Unmapped"` (where an endpoint's param type admits it) means
  `column IS NULL`, ORed with the other values.

Every value is a bound parameter; nothing is interpolated into SQL. The hub
scope and the hub / country filter are applied by the caller as before; this
predicate is only ever ANDed onto them, so it can only narrow.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from enum import Enum
from typing import Any

from sqlalchemy import ColumnElement, and_, or_

from models.project import Project

#: The null bucket key, shared with `/dashboard/analytics` (`by_type`,
#: `by_category`) and `RegisterTypeFilter` (P17-R09).
UNMAPPED = "Unmapped"


def dedupe(values: Iterable[Any] | None) -> list[Any]:
    """The distinct values in first-seen order (`None` is the empty list)."""

    seen: list[Any] = []
    for value in values or ():
        if value not in seen:
            seen.append(value)
    return seen


def _is_unmapped(value: Any) -> bool:
    return not isinstance(value, Enum) and value == UNMAPPED


def any_of(column: Any, values: Sequence[Any] | None) -> ColumnElement[bool] | None:
    """`column` matches any of `values`; `None` when there is nothing to filter."""

    distinct = dedupe(values)
    if not distinct:
        return None
    real = [v for v in distinct if not _is_unmapped(v)]
    clauses: list[ColumnElement[bool]] = []
    if len(real) == 1:
        clauses.append(column == real[0])
    elif real:
        clauses.append(column.in_(real))
    if len(real) < len(distinct):
        clauses.append(column.is_(None))
    return clauses[0] if len(clauses) == 1 else or_(*clauses)


def category_type_filter(
    categories: Sequence[Any] | None,
    types: Sequence[Any] | None,
) -> ColumnElement[bool] | None:
    """`Project.category ∈ categories AND Project.type ∈ types`, each side
    omitted when its list is empty; `None` when both are."""

    clauses = [
        c
        for c in (any_of(Project.category, categories), any_of(Project.type, types))
        if c is not None
    ]
    if not clauses:
        return None
    return clauses[0] if len(clauses) == 1 else and_(*clauses)


def wire_values(values: Sequence[Any] | None) -> list[str]:
    """The distinct wire strings of a filter list (enum values, or the
    sentinel), for export job filters."""

    return [v.value if isinstance(v, Enum) else str(v) for v in dedupe(values)]


def stored_filter(values: Sequence[Any] | None) -> str | list[str] | None:
    """How an export job persists a list filter: `None` when empty, the bare
    string for one value (the pre-P31 shape, so old and new single-value jobs
    are identical), a list otherwise."""

    wire = wire_values(values)
    if not wire:
        return None
    return wire[0] if len(wire) == 1 else wire


def as_list(value: str | Sequence[str] | None) -> list[str]:
    """Read back a persisted filter: a pre-P31 bare string, a P31 list, or
    nothing."""

    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [value]
    return [v for v in value if v]
