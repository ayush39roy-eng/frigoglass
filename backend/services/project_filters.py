"""Shared project-list filter helpers for the Gantt and Matrix toolbars
(P13-T13/T14, `docs/API_CONTRACT_P13.md` §7), with the §3 semantics that
`/dashboard/projects` (P13-T01) already serves:

- `q`: stripped, case-insensitive substring of `Project.name` OR
  `Project.external_code`. `%`, `_` and `\\` are escaped so the term is
  matched literally; the pattern is a bound parameter (`ilike(..., escape=)`),
  never interpolated into SQL text.
- `leader_name`: OQ #8 / P3-T09 GDPR rule — a person's name is served only to
  that person (the leader's linked `User` is the caller). Every other reader
  gets `None`; `leader_engineer_id` stays available.
- rank: 1-based by `weighted_score` descending, then name, then id, within the
  final filtered set. Unscored projects have no rank.

Kept out of `api/routers/dashboard.py` (another builder's file) on purpose;
the dashboard keeps its own private copies of the same three rules.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable

from sqlalchemy import ColumnElement, or_

from core.principal import Principal
from models.project import Project

#: Same bound as `/dashboard/projects` (§3).
Q_MAX_LENGTH = 100
#: Step template ids are short codes such as `PDD-E` / `OEM-H`.
STEP_CODE_MAX_LENGTH = 10


def escape_like(value: str) -> str:
    """Escape LIKE wildcards so the term is matched literally (escape `\\`)."""

    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def search_predicate(q: str | None) -> ColumnElement[bool] | None:
    """Name OR external code contains `q` (case-insensitive); `None` when
    `q` is absent or blank."""

    term = q.strip() if q is not None else ""
    if not term:
        return None
    pattern = f"%{escape_like(term)}%"
    return or_(
        Project.name.ilike(pattern, escape="\\"),
        Project.external_code.ilike(pattern, escape="\\"),
    )


def leader_name_if_self(project: Project, principal: Principal) -> str | None:
    """ADR 0028: the leader's name for any caller who can read the project
    (the P13 OQ #8 withholding is lifted). Needs `Project.leader_engineer`
    loaded (`selectinload`). `principal` is kept so call sites are unchanged."""

    leader = project.leader_engineer
    return leader.name if leader is not None else None


def score_ranks(
    projects: Iterable[Project], score_of: Callable[[Project], float | None]
) -> dict[uuid.UUID, int]:
    """1-based rank by score descending, then name, then id. Unscored
    projects are absent from the result (rank `None`)."""

    scored = [(p, s) for p in projects if (s := score_of(p)) is not None]
    scored.sort(key=lambda ps: (-ps[1], ps[0].name, str(ps[0].id)))
    return {p.id: i for i, (p, _) in enumerate(scored, start=1)}
