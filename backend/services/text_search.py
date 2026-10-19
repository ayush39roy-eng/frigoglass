"""Project search predicate (docs/API_CONTRACT_P13.md §3 `q` semantics).

Case-insensitive substring of `Project.name` OR `Project.external_code`. The
term is stripped; blank means no filter. `%`, `_` and `\\` are escaped so they
match literally, and the pattern is a bound parameter (`ilike(..., escape=)`),
never interpolated into SQL. The 100-character limit is the caller's
`Query(max_length=100)`.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, or_

from models.project import Project

#: The §3 limit on `q`.
Q_MAX_LENGTH = 100


def escape_like(value: str) -> str:
    """Escape LIKE wildcards (escape character `\\`)."""

    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def project_search_filter(q: str | None) -> ColumnElement[bool] | None:
    """The `q` predicate, or `None` for a missing or blank term."""

    term = q.strip() if q is not None else ""
    if not term:
        return None
    pattern = f"%{escape_like(term)}%"
    return or_(
        Project.name.ilike(pattern, escape="\\"),
        Project.external_code.ilike(pattern, escape="\\"),
    )
