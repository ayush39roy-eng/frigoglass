"""P58-B: the Projects list ("register") download — exactly the columns of the
Projects page table, in its order, with its header names — and the cell
values the What-if import compares a re-uploaded copy against.

One definition serves both directions (`REGISTER_COLUMNS` and
`register_cells`), so an export re-uploaded without edits reads as
unchanged, cell for cell.

**Columns** (the `id`s of `frontend/src/surfaces/projects/components/
projects-table.tsx`, so the page can send what it shows): `#` and `Project`
are always on screen and always exported; `Project code` is the code the
screen prints under the name; the hideable columns follow in screen order;
the three charter columns appear only when asked for (their own toggle on
the page); `Project ID` is always last so a re-upload matches its project
exactly. The `Select` and `Actions` columns are controls, not data.

**Financial fields.** None: the Projects page shows no financial column, so
the download has none (the Registration register export keeps them for the
roles entitled to them). Nothing here logs a value.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scheduling.weeks import PLAN_YEAR_WEEKS, WEEK_BASE_YEAR
from services.priority_applicability import PRIORITY_NOT_APPLICABLE_LABEL
from services.week_labels import week_label

if TYPE_CHECKING:
    from schemas.dashboard import ProjectFilterRow


@dataclass(frozen=True)
class RegisterColumn:
    #: The Projects table column id (what the page sends in `columns`).
    key: str
    #: The header written in the file (the screen's name for the column).
    header: str
    #: True: the page may hide it (`HIDEABLE_COLUMNS` / the charter toggle).
    optional: bool = True
    #: True: shown by default (the charter columns are off by default).
    default: bool = True
    #: P60 (ADR 0068): in the download exactly when this other column is
    #: ("Global rank" follows "Hub rank", the page's one `rank` column).
    follows: str | None = None


#: Screen order. `ordinal`, `project`, `code` and `project-id` are always in.
REGISTER_COLUMNS: tuple[RegisterColumn, ...] = (
    RegisterColumn("ordinal", "#", optional=False),
    RegisterColumn("project", "Project", optional=False),
    RegisterColumn("code", "Project code", optional=False),
    RegisterColumn("hub", "Hub"),
    RegisterColumn("category", "Category"),
    RegisterColumn("type", "Type"),
    RegisterColumn("charter-plant", "Plant", default=False),
    RegisterColumn("charter-requesting_department", "Req. dept", default=False),
    RegisterColumn("charter-product_type", "Product type", default=False),
    RegisterColumn("status", "Status"),
    RegisterColumn("leader", "Leader"),
    RegisterColumn("actual-start", "Actual start"),
    RegisterColumn("actual-end", "Actual end"),
    RegisterColumn("design-time", "Design time"),
    RegisterColumn("lab-time", "Lab time"),
    RegisterColumn("end-week", "End week"),
    RegisterColumn("current-step", "Current step"),
    RegisterColumn("steps", "Steps"),
    RegisterColumn("priority", "Priority"),
    # P60 (ADR 0068): the page's `rank` column shows the hub rank; the
    # download writes it as "Hub rank" with "Global rank" next to it.
    RegisterColumn("rank", "Hub rank"),
    RegisterColumn("global-rank", "Global rank", follows="rank"),
    RegisterColumn("project-id", "Project ID", optional=False),
)
COLUMN_BY_KEY: Mapping[str, RegisterColumn] = {c.key: c for c in REGISTER_COLUMNS}
#: The keys the `columns` query parameter may name.
SELECTABLE_KEYS: frozenset[str] = frozenset(c.key for c in REGISTER_COLUMNS if c.optional)
#: A file header (normalised) -> column key. The screen's own short labels
#: ("Cat", "End wk", "Steps (click to exclude)", the column menu's "Leader
#: (design resource)") are accepted too, so a hand-made copy also reads.
HEADER_ALIASES: Mapping[str, str] = {
    **{" ".join(c.header.split()).casefold(): c.key for c in REGISTER_COLUMNS},
    "cat": "category",
    "end wk": "end-week",
    "steps (click to exclude)": "steps",
    "leader (design resource)": "leader",
    "code": "code",
    # P60: a download made before ADR 0068 has one "Rank" column, which held
    # the full-band (global) rank.
    "rank": "global-rank",
}
#: Text of the Steps cell when the project excludes no step.
ALL_STEPS_TEXT = "All included"
EXCLUDED_PREFIX = "Excluded: "
#: The largest Design / Lab time figure (`schemas.project.EffortWeeks`).
EFFORT_FIGURE_MAX = 9999.99
#: Columns read-only in the import (derived by the app, never an input).
#: P60 (ADR 0068): the hub rank is derived from the global order, so the import
#: reads it as read-only; "Global rank" stays the rank input.
READ_ONLY_KEYS: frozenset[str] = frozenset(
    {"ordinal", "end-week", "steps", "project-id", "rank"}
)


class UnknownColumns(ValueError):
    def __init__(self, keys: Sequence[str]) -> None:
        super().__init__(", ".join(keys))
        self.keys = list(keys)


def resolve_columns(columns: Iterable[str] | None) -> list[RegisterColumn]:
    """The columns of a download, in screen order. `columns` lists the visible
    optional column ids (the page's own ids); None = the screen's default set
    (every hideable column, no charter column). The fixed columns are always
    in. An unknown id raises `UnknownColumns`."""

    if columns is None:
        wanted = {c.key for c in REGISTER_COLUMNS if c.default}
    else:
        given = [str(c) for c in columns]
        unknown = sorted({c for c in given if c not in SELECTABLE_KEYS})
        if unknown:
            raise UnknownColumns(unknown)
        wanted = set(given)
    wanted |= {c.key for c in REGISTER_COLUMNS if c.follows is not None and c.follows in wanted}
    return [c for c in REGISTER_COLUMNS if not c.optional or c.key in wanted]


def _value(v: Any) -> Any:
    return getattr(v, "value", v)


def _weeks_figure(figure: float | None, calculated: int) -> float | int:
    """The Design / Lab time cell: the project's own figure, else the
    calculated weeks (what the screen prints)."""

    if figure is None:
        return int(calculated)
    f = round(float(figure), 2)
    return int(f) if f.is_integer() else f


def _week(week: int | None) -> str | None:
    return None if week is None else week_label(week)


def register_cells(
    row: ProjectFilterRow, ordinal: int, excluded_steps: Sequence[str] | None = None
) -> dict[str, Any]:
    """Every register column's cell for one served row (keyed by column key)."""

    applicable = row.priority_applicable
    step = None
    if row.current_step_code:
        step = row.current_step_code + (
            f" · {row.current_step_name}" if row.current_step_name else ""
        )
    excluded = sorted(excluded_steps or ())
    return {
        "ordinal": ordinal,
        "project": row.project_name,
        "code": row.external_code,
        "hub": _value(row.hub),
        "category": _value(row.category),
        "type": _value(row.type),
        "charter-plant": row.plant,
        "charter-requesting_department": row.requesting_department,
        "charter-product_type": row.product_type,
        "status": _value(row.status),
        "leader": row.leader_name,
        "actual-start": _week(row.actual_start_week),
        "actual-end": _week(row.actual_end_week),
        "design-time": _weeks_figure(row.design_effort_weeks, row.design_weeks_calculated),
        "lab-time": _weeks_figure(row.lab_effort_weeks, row.lab_weeks_calculated),
        "end-week": _week(row.end_week),
        "current-step": step,
        "steps": (EXCLUDED_PREFIX + ", ".join(excluded)) if excluded else ALL_STEPS_TEXT,
        "priority": (PRIORITY_NOT_APPLICABLE_LABEL if not applicable else _value(row.priority)),
        "rank": row.hub_rank if applicable else None,
        "global-rank": row.band_rank if applicable else None,
        "project-id": str(row.project_id),
    }


async def excluded_steps_by_project(
    db: AsyncSession, project_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[str]]:
    """project id -> its excluded step codes (ADR 0049), one query. The ids
    are the served (hub-scoped) rows' own ids."""

    from models.workflow import ProjectWorkflowStep

    if not project_ids:
        return {}
    stmt = select(ProjectWorkflowStep.project_id, ProjectWorkflowStep.step_template_id).where(
        ProjectWorkflowStep.project_id.in_(list(project_ids)),
        ProjectWorkflowStep.excluded.is_(True),
    )
    out: dict[uuid.UUID, list[str]] = {}
    for pid, sid in (await db.execute(stmt)).all():
        out.setdefault(pid, []).append(str(sid))
    return out


# --- reading a cell back (the What-if import) --------------------------------------------------

_WEEK_LABEL = re.compile(r"^w\s*(\d{1,2})\s+(\d{4})$")
_WEEK_SHORT = re.compile(r"^w\s*(\d{1,2})(?:\s+'(\d{2}))?$")
_STEP_LEAD = re.compile(r"^(PDD|OEM)\s*-\s*([A-N])\b", re.IGNORECASE)
_RANK_TAIL = re.compile(r"(\d{1,4})\s*$")


def parse_week(value: Any) -> tuple[int | None, bool]:
    """(absolute week, ok). Blank -> (None, True). Accepts the export's
    "W12 2026", the screen's "W5 '27" / "W12", or a bare absolute week."""

    if value is None or (isinstance(value, str) and not value.strip()):
        return None, True
    if isinstance(value, bool):
        return None, False
    if isinstance(value, int | float):
        if float(value).is_integer() and 1 <= int(value) <= PLAN_YEAR_WEEKS * 20:
            return int(value), True
        return None, False
    s = " ".join(str(value).split()).casefold()
    m = _WEEK_LABEL.match(s)
    if m:
        w, y = int(m.group(1)), int(m.group(2))
        if 1 <= w <= PLAN_YEAR_WEEKS and y >= WEEK_BASE_YEAR:
            return PLAN_YEAR_WEEKS * (y - WEEK_BASE_YEAR) + w, True
        return None, False
    m = _WEEK_SHORT.match(s)
    if m:
        w = int(m.group(1))
        y = WEEK_BASE_YEAR if m.group(2) is None else 2000 + int(m.group(2))
        if 1 <= w <= PLAN_YEAR_WEEKS and y >= WEEK_BASE_YEAR:
            return PLAN_YEAR_WEEKS * (y - WEEK_BASE_YEAR) + w, True
        return None, False
    if re.fullmatch(r"\d{1,4}", s):
        return int(s), True
    return None, False


def parse_step(value: Any) -> tuple[str | None, bool]:
    """(step code "PDD-C", ok) from "PDD-C · Name" / "PDD-C"; blank -> (None, True)."""

    if value is None or (isinstance(value, str) and not value.strip()):
        return None, True
    m = _STEP_LEAD.match(str(value).strip())
    if not m:
        return None, False
    return f"{m.group(1).upper()}-{m.group(2).upper()}", True


def parse_number(value: Any) -> tuple[float | None, bool]:
    """(effort weeks, ok); blank -> (None, True); 0..`EFFORT_FIGURE_MAX` (the
    registration's own bound on a Design / Lab time figure)."""

    if value is None or (isinstance(value, str) and not value.strip()):
        return None, True
    if isinstance(value, bool):
        return None, False
    try:
        num = float(str(value).strip()) if isinstance(value, str) else float(value)
    except ValueError:
        return None, False
    if num != num or num < 0 or num > EFFORT_FIGURE_MAX:  # NaN or out of range
        return None, False
    return round(num, 2), True


def parse_rank(value: Any) -> tuple[int | None, bool]:
    """(band rank, ok) from 3 / "3" / the screen's "P1 · 3"; blank -> (None, True)."""

    if value is None or (isinstance(value, str) and not value.strip()):
        return None, True
    if isinstance(value, bool):
        return None, False
    if isinstance(value, int | float):
        return (int(value), True) if float(value).is_integer() and value >= 1 else (None, False)
    m = _RANK_TAIL.search(str(value).strip())
    if not m or int(m.group(1)) < 1:
        return None, False
    return int(m.group(1)), True


__all__ = [
    "ALL_STEPS_TEXT",
    "COLUMN_BY_KEY",
    "HEADER_ALIASES",
    "READ_ONLY_KEYS",
    "REGISTER_COLUMNS",
    "SELECTABLE_KEYS",
    "RegisterColumn",
    "UnknownColumns",
    "excluded_steps_by_project",
    "parse_number",
    "parse_rank",
    "parse_step",
    "parse_week",
    "register_cells",
    "resolve_columns",
]
