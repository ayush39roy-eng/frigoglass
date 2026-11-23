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
import re
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.principal import Principal
from models.engineer import Engineer
from models.enums import (
    CurrencyCode,
    LabRegion,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
)
from scheduling.weeks import WEEK_BASE_YEAR
from services import plan_clock
from services.category_type_filter import UNMAPPED, as_list
from services.priority_applicability import (
    NOT_APPLICABLE_FILTER,
    PRIORITY_NOT_APPLICABLE_LABEL,
    PriorityFilterValue,
)
from services.xlsx_writer import (
    FORMULA_TRIGGERS,
    OUTCOME_STYLES,
    GanttChart,
    GanttProjectBar,
    GanttStepBar,
    SheetBook,
    SummaryBlock,
    header_labels,
    humanize,
    stringify,
    write_workbook,
)
from services.xlsx_writer import neutralise_formula as neutralise_formula

if TYPE_CHECKING:
    from schemas.gantt import GanttProjectRow
    from schemas.project import ProjectListItem

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
#: P31: a multi-select filter (`category`, `type_`) is stored as a bare string
#: for one value (the pre-P31 shape) and a list for several. ADR 0051: the same
#: for `hub_id`, `region`, `status_`, `priority`, `leader_engineer_id` and
#: `current_step`, so a single-value job's stored filters are unchanged.
ExportFilters = dict[str, str | list[str] | None]

#: A persisted multi-select filter value (see `ExportFilters`).
_ListFilter = str | list[str] | None


def _categories(value: _ListFilter, *, allow_unmapped: bool = False) -> list[Any]:
    """A stored `category` filter as the route's list (pre-P31 bare string or
    P31 list). `Unmapped` passes through only where the route admits it.
    P33-T07: category codes are strings (the `categories` table); a stored
    value was checked against the table when the job was created."""

    return [v for v in as_list(value) if allow_unmapped or v != UNMAPPED]


def _types(value: _ListFilter, *, allow_unmapped: bool = False) -> list[Any]:
    """A stored `type_` filter as the route's list (see `_categories`)."""

    return [v if allow_unmapped and v == UNMAPPED else ProjectType(v) for v in as_list(value)]


def _uuids(value: _ListFilter) -> list[uuid.UUID]:
    """ADR 0051: a stored id filter (`hub_id`, `leader_engineer_id`) as the
    route's list; a pre-ADR-0051 bare string reads as one value."""

    return [uuid.UUID(v) for v in as_list(value)]


def _regions(value: _ListFilter) -> list[LabRegion]:
    return [LabRegion(v) for v in as_list(value)]


def _statuses(value: _ListFilter) -> list[ProjectStatus]:
    return [ProjectStatus(v) for v in as_list(value)]


def _priorities(value: _ListFilter) -> list[PriorityFilterValue]:
    # ADR 0067: `not_applicable` passes through (Commercialized / Cancelled).
    return [
        NOT_APPLICABLE_FILTER if v == NOT_APPLICABLE_FILTER else ProjectPriority(v)
        for v in as_list(value)
    ]


# --------------------------------------------------------------------------
# Generic CSV/XLSX serialisation
# --------------------------------------------------------------------------


#: P13-F10 (CWE-1236) guard and cell rendering live in `services.xlsx_writer`
#: (P43, ADR 0057); the old private names stay for existing callers.
_FORMULA_TRIGGERS: tuple[str, ...] = FORMULA_TRIGGERS
_neutralise_formula = neutralise_formula
_stringify = stringify


#: ADR 0028 lifted the P13-F12 leader_name withholding; the set is kept (empty)
#: as the switch to withhold export fields again. Text cells still pass
#: through `_neutralise_formula`.
_EXPORT_WITHHELD_FIELDS: frozenset[str] = frozenset()

#: Nested (non-scalar) fields that exports skip: spreadsheet cells are scalar.
#: `dimension_points` is the served per-dimension points map (ADR 0029).
#: `dimension_scores` (the per-dimension list) is not exported as a nested
#: cell; `build_matrix_sheets` flattens it to one column per active rubric
#: dimension (ADR 0037).
#: ADR 0038: `tag_dimension_keys` is a UI hint derived from `scoring_tags`
#: (which IS exported), so it is skipped too.
_EXPORT_NESTED_FIELDS: frozenset[str] = frozenset(
    {"dimension_points", "dimension_scores", "tag_dimension_keys"}
)

#: P25-T03 (ADR 0036): the Matrix export's header for `PriorityMatrixRow.
#: suggested_band`, which is the promoted band (after the P1 capacity fill).
MATRIX_PROMOTED_BAND_HEADER = "suggested_band_after_capacity_fill"


def rows_from_models(
    models_list: Sequence[BaseModel],
    model_cls: type[BaseModel] | None = None,
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
        # P43-R02: an empty table still gets its header row (from the row
        # model's fields when the caller names it; nested fields unexpanded).
        if model_cls is None:
            return [], []
        return [h for h in model_cls.model_fields if h not in _EXPORT_NESTED_FIELDS], []
    fields = [h for h in type(models_list[0]).model_fields if h not in _EXPORT_NESTED_FIELDS]
    rows = [m.model_dump(mode="json", exclude=set(_EXPORT_NESTED_FIELDS)) for m in models_list]
    # P19-T03: a nested model field (e.g. `capacity_weeks: {year, remaining}`)
    # becomes one scalar column per key, `capacity_weeks_year` /
    # `capacity_weeks_remaining`, so a spreadsheet cell never holds a dict.
    headers: list[str] = []
    for h in fields:
        # P43: the first row that HAS the nested value decides (a nullable
        # nested field, e.g. the Matrix `last_score_version`, is None on some
        # rows; keying on row 0 alone left later dicts unflattened and the
        # xlsx writer refused them).
        sample = next((r[h] for r in rows if isinstance(r.get(h), dict)), rows[0].get(h))
        if isinstance(sample, dict):
            subs = [f"{h}_{k}" for k in sample]
            headers.extend(subs)
            for row in rows:
                nested = row.pop(h, None) or {}
                for k in sample:
                    row[f"{h}_{k}"] = nested.get(k)
        else:
            headers.append(h)
    _not_applicable_cells(rows)
    return headers, rows


#: ADR 0067: the served priority columns that read "Not applicable" on a row
#: whose `priority_applicable` is false (Commercialized / Cancelled).
_PRIORITY_CELLS: tuple[str, ...] = ("priority", "set_priority", "priority_at_run")
NA_PRIORITY = PRIORITY_NOT_APPLICABLE_LABEL


def _bucket_word(bucket: str) -> str:
    """A capacity split key as an export word (ADR 0067: `NA` reads
    "Not applicable"; the band keys are unchanged)."""

    return PRIORITY_NOT_APPLICABLE_LABEL if bucket == "NA" else bucket


def _not_applicable_cells(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        if row.get("priority_applicable") is False:
            for key in _PRIORITY_CELLS:
                if key in row:
                    row[key] = NA_PRIORITY


def csv_bytes(
    headers: list[str],
    rows: list[dict[str, Any]],
    labels: Mapping[str, str] | None = None,
) -> bytes:
    """UTF-8 with a BOM (`utf-8-sig`) — Excel (still the overwhelmingly
    likely consumer for a client-facing CSV download, per this app's
    Frigoglass office/on-premise audience) does not reliably auto-detect
    plain UTF-8 without a BOM and otherwise mis-renders non-ASCII characters
    (e.g. accented names in `customer_name`/engineer names).

    P43 (ADR 0057 D1): the header row carries the human column names
    (`xlsx_writer.header_labels`); the values are unchanged.
    """

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header_labels(headers, labels))
    for row in rows:
        writer.writerow([_stringify(row.get(h)) for h in headers])
    return buffer.getvalue().encode("utf-8-sig")


def xlsx_bytes(sheets: ExportSheets) -> bytes:
    """P43 (ADR 0057 D1): every workbook goes through the styled writer
    (`services.xlsx_writer.write_workbook`): title block, human headers,
    frozen panes, auto-filter, widths, Yes / No, banding, print setup, and a
    drawn Gantt sheet for each `SheetBook.charts` entry. Write-only, so
    memory stays bounded. Sheet names are truncated to Excel's 31
    characters. Text cells stay text (P13-F10)."""

    return write_workbook(sheets)


# --------------------------------------------------------------------------
# Per-surface row builders — each reuses that surface's own read endpoint
# function directly (see module docstring).
# --------------------------------------------------------------------------


#: P43 rework: the first sheet of every surface export.
SUMMARY_SHEET = "Summary"
#: P53 (R53-3): the dashboard export's delivery-by-year sheet.
DELIVERY_SHEET = "Delivery by year"

_PRIORITIES: tuple[str, ...] = ("P1", "P2", "P3", "P4", "Q")
#: R42-6 bucket -> its words, in the Dashboard's order.
_BUCKET_WORDS: tuple[tuple[str, str], ...] = (
    ("WITHIN_YEAR", "Within year"),
    ("SPILLOVER", "Spillover"),
    ("LEFT_OUT", "Spillover · unplaced"),
    ("BLOCKED", "Blocked"),
    ("QUEUED", "Queued (P3)"),
    ("NOT_SCHEDULED_PRIORITY", "Not scheduled (P4)"),
)


def _value(v: Any) -> str:
    return str(getattr(v, "value", v)) if v is not None else "(none)"


def _tally(rows: Sequence[Any], attr: str, order: Sequence[str] = ()) -> list[list[Any]]:
    """[[value, count]] over served rows (dicts or models), `order` first."""

    counts: dict[str, int] = {}
    for r in rows:
        v = r.get(attr) if isinstance(r, dict) else getattr(r, attr, None)
        key = _value(v)
        counts[key] = counts.get(key, 0) + 1
    keys = [k for k in order if k in counts] + sorted(k for k in counts if k not in order)
    return [[k, counts[k]] for k in keys]


def _share(part: int, whole: int) -> float:
    return round(part * 100 / whole, 2) if whole else 0.0


def _band_identity_note(cw: Any) -> str:
    """P43-R01 (workflow A1): copy only. The served band `counting_total`
    (total − queued − not scheduled) also holds On Hold / Cancelled / Draft
    projects and projects without a run outcome, unlike the headline
    denominator; the note states the served identity."""

    counted = sum(b.counting_total for b in cw.priority_delivery)
    other = counted - cw.counting_outcome_count
    return (
        f"Counted, all bands: {counted} = {cw.counting_outcome_count} in the headline "
        f"denominator + {other} not in the plan (on hold, cancelled, draft, data error "
        "or no run outcome). Each band's within-year % uses its counted figure."
    )


async def _dashboard_summary(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: _ListFilter,
    category: _ListFilter,
    region: _ListFilter,
    type_: _ListFilter,
) -> tuple[list[SummaryBlock], list[SummaryBlock]]:
    """The served P42 delivery figures (`GET /dashboard/completing-within-year`,
    the Dashboard's own KPI read), as small tables; and (P53, R53-3) the
    served delivery-by-year table for its own sheet (I59: the same function's
    output as the Dashboard and Executive)."""

    from api.routers.dashboard import completing_within_year

    cw = await completing_within_year(
        hub_id=_uuids(hub_id),
        region=_regions(region),
        category=_categories(category, allow_unmapped=True),
        type_=_types(type_, allow_unmapped=True),
        db=db,
        current_user=principal,
    )
    version = (
        f"Schedule run v{cw.schedule_run_version}"
        if cw.has_active_schedule_run
        else "No active schedule run"
    )
    headline = SummaryBlock(
        title=f"Delivery this year ({version})",
        headers=["Measure", "Projects"],
        rows=[
            ["Within year", cw.within_year_count],
            ["Spillover", cw.spillover_count],
            ["Spillover · unplaced", cw.left_out_count],
            ["Blocked", cw.blocked_count],
            ["Counting projects (the denominator)", cw.counting_outcome_count],
            ["Within-year share", cw.within_year_share_pct],
            ["Queued (P3) — not counted this year", cw.queued_count],
            ["Not scheduled (P4)", cw.not_scheduled_priority_count],
            ["Not in the plan (status) or data error", cw.excluded_count],
        ],
        note="Served figures (P42). The within-year % counts counting projects only.",
        percent_cells=frozenset({(5, 1)}),
    )
    by_priority = SummaryBlock(
        title="By priority",
        # The share is the last column (H), as in the hub and country tables.
        headers=["Priority", "Meaning", "Projects",
                 "Counted (incl. on hold / cancelled)", "Within year", "Queued",
                 "Not scheduled (P4)", "Within-year share"],
        rows=[
            [_value(b.priority), b.priority_label, b.total, b.counting_total, b.within_year,
             b.queued_total, b.not_scheduled_priority_total, b.within_year_share_pct]
            for b in cw.priority_delivery
        ],
        percent_columns=frozenset({7}),
        note=_band_identity_note(cw),
    )  # fmt: skip
    hubs: dict[str, dict[str, int]] = {}
    for r in cw.rows:
        bucket = hubs.setdefault(_value(r.hub), {})
        key = r.outcome or "NONE"
        bucket[key] = bucket.get(key, 0) + 1
    hub_rows: list[list[Any]] = []
    for hub in sorted(hubs):
        c = hubs[hub]
        counting = sum(c.get(k, 0) for k in ("WITHIN_YEAR", "SPILLOVER", "LEFT_OUT", "BLOCKED"))
        hub_rows.append(
            [hub, *(c.get(k, 0) for k, _ in _BUCKET_WORDS),
             _share(c.get("WITHIN_YEAR", 0), counting)]
        )  # fmt: skip
    by_hub = SummaryBlock(
        title="By hub",
        headers=["Hub", *(w for _, w in _BUCKET_WORDS), "Within-year share"],
        rows=hub_rows,
        percent_columns=frozenset({len(_BUCKET_WORDS) + 1}),
        note="Each project's served outcome bucket, counted per hub.",
    )
    by_country = SummaryBlock(
        title="By country (lab region)",
        headers=["Country", *(w for _, w in _BUCKET_WORDS), "Within-year share"],
        rows=[
            [_value(g.region), g.within_year_count, g.spillover_count, g.left_out_count,
             g.blocked_count, g.queued_count, g.not_scheduled_priority_count,
             _share(g.within_year_count, g.within_year_count + g.spillover_count
                    + g.left_out_count + g.blocked_count)]
            for g in cw.regions
        ],
        percent_columns=frozenset({len(_BUCKET_WORDS) + 1}),
    )  # fmt: skip
    return [headline, by_priority, by_hub, by_country], delivery_by_year_blocks(cw)


def delivery_by_year_blocks(cw: Any) -> list[SummaryBlock]:
    """The "Delivery by year" sheet (P53, R53-3): the served table as is."""

    table = cw.delivery_by_year
    if table is None:
        reason = (
            cw.rules_label
            if cw.delivery_by_year_unavailable == "pre_p53_run"
            else "No active schedule run."
        )
        return [
            SummaryBlock(
                title="Delivery by year",
                headers=["Note"],
                rows=[[reason or "Not available."]],
            )
        ]
    rows: list[list[Any]] = []
    for r in table.rows:
        label = f"{r.label} (indicative)" if r.indicative else r.label
        rows.append(
            [label, r.p1, r.p2, r.p3, r.other, r.total,
             r.cum_p1, r.cum_p2, r.cum_p3, r.cum_other, r.cum_total]
        )  # fmt: skip
    reasons = next((r.left_out_reasons for r in table.rows if r.left_out_reasons), None)
    note = (
        f"Not placed: no leader {reasons.no_leader}, no chamber {reasons.no_chamber}, "
        f"data error {reasons.data_error}, beyond the search limit {reasons.beyond_horizon}."
        if reasons is not None
        else None
    )
    return [
        SummaryBlock(
            title=f"Delivery by year (from {table.base_year}, search limit "
            f"{table.horizon_years or '?'} years)",
            headers=["Year", "P1", "P2", "P3", "Other", "Total",
                     "Cumulative P1", "Cumulative P2", "Cumulative P3", "Cumulative other",
                     "Cumulative total"],
            rows=rows,
            note=note,
        )
    ]  # fmt: skip


async def build_dashboard_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: _ListFilter = None,
    category: _ListFilter = None,
    status_: _ListFilter = None,
    priority: _ListFilter = None,
    region: _ListFilter = None,
    q: str | None = None,
    type_: _ListFilter = None,
    leader_engineer_id: _ListFilter = None,
    current_step: _ListFilter = None,
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
        hub_id=_uuids(hub_id),
        category=_categories(category, allow_unmapped=True),
        status_=_statuses(status_),
        priority=_priorities(priority),
        region=_regions(region),
        q=q,
        type_=_types(type_, allow_unmapped=True),
        leader_engineer_id=_uuids(leader_engineer_id),
        current_step=as_list(current_step),
        sort="priority" if sort == "priority" else "name",
        db=db,
        current_user=principal,
        clock=plan_clock.now(),
    )
    from schemas.dashboard import ProjectFilterRow

    headers, rows = rows_from_models(result.rows, ProjectFilterRow)
    summary, delivery = await _dashboard_summary(
        db, principal, hub_id=hub_id, category=category, region=region, type_=type_
    )
    return SheetBook(
        {"Dashboard": (headers, rows)},
        title="Dashboard — project analytics",
        context=[f"{len(rows)} project(s)"],
        summaries={SUMMARY_SHEET: summary, DELIVERY_SHEET: delivery},
        order=[SUMMARY_SHEET, DELIVERY_SHEET, "Dashboard"],
    )


async def build_capacity_sheets(db: AsyncSession, principal: Principal) -> ExportSheets:
    """Hub load vs. capacity — Capacity's headline table. No filters: it is
    already one row per hub in the caller's scope (at most six), so there is
    nothing meaningful to filter further, matching `GET /capacity/hub-load`
    itself (also filter-less).
    """

    from api.routers.capacity import hub_load_vs_capacity
    from schemas.capacity import HubCapacityRow

    result = await hub_load_vs_capacity(db=db, current_user=principal, clock=plan_clock.now())
    headers, rows = rows_from_models(result.rows, HubCapacityRow)
    # P43-R02 (QA G2): the per-priority load splits as words.
    labels = {
        h: f"{m.group(1).capitalize()} load {_bucket_word(m.group(2))} (weeks)"
        for h in headers
        if (m := re.match(r"^(design|lab)_load_by_priority_(\w+)$", h))
    }
    # P45-T01: the full-year demand and remaining demand splits, and the
    # D45-2 "to finish" figures, as words.
    for h in headers:
        if m := re.match(r"^(design|lab)_(demand|remaining)_by_priority_(\w+)$", h):
            basis = "full-year demand" if m.group(2) == "demand" else "remaining demand"
            labels[h] = f"{m.group(1).capitalize()} {basis} {_bucket_word(m.group(3))} (weeks)"
        elif m := re.match(r"^(design|lab)_need_(p1|p1_p2)_weeks$", h):
            which = "P1" if m.group(2) == "p1" else "P1 + P2"
            labels[h] = f"{m.group(1).capitalize()} still needed to finish {which} (weeks)"
    # P29 (ADR 0042): one readable cell for the capacity hub's members
    # breakdown. ADR 0041 R12: demand (full year / remaining) and booked, e.g.
    # "R&D-Greece 6 project(s) 77 wk demand, 60 wk remaining, 30 wk booked; ...".
    for row in rows:
        row["members"] = "; ".join(
            f"{m['hub']} {m['project_count']} project(s) {m['design_load_weeks']} wk demand, "
            f"{m['design_load_remaining_weeks']} wk remaining, "
            f"{m['design_load_booked_weeks']} wk booked"
            for m in row.get("members") or []
        )
        # P43 rework: one readable cell for the chambers too.
        row["chambers"] = "; ".join(
            f"{c['code']} ({c['platforms']} platform(s))" for c in row.get("chambers") or []
        )
    summary = [
        SummaryBlock(
            title="Booked capacity per capacity hub",
            headers=["Hub", "Design booked % (year)", "Design status (year)",
                     "Design booked % (remaining)", "Lab booked % (year)", "Lab status (year)",
                     "Lab booked % (remaining)"],
            rows=[
                [_value(m.hub), m.design_booked_pct_year,
                 humanize(_value(m.design_booking_status_year)),
                 m.design_booked_pct_remaining, m.lab_booked_pct_year,
                 humanize(_value(m.lab_booking_status_year)), m.lab_booked_pct_remaining]
                for m in result.rows
            ],
            percent_columns=frozenset({1, 3, 4, 6}),
            note="Served booked % and booking status (ADR 0016).",
        )
    ]  # fmt: skip
    return SheetBook(
        {"Capacity": (headers, rows)},
        title="Capacity — hub load vs capacity",
        context=[f"{len(rows)} capacity hub(s)"],
        labels=labels,
        summaries={SUMMARY_SHEET: summary},
        order=[SUMMARY_SHEET, "Capacity"],
    )


async def build_matrix_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    currency: str | None = None,
    hub_id: _ListFilter = None,
    category: _ListFilter = None,
    region: _ListFilter = None,
    type_: _ListFilter = None,
) -> ExportSheets:
    """The scoring grid (one column per active rubric dimension, ADR 0037),
    one row per project — Matrix's only tabular view.
    """

    from api.routers.priorities import list_priority_matrix

    rows_models = await list_priority_matrix(
        currency=CurrencyCode(currency) if currency else CurrencyCode.EUR,
        hub_id=_uuids(hub_id),
        category=_categories(category),
        type_=_types(type_),
        region=_regions(region),
        db=db,
        current_user=principal,
        clock=plan_clock.now(),
    )
    from schemas.priority import PriorityMatrixRow

    headers, rows = rows_from_models(rows_models, PriorityMatrixRow)
    # P26-T01 (ADR 0037): one column per ACTIVE rubric dimension, headed by its
    # key (the 13 migrated keys are the old column names), right after
    # `has_score`, in display order. The rubric reserves every row field name,
    # so a dimension key never collides with another column.
    labels: dict[str, str] = {}
    if rows_models:
        dim_keys = [d.key for d in rows_models[0].dimension_scores]
        # P43: a dimension column is headed by its rubric label.
        labels = {d.key: d.label for d in rows_models[0].dimension_scores if d.label}
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
    scored = sum(1 for m in rows_models if m.has_score)
    promoted = sum(1 for m in rows_models if m.capacity_fill)
    summary = [
        SummaryBlock(
            title="Scoring",
            headers=["Measure", "Projects"],
            rows=[
                ["Projects", len(rows_models)],
                ["Scored", scored],
                ["Not scored", len(rows_models) - scored],
                [
                    "Promoted to P1 by the capacity fill",
                    promoted,
                ],
            ],
        ),
        SummaryBlock(
            title="Suggested band (after P1 capacity fill)",
            headers=["Band", "Projects"],
            rows=_tally(rows_models, "suggested_band", _PRIORITIES),
        ),
        SummaryBlock(
            title="Set priority",
            headers=["Priority", "Projects"],
            rows=_tally(rows, "set_priority", _PRIORITIES),
        ),
    ]
    return SheetBook(
        {"Matrix": (headers, rows)},
        title="Matrix — prioritisation scores",
        context=[f"{len(rows)} project(s)", f"Currency: {currency or 'EUR'}"],
        labels=labels,
        summaries={SUMMARY_SHEET: summary},
        order=[SUMMARY_SHEET, "Matrix"],
    )


async def _fetch_all_gantt_rows(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: list[uuid.UUID],
    project_id: uuid.UUID | None,
    region: list[LabRegion] | None = None,
    category: list[str] | None = None,
    type_: list[ProjectType] | None = None,
    meta: dict[str, Any] | None = None,
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
    # P37-T04: one clock reading for every page of the export (I40).
    clock = plan_clock.now()
    while True:
        response = await get_gantt(
            hub_id=hub_id,
            region=region,
            project_id=project_id,
            category=category,
            type_=type_,
            limit=page_size,
            offset=offset,
            db=db,
            current_user=principal,
            clock=clock,
        )
        all_rows.extend(response.rows)
        if meta is not None:
            # P43: the title block's run version and the chart's current week.
            meta["schedule_run_version"] = response.schedule_run_version
            meta["current_week"] = response.current_week or clock.week
            # P53: the chart's week columns start at absolute week 1, the
            # first week of the week base year (R53-1).
            meta["plan_year"] = WEEK_BASE_YEAR
        if len(all_rows) >= response.total_count or not response.rows:
            break
        offset += page_size
    return all_rows


async def build_gantt_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: _ListFilter = None,
    project_id: str | None = None,
    region: _ListFilter = None,
    category: _ListFilter = None,
    type_: _ListFilter = None,
) -> ExportSheets:
    """Flattened project x step rows — one row per workflow step (project-
    level fields repeated on every one of its steps), the natural tabular
    shape for a spreadsheet export of a Gantt (which is itself inherently a
    project x step grid). A project with zero steps in the active schedule
    run (e.g. `LEFT_OUT` before ever being scheduled) still contributes
    exactly one row, with every step-level column blank, so it is not
    silently dropped from the export.
    """

    meta: dict[str, Any] = {}
    project_rows = await _fetch_all_gantt_rows(
        db,
        principal,
        hub_id=_uuids(hub_id),
        project_id=uuid.UUID(project_id) if project_id else None,
        region=_regions(region),
        category=_categories(category),
        type_=_types(type_),
        meta=meta,
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
        # P42 (ADR 0056 R42-6, docs/API_CONTRACT_P42.md §8): the stored flags.
        "counts_toward_year",
        "not_scheduled_priority",
        "step_id",
        "step_name",
        "kind",
        # P43-R01 (workflow A3): a skipped step has weeks but no drawn bar.
        "skipped",
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
            "category": project.category,
            # ADR 0067: "Not applicable" for a Commercialized / Cancelled project.
            "priority": (
                (project.priority.value if project.priority else None)
                if project.priority_applicable
                else PRIORITY_NOT_APPLICABLE_LABEL
            ),
            "leader_name": project.leader_name,
            "frozen": project.frozen,
            "delay_weeks": project.delay_weeks,
            "left_out": project.left_out,
            "spillover": project.spillover,
            "cat_not_allowed": project.cat_not_allowed,
            "counts_toward_year": project.counts_toward_year,
            "not_scheduled_priority": project.not_scheduled_priority,
        }
        if not project.steps:
            rows.append(
                {
                    **project_fields,
                    **{h: None for h in headers if h not in project_fields},
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
                    "skipped": step.skipped,
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
    version = meta.get("schedule_run_version")
    context = [
        f"Schedule run v{version}" if version is not None else "No active schedule run",
        f"{len(project_rows)} project(s)",
    ]
    ranks, statuses = await _project_meta(db, [p.project_id for p in project_rows])
    chart = gantt_chart_from_rows(
        project_rows,
        title="Gantt — schedule",
        current_week=meta.get("current_week"),
        base_year=meta.get("plan_year"),
        context=context,
        ranks=ranks,
        statuses=statuses,
    )
    outcome_words = dict(_BUCKET_WORDS)
    pinned = sum(1 for p in project_rows for st in p.steps if st.pinned)
    summary = [
        SummaryBlock(
            title="Projects by outcome (active run)",
            headers=["Outcome", "Projects"],
            rows=[
                [outcome_words.get(k, k) if k != "(none)" else "No run outcome", n]
                for k, n in _tally(project_rows, "outcome", [b for b, _ in _BUCKET_WORDS])
            ],
            note="Each project's served outcome (P42 buckets).",
        ),
        SummaryBlock(
            title="Projects by priority",
            headers=["Priority", "Projects"],
            rows=_tally(
                [
                    {"priority": p.priority if p.priority_applicable else NA_PRIORITY}
                    for p in project_rows
                ],
                "priority",
                _PRIORITIES,
            ),
        ),
        SummaryBlock(
            title="Steps",
            headers=["Measure", "Steps"],
            rows=[
                ["Steps placed", sum(1 for p in project_rows for st in p.steps if not st.skipped)],
                ["Steps skipped", sum(1 for p in project_rows for st in p.steps if st.skipped)],
                [
                    "Steps on a pinned week",
                    pinned,
                ],
            ],
        ),
    ]
    return SheetBook(
        {GANTT_DATA_SHEET: (headers, rows)},
        title="Gantt — schedule data",
        context=context,
        charts={GANTT_SHEET: chart},
        summaries={SUMMARY_SHEET: summary},
        order=[SUMMARY_SHEET, GANTT_SHEET, GANTT_DATA_SHEET],
    )


async def _project_meta(
    db: AsyncSession, ids: Sequence[uuid.UUID]
) -> tuple[dict[uuid.UUID, int | None], dict[uuid.UUID, str]]:
    """The projects' band ranks (ADR 0050, the chart's order) and statuses
    (P43-R02 G5: the Delivered section). The ids come from the hub-scoped
    `GET /gantt` rows."""

    from models.project import Project

    if not ids:
        return {}, {}
    rows = (
        await db.execute(
            select(Project.id, Project.band_rank, Project.status).where(Project.id.in_(list(ids)))
        )
    ).all()
    return (
        {pid: rank for pid, rank, _ in rows},
        {pid: _value(status) for pid, _, status in rows},
    )


async def _hub_name_map(db: AsyncSession, ids: set[Any]) -> dict[str, str]:
    from models.hub import Hub

    wanted = [i for i in ids if i is not None]
    if not wanted:
        return {}
    rows = await db.execute(select(Hub.id, Hub.name).where(Hub.id.in_(wanted)))
    return {str(hid): _value(name) for hid, name in rows.all()}


#: P43 (ADR 0057 D2): the drawn chart and the numeric project x step table.
GANTT_SHEET = "Gantt"
GANTT_DATA_SHEET = "Gantt data"

#: R42-6 bucket -> the drawn chart's outcome key.
_BUCKET_TO_OUTCOME: dict[str, str] = {
    "WITHIN_YEAR": "within_year",
    "SPILLOVER": "spillover",
    "LEFT_OUT": "left_out",
    "BLOCKED": "blocked",
    "QUEUED": "queued",
    "NOT_SCHEDULED_PRIORITY": "not_scheduled_priority",
}


def outcome_display(key: str | None, served_label: str | None) -> str:
    """The chart's outcome text: the served `outcome_label` when there is one
    (P42: "Not scheduled (P4)", "Queued — fits by W40", ...), else the
    outcome's name; "No run outcome" without one."""

    if served_label:
        return served_label
    if key is None:
        return "No run outcome"
    return OUTCOME_STYLES.get(key, (key, ""))[0]


def gantt_chart_from_rows(
    project_rows: Sequence[GanttProjectRow],
    *,
    title: str,
    current_week: int | None,
    base_year: int | None,
    context: Sequence[str] = (),
    ranks: Mapping[uuid.UUID, int | None] | None = None,
    statuses: Mapping[uuid.UUID, str] | None = None,
) -> GanttChart:
    """The drawn chart of `GET /gantt` rows: the served planned weeks, the
    served `outcome` / `outcome_label`, the served `pinned` flag. Nothing is
    recomputed."""

    projects: list[GanttProjectBar] = []
    for p in project_rows:
        key = _BUCKET_TO_OUTCOME.get(p.outcome) if p.outcome is not None else None
        if key is None and not p.steps:
            # No R42-6 bucket and nothing placed: status-excluded (On Hold,
            # Cancelled, Draft), a data error, or no run row. Drawn in the
            # chart's "Not in the plan" section.
            key = "excluded" if p.outcome_label is None else None
        projects.append(
            GanttProjectBar(
                name=p.project_name,
                hub=p.hub.value if hasattr(p.hub, "value") else str(p.hub),
                # ADR 0067: no band for a Commercialized / Cancelled project.
                priority=(p.priority.value if p.priority else None)
                if p.priority_applicable
                else None,
                priority_label=p.priority_label,
                leader=p.leader_name,
                outcome=key,
                outcome_text=(
                    outcome_display(key, p.outcome_label)
                    if key != "excluded"
                    else "Not in the plan (status)"
                ),
                frozen=p.frozen,
                rank=(ranks or {}).get(p.project_id),
                is_vip=p.is_vip,
                status=(statuses or {}).get(p.project_id),
                steps=[
                    GanttStepBar(
                        step_id=st.step_id,
                        name=st.step_name,
                        kind=st.kind.value if hasattr(st.kind, "value") else str(st.kind),
                        sequence_order=st.sequence_order,
                        start=st.planned_start_week,
                        end=st.planned_end_week,
                        resource=st.assigned_engineer_name or st.assigned_chamber_code,
                        skipped=st.skipped,
                        pinned=st.pinned,
                    )
                    for st in p.steps
                ],
            )
        )
    return GanttChart(
        title=title,
        projects=projects,
        current_week=current_week,
        base_year=base_year,
        context=list(context),
    )


async def _fetch_all_projects(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: list[uuid.UUID],
    category: list[str],
    status_: list[ProjectStatus],
    priority: list[PriorityFilterValue],
    type_: list[ProjectType],
    q: str | None = None,
) -> list[ProjectListItem]:
    """Same "never silently truncate at one page" pagination loop as
    `_fetch_all_gantt_rows`, for `GET /projects`'s own `limit`/`offset` (max
    500). P54: the rows are the endpoint's `ProjectListItem`s (with the
    read-only `band_rank` / `band_size` filled).
    """

    from api.routers.projects import list_projects

    page_size = 500
    offset = 0
    all_projects: list[ProjectListItem] = []
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
    hub_id: _ListFilter = None,
    category: _ListFilter = None,
    status_: _ListFilter = None,
    priority: _ListFilter = None,
    type_: _ListFilter = None,
    q: str | None = None,
) -> ExportSheets:
    from schemas.project import ProjectListItem

    projects = await _fetch_all_projects(
        db,
        principal,
        hub_id=_uuids(hub_id),
        category=_categories(category),
        status_=_statuses(status_),
        priority=_priorities(priority),
        type_=_types(type_),
        q=q,
    )
    headers, rows = rows_from_models(projects, ProjectListItem)
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
    # P43 rework: the hub by name (the row carries only `hub_id`).
    hub_names = await _hub_name_map(db, {p.hub_id for p in projects})
    headers = [*headers, "hub"]
    for row in rows:
        hid = row.get("hub_id")
        row["hub"] = hub_names.get(str(hid)) if hid else None
    summary = [
        SummaryBlock(title="By status", headers=["Status", "Projects"],
                     rows=_tally(rows, "status", [v.value for v in ProjectStatus])),
        SummaryBlock(title="By priority", headers=["Priority", "Projects"],
                     rows=_tally(rows, "priority", _PRIORITIES)),
        SummaryBlock(title="By hub", headers=["Hub", "Projects"], rows=_tally(rows, "hub")),
    ]  # fmt: skip
    return SheetBook(
        {"Projects": (headers, rows)},
        title="Project register",
        context=[f"{len(rows)} project(s)"],
        summaries={SUMMARY_SHEET: summary},
        order=[SUMMARY_SHEET, "Projects"],
    )


async def build_capacity_planning_sheets(
    db: AsyncSession,
    principal: Principal,
    *,
    hub_id: _ListFilter = None,
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

    clock = plan_clock.now()
    engineers = await list_engineers(
        hub_id=_uuids(hub_id), db=db, current_user=principal, clock=clock
    )
    chambers = await list_chambers(db=db, current_user=principal, clock=clock)

    eng_headers, eng_rows = rows_from_models(
        [EngineerRead.model_validate(e) for e in engineers], EngineerRead
    )
    ch_headers, ch_rows = rows_from_models(
        [ChamberRead.model_validate(c) for c in chambers], ChamberRead
    )
    # P43 rework: the hub by name (the row carries only `hub_id`).
    hub_names = await _hub_name_map(db, {e.hub_id for e in engineers})
    if eng_headers:
        eng_headers = [*eng_headers, "hub"]
    for row in eng_rows:
        row["hub"] = hub_names.get(str(row.get("hub_id")))
    per_hub: dict[str, list[Any]] = {}
    for row in eng_rows:
        line = per_hub.setdefault(str(row.get("hub")), [str(row.get("hub")), 0, 0, 0.0])
        line[1] += 1
        if row.get("active", True):
            line[2] += 1
            line[3] = round(line[3] + float(row.get("fte") or 0), 2)
    per_region: dict[str, list[Any]] = {}
    for row in ch_rows:
        region_name = str(row.get("lab_region"))
        line = per_region.setdefault(region_name, [region_name, 0, 0])
        line[1] += 1
        line[2] += int(row.get("platforms") or 0)
    summary = [
        SummaryBlock(title="Engineers", headers=["Hub", "Engineers", "Active", "Active FTE"],
                     rows=[per_hub[k] for k in sorted(per_hub)]),
        SummaryBlock(title="Chambers", headers=["Lab region", "Chambers", "Platforms"],
                     rows=[per_region[k] for k in sorted(per_region)]),
    ]  # fmt: skip
    return SheetBook(
        {
            "Engineers": (eng_headers, eng_rows),
            "Chambers": (ch_headers, ch_rows),
        },
        title="Capacity planning",
        context=[f"{len(eng_rows)} engineer(s)", f"{len(ch_rows)} chamber(s)"],
        summaries={SUMMARY_SHEET: summary},
        order=[SUMMARY_SHEET, "Engineers", "Chambers"],
    )


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
    sheets = await builder(db, principal, **filters)
    if isinstance(sheets, SheetBook):
        # P43 (ADR 0057 D1): the title block names the scope and filters.
        sheets.context = [
            *sheets.context,
            await _scope_line(db, principal),
            *await _filter_lines(db, filters),
        ]
        for chart in sheets.charts.values():
            chart.context = list(sheets.context)
    return sheets


#: Filter key -> its words in the title block.
_FILTER_NAMES: dict[str, str] = {
    "hub_id": "Hub",
    "category": "Category",
    "status_": "Status",
    "priority": "Priority",
    "region": "Region",
    "q": "Search",
    "type_": "Type",
    "leader_engineer_id": "Leader",
    "current_step": "Current step",
    "currency": "Currency",
    "project_id": "Project",
    "sort": "Sort",
}


async def _hub_names(db: AsyncSession, ids: Sequence[uuid.UUID]) -> list[str]:
    from models.hub import Hub

    if not ids:
        return []
    rows = (await db.execute(select(Hub.name).where(Hub.id.in_(list(ids))))).scalars()
    return sorted(h.value if hasattr(h, "value") else str(h) for h in rows)


async def _scope_line(db: AsyncSession, principal: Principal) -> str:
    if principal.hub_scope_all:
        return "Scope: all hubs"
    names = await _hub_names(db, sorted(principal.hub_ids))
    return "Scope: " + (", ".join(names) if names else "no hubs")


async def _filter_lines(db: AsyncSession, filters: ExportFilters) -> list[str]:
    """Plain filter echoes. Hub ids become hub names; leader and project ids
    become counts (no person or project name is looked up here)."""

    parts: list[str] = []
    for key, value in filters.items():
        values = as_list(value)
        if not values or key in ("sort", "currency"):
            continue
        name = _FILTER_NAMES.get(key, key)
        if key == "hub_id":
            try:
                shown = ", ".join(await _hub_names(db, _uuids(value)))
            except ValueError:
                shown = f"{len(values)} selected"
        elif key in ("leader_engineer_id", "project_id"):
            shown = f"{len(values)} selected"
        else:
            shown = ", ".join(neutralise_formula(str(v)) for v in values)
        parts.append(f"{name}: {shown}")
    return [("Filters: " + "; ".join(parts)) if parts else "Filters: none"]
