"""Project search predicate (docs/API_CONTRACT_P13.md §3 `q` semantics, with
the P51-T02 wildcard rule in docs/DOMAIN_RULES.md "Project search").

The one server-side project search. Every endpoint that takes a project `q`
(`/projects`, `/dashboard/projects`, `/gantt`, `/priorities`, `/priority-board`
and the exports that reuse them) builds its predicate here.

- Case-insensitive match of `Project.name` OR `Project.external_code`.
- The term is stripped; blank means no filter.
- `*` matches any run of characters (including none), `?` exactly one
  character. Every other character, including `%`, `_` and `\\`, matches
  literally (escaped with `\\`).
- Still a substring match: the pattern is wrapped in `%...%`, so a term
  without wildcards keeps the pre-P51 substring behaviour and `SP*` finds any
  name containing "SP".
- The pattern is a bound parameter (`ilike(..., escape="\\")`), never
  interpolated into SQL. The 100-character limit is the caller's
  `Query(max_length=Q_MAX_LENGTH)`.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, or_

from models.project import Project

#: The §3 limit on `q`.
Q_MAX_LENGTH = 100
#: The LIKE escape character every project search uses.
LIKE_ESCAPE = "\\"


def escape_like(value: str) -> str:
    """Escape LIKE wildcards (escape character `\\`) so `value` matches literally."""

    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def search_like_pattern(q: str | None) -> str | None:
    """The ILIKE pattern for a project search term, or `None` for a missing or
    blank term. `*` → `%`, `?` → `_`; everything else is literal; wrapped in
    `%...%` (substring match)."""

    term = q.strip() if q is not None else ""
    if not term:
        return None
    # Escaping never produces `*` or `?`, so the translation after it only
    # touches the user's own wildcards.
    body = escape_like(term).replace("*", "%").replace("?", "_")
    return f"%{body}%"


def project_search_filter(q: str | None) -> ColumnElement[bool] | None:
    """The `q` predicate (name OR external code), or `None` for a missing or
    blank term."""

    pattern = search_like_pattern(q)
    if pattern is None:
        return None
    return or_(
        Project.name.ilike(pattern, escape=LIKE_ESCAPE),
        Project.external_code.ilike(pattern, escape=LIKE_ESCAPE),
    )
