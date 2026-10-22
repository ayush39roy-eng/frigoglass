"""P5-T04 — CSV/XLSX export of every surface's *current view*
(`docs/PROJECT_AND_STACK.md` §2's cross-cutting "Downloads" feature), for
both the synchronous (`api/routers/exports.py`'s default) and async
(`workers/export_tasks.py`, "large export, via MinIO") paths — this module
is the SINGLE shared implementation both call, so RBAC/hub-scope/data-shaping
logic can never drift between the two.

**RBAC + row-level hub scoping — reused, not reimplemented**: every builder
function below calls the SAME async endpoint function each surface's own
router already uses for its normal `GET` read (`api.routers.dashboard.
analytics_projects`, `api.routers.capacity.hub_load_vs_capacity`,
`api.routers.priorities.list_priority_matrix`, `api.routers.gantt.get_gantt`,
`api.routers.projects.list_projects`, `api.routers.engineers.list_engineers`,
`api.routers.chambers.list_chambers`), passing through the exact same
`db`/`current_user` (a real `core.principal.Principal`) it would receive from
FastAPI's own dependency injection. Every one of those functions already
applies `services.hub_scope` filtering and (for Gantt) the GDPR engineer-name
withholding gate (`docs/OPEN_QUESTIONS.md` #8) internally — an export can
therefore never expose a row, or a field, its caller's role/hub scope
wouldn't already let them see via the ordinary read endpoint. This module
does no independent DB querying of its own for row selection; it only
flattens/serialises what those functions already returned.

**Financial fields are exported like any other authorized field, never
logged**: Matrix and Project Registration exports include the encrypted
financial columns (`tcogs_eur`/`selling_price_eur`/`gross_margin_pct`/
`customer_name`, CLAUDE.md's four named fields) exactly because the read
endpoints they reuse already serve them to an authorized caller — this
mirrors `schemas/project.py`'s own stated position ("round-trip ... like any
other field in a normal, authenticated read... 'never logged' is about audit
rows and application logs, not about hiding them from an authorized API
response entirely"). Nothing in this module (or `workers/export_tasks.py`)
ever logs a row's *values* — only surface names, filter parameter echoes, and
row *counts* (see that module's docstring).

**Why raw ORM rows are re-validated into their Pydantic schema here for some
surfaces but not others**: `analytics_projects`/`hub_load_vs_capacity`/
`list_priority_matrix`/`get_gantt` already construct and return real Pydantic
response objects (read directly from source, not assumed) — this module uses
them as-is. `list_projects`/`list_engineers`/`list_chambers` return raw SQLAlchemy
ORM instances (their routers rely on FastAPI's own `response_model`
coercion, which only happens at the HTTP layer — irrelevant when this module
calls them in-process) — this module explicitly re-validates each one through
its own `ProjectListItem.model_validate(...)`/`EngineerRead.model_validate(...)`/
`ChamberRead.model_validate(...)` (all three already `ConfigDict(from_attributes=
True)`) before flattening, so the exported columns match the documented API
response shape exactly, not an accidental raw-ORM `__dict__` dump.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections.abc import Awaitable, Callable, Sequence
from typing import TYPE_CHECKING, Any

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.principal import Principal
from models.engineer import Engineer
from models.enums import (
    CurrencyCode,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
)

if TYPE_CHECKING:
    from models.project import Project
    from schemas.gantt import GanttProjectRow

#: `Sheet name -> (column headers, row dicts)`. A CSV export always picks one
#: sheet (`api/routers/exports.py` chooses which); an XLSX export writes
#: every sheet. Kept as a plain dict (not a dedicated dataclass) since it
#: never leaves this module/its two callers.
ExportSheets = dict[str, tuple[list[str], list[dict[str, Any]]]]

#: `GET /exports/{surface}` query params, and an async job's stored
#: `ExportJob.filters`, are always plain JSON-safe strings (or `None`) —
#: never a typed `uuid.UUID`/enum instance — so the exact same dict shape
#: works whether it came from a FastAPI query param (converted to `str` by
#: the router before calling this module) or was round-tripped through
#: Celery's JSON task-argument serialization. Each builder function below
#: parses its own expected keys back into the typed values the underlying
#: router function actually wants.
ExportFilters = dict[str, str | None]


# --------------------------------------------------------------------------
# Generic CSV/XLSX serialisation
# --------------------------------------------------------------------------


#: P13-F10 (CWE-1236): a text cell starting with one of these is read as a
#: formula (or a DDE payload) by Excel/LibreOffice when the CSV is opened.
_FORMULA_TRIGGERS: tuple[str, ...] = ("=", "+", "-", "@", "\t", "\r")


def _neutralise_formula(text: str) -> str:
    """Prefix `'` to a string that a spreadsheet would treat as a formula.
    Only ever applied to `str` values: a negative number stays a number."""

    if text.startswith(_FORMULA_TRIGGERS):
        return "'" + text
    return text


def _stringify(value: Any) -> Any:
    """Render one cell value for CSV/XLSX: `None` -> empty string, a list
    (e.g. `PriorityMatrixRow.hard_gates`, `EngineerRead.allowed_categories`,
    `ChamberRead.allowed_stages`) -> a comma-joined string (spreadsheet cells
    are scalar), everything else passed through unchanged. Booleans/numbers
    are left as native Python types — both the stdlib `csv` module and
    `openpyxl` render them sensibly (`csv` via `str()`, `openpyxl` writes a
    real numeric/boolean cell type) without help.

    P13-F10: every resulting string that starts with `= + - @ \\t \\r` gets a
    leading `'` (formula-injection guard). Numbers (including negative ones)
    are never prefixed, since they are not strings.
    """

    if value is None:
        return ""
    if isinstance(value, (list, tuple, frozenset, set)):
        return _neutralise_formula(", ".join(str(v) for v in value))
    if isinstance(value, str):
        return _neutralise_formula(value)
    return value


#: ADR 0028 lifted the P13-F12 leader_name withholding; the set is kept (empty)
#: as the switch to withhold export fields again. Text cells still pass
#: through `_neutralise_formula`.
_EXPORT_WITHHELD_FIELDS: frozenset[str] = frozenset()

#: Nested (non-scalar) fields that exports skip: spreadsheet cells are scalar.
#: `dimension_points` is the served per-dimension points map (ADR 0029).
#: `dimension_scores` (the per-dimension list) is not exported as a nested
#: cell; `build_matrix_sheets` flattens it to one column per active rubric
#: dimension (ADR 0037).
_EXPORT_NESTED_FIELDS: frozenset[str] = frozenset({"dimension_points", "dimension_scores"})

#: P25-T03 (ADR 0036): the Matrix export's header for `PriorityMatrixRow.
#: suggested_band`, which is the promoted band (after the P1 capacity fill).
MATRIX_PROMOTED_BAND_HEADER = "suggested_band_after_capacity_fill"


def rows_from_models(
    models_list: Sequence[BaseModel],
) -> tuple[list[str], list[dict[str, Any]]]:
    """`list[SomePydanticModel]` -> `(headers, row dicts)`, using
    `model_dump(mode="json")` so every value is already JSON-safe (UUIDs and
    enums become plain strings) before `_stringify` only has list-flattening
    left to do. Headers are taken from the first row's field *declaration*
    order (`model_fields`, not `model_dump()`'s dict, which as of Pydantic v2
    preserves the same order anyway — declared explicitly here so an empty
    list still needs a model class to derive headers from, which callers
    handle via the empty-list early return below).
    """

    if not models_list:
        return [], []
    fields = [h for h in type(models_list[0]).model_fields if h not in _EXPORT_NESTED_FIELDS]
    rows = [m.model_dump(mode="json", exclude=set(_EXPORT_NESTED_FIELDS)) for m in models_list]
    # P19-T03: a nested model field (e.g. `capacity_weeks: {year, remaining}`)
    # becomes one scalar column per key, `capacity_weeks_year` /
    # `capacity_weeks_remaining`, so a spreadsheet cell never holds a dict.
    headers: list[str] = []
    for h in fields:
        sample = rows[0].get(h)
        if isinstance(sample, dict):
            subs = [f"{h}_{k}" for k in sample]
            headers.extend(subs)
            for row in rows:
                nested = row.pop(h, None) or {}
                for k in sample:
                    row[f"{h}_{k}"] = nested.get(k)
        else:
            headers.append(h)
    return headers, rows


def csv_bytes(headers: list[str], rows: list[dict[str, Any]]) -> bytes:
    """UTF-8 with a BOM (`utf-8-sig`) — Excel (still the overwhelmingly
    likely consumer for a client-facing CSV download, per this app's
    Frigoglass office/on-premise audience) does not reliably auto-detect
    plain UTF-8 without a BOM and otherwise mis-renders non-ASCII characters
    (e.g. accented names in `customer_name`/engineer names).
    """

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=headers, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({h: _stringify(row.get(h)) for h in headers})
    return buffer.getvalue().encode("utf-8-sig")


def _text_cell(worksheet: Any, text: str) -> WriteOnlyCell:
    """P13-F10: a string cell forced to the text type. `openpyxl` otherwise
    stores any string starting with `=` as a live formula."""

    cell = WriteOnlyCell(worksheet, value=text)
    cell.data_type = "s"
    return cell


def _xlsx_cell(worksheet: Any, value: Any) -> Any:
    if isinstance(value, str):
        return _text_cell(worksheet, value)
    return value


def xlsx_bytes(sheets: ExportSheets) -> bytes:
    """One workbook, one sheet per `sheets` entry — `write_only=True` keeps
    memory bounded (streams rows to disk-backed temp storage internally
    rather than building a full in-memory cell graph), per this project's
    `pyproject.toml` P5-T04 comment on why `openpyxl` was chosen. Sheet names
    are truncated to Excel's 31-character sheet-name limit (`openpyxl` itself
    raises `ValueError` past that, so this is a real constraint, not
    defensive-for-its-own-sake).
    """

    workbook = Workbook(write_only=True)
    for sheet_name, (headers, rows) in sheets.items():
        worksheet = workbook.create_sheet(title=sheet_name[:31])
        worksheet.append([_text_cell(worksheet, h) for h in headers])
        for row in rows:
            worksheet.append([_xlsx_cell(worksheet, _stringify(row.get(h))) for h in headers])
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


# --------------------------------------------------------------------------
# Per-surface row builders — each reuses that surface's own read endpoint
# function directly (see module docstring).
# --------------------------------------------------------------------------


async def build_dashboard_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: str | None = None,
    category: str | None = None,
    status_: str | None = None,
    priority: str | None = None,
    region: str | None = None,
    q: str | None = None,
    type_: str | None = None,
    leader_engineer_id: str | None = None,
    current_step: str | None = None,
    sort: str | None = None,
) -> ExportSheets:
    """The Dashboard's own filterable "analytics breakdown" table
    (`docs/PROJECT_AND_STACK.md` §2: "An analytics breakdown with filters (by
    hub, category, status, priority)") — the one genuinely tabular, per-
    project view among Dashboard's several summary widgets, and therefore
    the natural "current view" to export; the pipeline-totals/status-
    overview/hub-type-pipeline widgets are aggregate counts, not row data.
    """

    from api.routers.dashboard import analytics_projects

    result = await analytics_projects(
        hub_id=uuid.UUID(hub_id) if hub_id else None,
        category=ProjectCategory(category) if category else None,
        status_=ProjectStatus(status_) if status_ else None,
        priority=ProjectPriority(priority) if priority else None,
        region=LabRegion(region) if region else None,
        q=q,
        type_=ProjectType(type_) if type_ else None,
        leader_engineer_id=uuid.UUID(leader_engineer_id) if leader_engineer_id else None,
        current_step=current_step,
        sort="priority" if sort == "priority" else "name",
        db=db,
        current_user=principal,
    )
    headers, rows = rows_from_models(result.rows)
    return {"Dashboard": (headers, rows)}


async def build_capacity_sheets(db: AsyncSession, principal: Principal) -> ExportSheets:
    """Hub load vs. capacity — Capacity's headline table. No filters: it is
    already one row per hub in the caller's scope (at most six), so there is
    nothing meaningful to filter further, matching `GET /capacity/hub-load`
    itself (also filter-less).
    """

    from api.routers.capacity import hub_load_vs_capacity

    result = await hub_load_vs_capacity(db=db, current_user=principal)
    headers, rows = rows_from_models(result.rows)
    return {"Capacity": (headers, rows)}


async def build_matrix_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    currency: str | None = None,
    hub_id: str | None = None,
    category: str | None = None,
    region: str | None = None,
) -> ExportSheets:
    """The scoring grid (one column per active rubric dimension, ADR 0037),
    one row per project — Matrix's only tabular view.
    """

    from api.routers.priorities import list_priority_matrix

    rows_models = await list_priority_matrix(
        currency=CurrencyCode(currency) if currency else CurrencyCode.EUR,
        hub_id=uuid.UUID(hub_id) if hub_id else None,
        category=ProjectCategory(category) if category else None,
        region=LabRegion(region) if region else None,
        db=db,
        current_user=principal,
    )
    headers, rows = rows_from_models(rows_models)
    # P26-T01 (ADR 0037): one column per ACTIVE rubric dimension, headed by its
    # key (the 13 migrated keys are the old column names), right after
    # `has_score`, in display order. The rubric reserves every row field name,
    # so a dimension key never collides with another column.
    if rows_models:
        dim_keys = [d.key for d in rows_models[0].dimension_scores]
        at = headers.index("has_score") + 1
        headers = headers[:at] + dim_keys + headers[at:]
        for row, model in zip(rows, rows_models, strict=True):
            row.update({d.key: d.score for d in model.dimension_scores})
    # P25-T03 (ADR 0036): the row's `suggested_band` is the band AFTER the P1
    # capacity fill, so the column says so. `score_band`, `capacity_fill` and
    # `capacity_fill_reason` follow it (declaration order of the row model).
    headers = [MATRIX_PROMOTED_BAND_HEADER if h == "suggested_band" else h for h in headers]
    for row in rows:
        row[MATRIX_PROMOTED_BAND_HEADER] = row.pop("suggested_band", None)
    return {"Matrix": (headers, rows)}


async def _fetch_all_gantt_rows(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: uuid.UUID | None,
    project_id: uuid.UUID | None,
    region: LabRegion | None = None,
) -> list[GanttProjectRow]:
    """`GET /gantt` paginates (`limit`/`offset`, max page size 500,
    `api/routers/gantt.py`) — an export of the "current view" must never
    silently truncate at one page's worth of projects just because the
    live UI happens to page. Loops `get_gantt(...)` with increasing `offset`
    until every matching project (per `total_count`) has been fetched, then
    returns the concatenated `GanttProjectRow` list. At this app's actual
    scale (~236 projects portfolio-wide, per CLAUDE.md) this is at most one
    extra page beyond the first for even a completely unfiltered, unscoped
    (`hub_scope_all`) export.
    """

    from api.routers.gantt import get_gantt

    page_size = 500
    offset = 0
    all_rows: list[GanttProjectRow] = []
    while True:
        response = await get_gantt(
            hub_id=hub_id,
            region=region,
            project_id=project_id,
            limit=page_size,
            offset=offset,
            db=db,
            current_user=principal,
        )
        all_rows.extend(response.rows)
        if len(all_rows) >= response.total_count or not response.rows:
            break
        offset += page_size
    return all_rows


async def build_gantt_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: str | None = None,
    project_id: str | None = None,
    region: str | None = None,
) -> ExportSheets:
    """Flattened project x step rows — one row per workflow step (project-
    level fields repeated on every one of its steps), the natural tabular
    shape for a spreadsheet export of a Gantt (which is itself inherently a
    project x step grid). A project with zero steps in the active schedule
    run (e.g. `LEFT_OUT` before ever being scheduled) still contributes
    exactly one row, with every step-level column blank, so it is not
    silently dropped from the export.
    """

    project_rows = await _fetch_all_gantt_rows(
        db,
        principal,
        hub_id=uuid.UUID(hub_id) if hub_id else None,
        project_id=uuid.UUID(project_id) if project_id else None,
        region=LabRegion(region) if region else None,
    )

    headers = [
        "project_id",
        "project_name",
        "hub",
        "category",
        "priority",
        "leader_name",
        "frozen",
        "delay_weeks",
        "left_out",
        "spillover",
        "cat_not_allowed",
        "step_id",
        "step_name",
        "kind",
        "sequence_order",
        "duration_weeks",
        "planned_start_week",
        "planned_end_week",
        "actual_start_week",
        "actual_end_week",
        "assigned_engineer_name",
        "assigned_chamber_code",
        "eng_conflict",
        "chamber_overlap",
    ]
    rows: list[dict[str, Any]] = []
    for project in project_rows:
        project_fields = {
            "project_id": str(project.project_id),
            "project_name": project.project_name,
            "hub": project.hub.value if hasattr(project.hub, "value") else project.hub,
            "category": project.category.value if project.category else None,
            "priority": project.priority.value if project.priority else None,
            "leader_name": project.leader_name,
            "frozen": project.frozen,
            "delay_weeks": project.delay_weeks,
            "left_out": project.left_out,
            "spillover": project.spillover,
            "cat_not_allowed": project.cat_not_allowed,
        }
        if not project.steps:
            rows.append(
                {
                    **project_fields,
                    **{
                        h: None
                        for h in headers
                        if h not in project_fields
                    },
                }
            )
            continue
        for step in project.steps:
            rows.append(
                {
                    **project_fields,
                    "step_id": step.step_id,
                    "step_name": step.step_name,
                    "kind": step.kind.value if hasattr(step.kind, "value") else step.kind,
                    "sequence_order": step.sequence_order,
                    "duration_weeks": step.duration_weeks,
                    "planned_start_week": step.planned_start_week,
                    "planned_end_week": step.planned_end_week,
                    "actual_start_week": step.actual_start_week,
                    "actual_end_week": step.actual_end_week,
                    "assigned_engineer_name": step.assigned_engineer_name,
                    "assigned_chamber_code": step.assigned_chamber_code,
                    "eng_conflict": step.eng_conflict,
                    "chamber_overlap": step.chamber_overlap,
                }
            )
    return {"Gantt": (headers, rows)}


async def _fetch_all_projects(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: uuid.UUID | None,
    category: ProjectCategory | None,
    status_: ProjectStatus | None,
    priority: ProjectPriority | None,
    type_: ProjectType | None,
    q: str | None = None,
) -> list[Project]:
    """Same "never silently truncate at one page" pagination loop as
    `_fetch_all_gantt_rows`, for `GET /projects`'s own `limit`/`offset` (max
    500).
    """

    from api.routers.projects import list_projects

    page_size = 500
    offset = 0
    all_projects: list[Project] = []
    while True:
        page = await list_projects(
            hub_id=hub_id,
            category=category,
            status_=status_,
            priority=priority,
            type_=type_,
            q=q,
            limit=page_size,
            offset=offset,
            db=db,
            current_user=principal,
        )
        all_projects.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return all_projects


async def build_project_registration_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: str | None = None,
    category: str | None = None,
    status_: str | None = None,
    priority: str | None = None,
    type_: str | None = None,
    q: str | None = None,
) -> ExportSheets:
    from schemas.project import ProjectListItem

    projects = await _fetch_all_projects(
        db,
        principal,
        hub_id=uuid.UUID(hub_id) if hub_id else None,
        category=ProjectCategory(category) if category else None,
        status_=ProjectStatus(status_) if status_ else None,
        priority=ProjectPriority(priority) if priority else None,
        type_=ProjectType(type_) if type_ else None,
        q=q,
    )
    headers, rows = rows_from_models([ProjectListItem.model_validate(p) for p in projects])
    # ADR 0028: the leader name is exported (text cells pass `_neutralise_formula`).
    leader_ids = {p.leader_engineer_id for p in projects if p.leader_engineer_id}
    names: dict[uuid.UUID, str] = {}
    if leader_ids:
        names = {
            e.id: e.name
            for e in (
                await db.execute(select(Engineer).where(Engineer.id.in_(leader_ids)))
            ).scalars()
        }
    headers = [*headers, "leader_name"]
    for row in rows:
        lid = row.get("leader_engineer_id")
        row["leader_name"] = names.get(uuid.UUID(str(lid))) if lid else None
    return {"Projects": (headers, rows)}


async def build_capacity_planning_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: str | None = None,
) -> ExportSheets:
    """Two sheets, always both generated regardless of format — Capacity
    Planning is the one surface covering two distinct entities (Engineer,
    Chamber). `api/routers/exports.py`'s CSV path (a single flat file)
    additionally accepts an `entity` selector to pick exactly one of these
    two sheets; the XLSX path always includes both. `hub_id` only narrows
    the Engineers sheet — `Chamber` has no `hub_id` column at all (a lab
    region is shared by up to four hubs, per `services/hub_scope.py`'s
    module docstring), matching `api/routers/chambers.py::list_chambers`'s
    own signature (no `hub_id` parameter).
    """

    from api.routers.chambers import list_chambers
    from api.routers.engineers import list_engineers
    from schemas.chamber import ChamberRead
    from schemas.engineer import EngineerRead

    engineers = await list_engineers(
        hub_id=uuid.UUID(hub_id) if hub_id else None, db=db, current_user=principal
    )
    chambers = await list_chambers(db=db, current_user=principal)

    eng_headers, eng_rows = rows_from_models([EngineerRead.model_validate(e) for e in engineers])
    ch_headers, ch_rows = rows_from_models([ChamberRead.model_validate(c) for c in chambers])
    return {
        "Engineers": (eng_headers, eng_rows),
        "Chambers": (ch_headers, ch_rows),
    }


_BuilderFn = Callable[..., Awaitable[ExportSheets]]

#: Dispatch table keyed by `models.enums.ExportSurface.value` — the SINGLE
#: place both `api/routers/exports.py` (sync path) and
#: `workers/export_tasks.py` (async path) resolve "which surface" to "which
#: builder", so the two paths structurally cannot diverge on which surfaces
#: exist or what each one does.
_BUILDERS: dict[str, _BuilderFn] = {
    "dashboard": build_dashboard_sheets,
    "capacity": build_capacity_sheets,
    "matrix": build_matrix_sheets,
    "gantt": build_gantt_sheets,
    "project_registration": build_project_registration_sheets,
    "capacity_planning": build_capacity_planning_sheets,
}


async def build_export_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    surface: str,
    filters: ExportFilters,
) -> ExportSheets:
    """The one function both the synchronous export endpoints and the async
    Celery export task call. `filters` must contain only the keys the given
    surface's builder function accepts (each `api/routers/exports.py`
    endpoint constructs exactly that shape for its own surface) — an unknown
    key raises `TypeError` from the underlying call, deliberately not
    silently ignored.
    """

    builder = _BUILDERS.get(surface)
    if builder is None:
        raise ValueError(f"Unknown export surface: {surface!r}")
    return await builder(db, principal, **filters)
