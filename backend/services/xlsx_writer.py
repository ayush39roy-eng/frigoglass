"""P43 (ADR 0057, docs/API_CONTRACT_P43.md): the one styled workbook writer
behind every `.xlsx` export, and the drawn Gantt sheet.

**D1 — styled tables and reports.** `write_workbook(book)` writes:
- a title block on rows 1-3 (title, scope / filters, generated-at and plan
  week);
- the table header on row `TABLE_HEADER_ROW` (5), with human column names
  (`label_for`), a dark fill, and the header and first column frozen;
- auto-filter, column widths sized to the content, Yes / No booleans,
  number formats, banded rows;
- print setup: landscape, fit to width, header rows repeated.

A sheet named in `SheetBook.reports` is a small key / value report instead
(no filter, no banding, label column bold, `SECTION` rows as headings).

**D2 — the drawn Gantt.** A `GanttChart` becomes a sheet with one row per
project (its overall bar) and its steps indented beneath, fixed columns
(project / step, hub, priority, leader / engineer, start, end, outcome) and
narrow week columns W1..horizon. A bar fills exactly the served
`start..end` weeks (inclusive), in the app's step colour (the 14-slot step
palette of `frontend/src/surfaces/gantt/lib/step-colors.ts`). Frozen
projects are hatched, pinned steps outlined; the current week and the W52
boundary are marked; a legend follows the chart.

**Guards kept from the plain writer:**
- every string goes through `neutralise_formula` and is written as a text
  cell, so nothing a user typed becomes a live formula (P13-F10);
- the writer only renders the rows it is given: it adds no column, and the
  financial columns appear exactly where the surface builders already put
  them;
- nothing here logs a value;
- `write_only=True` keeps memory bounded (rows are streamed). Merged cells
  are not used, so write-only mode is enough.
"""

from __future__ import annotations

import io
import re
from collections.abc import Iterable, Mapping, Sequence
from copy import copy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, Final

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.properties import Outline, PageSetupProperties

from scheduling.weeks import PLAN_YEAR_WEEKS, week_of_year, year_end, year_of
from services.priority_applicability import (
    PRIORITY_NOT_APPLICABLE_LABEL,
    effective_priority,
    priority_applicable,
)
from services.week_labels import week_label

# --------------------------------------------------------------------------
# Formula guard (P13-F10) and value rendering
# --------------------------------------------------------------------------

#: P13-F10 (CWE-1236): a text cell starting with one of these is read as a
#: formula (or a DDE payload) by Excel / LibreOffice.
FORMULA_TRIGGERS: Final[tuple[str, ...]] = ("=", "+", "-", "@", "\t", "\r")


def neutralise_formula(text: str) -> str:
    """Prefix `'` to a string a spreadsheet would treat as a formula. Only
    ever applied to `str` values: a negative number stays a number."""

    if text.startswith(FORMULA_TRIGGERS):
        return "'" + text
    return text


def stringify(value: Any) -> Any:
    """One cell value: `None` -> `""`, a list -> a comma-joined string, a
    string neutralised; numbers and booleans unchanged."""

    if value is None:
        return ""
    if isinstance(value, dict):
        # Defensive: a nested object becomes one readable text cell.
        return neutralise_formula("; ".join(f"{k}: {v}" for k, v in value.items()))
    if isinstance(value, (list, tuple, frozenset, set)):
        return neutralise_formula(", ".join(str(v) for v in value))
    if isinstance(value, str):
        return neutralise_formula(value)
    return value


# --------------------------------------------------------------------------
# Human headers
# --------------------------------------------------------------------------

#: A machine key (`snake_case`); anything else is already a display label.
#: P43-R02 (QA G2): a segment may be capitalised (`..._by_priority_P1`).
_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*(?:_[A-Za-z0-9]+)*$")

#: Word-level replacements for `humanize`.
_WORDS: Final[Mapping[str, str]] = {
    "id": "ID",
    "ids": "IDs",
    "eur": "(EUR)",
    "pct": "%",
    "fte": "FTE",
    "oem": "OEM",
    "pdd": "PDD",
    "vip": "VIP",
    "kpi": "KPI",
    "kpis": "KPIs",
    "tcogs": "TCOGS",
    "capex": "CAPEX",
    "poc": "PoC",
    "sha256": "SHA-256",
    "wk": "wk",
}

#: Explicit labels shared by every surface (a surface may override one in its
#: own `SheetBook.labels`). Keys not listed are `humanize`d.
HEADER_LABELS: Final[Mapping[str, str]] = {
    "project_id": "Project ID",
    "project_name": "Project",
    "external_code": "Project code",
    "hub": "Hub",
    "hub_id": "Hub ID",
    "capacity_hub": "Capacity hub",
    "category": "Category",
    "type": "Type",
    "priority": "Priority",
    "priority_label": "Priority meaning",
    "priority_applicable": "Priority applicable",
    "status": "Status",
    "leader_name": "Leader",
    "leader_engineer_id": "Leader ID",
    "frozen": "Frozen",
    "is_vip": "VIP",
    "delay_weeks": "Delay (weeks)",
    "left_out": "Left out",
    "spillover": "Spillover",
    "within_year": "Within year",
    "blocked": "Blocked",
    "cat_not_allowed": "Category not allowed",
    "counts_toward_year": "Counts toward the year",
    "not_scheduled_priority": "Not scheduled (P4)",
    "outcome": "Outcome",
    "outcome_label": "Outcome note",
    "step_id": "Step code",
    "step_name": "Step",
    "kind": "Kind",
    "sequence_order": "Step no.",
    "duration_weeks": "Duration (weeks)",
    "span_weeks": "Span (weeks)",
    "planned_start_week": "Planned start (week)",
    "planned_end_week": "Planned end (week)",
    "actual_start_week": "Actual start (week)",
    "actual_end_week": "Actual end (week)",
    "start_week": "Start (week)",
    "end_week": "End (week)",
    "finish_week": "Finish (week)",
    "assigned_engineer_name": "Engineer",
    "assigned_chamber_code": "Chamber",
    "engineer_name": "Engineer",
    "chamber_code": "Chamber",
    "eng_conflict": "Engineer conflict",
    "chamber_overlap": "Chamber overlap",
    "pinned": "Pinned week",
    "skipped": "Skipped",
    "customer_name": "Customer",
    "tcogs_eur": "TCOGS (EUR)",
    "selling_price_eur": "Selling price (EUR)",
    "gross_margin_pct": "Gross margin %",
    "suggested_band_after_capacity_fill": "Suggested band (after P1 capacity fill)",
    "score_band": "Score band",
    "capacity_fill": "P1 capacity fill",
    "capacity_fill_reason": "P1 capacity fill reason",
    "normalized_pct": "Score %",
    "weighted_score": "Weighted score",
    "has_score": "Scored",
    "members": "Member hubs",
    "booked_pct": "Booked %",
    "load_weeks": "Load (weeks)",
    "capacity_weeks": "Capacity (weeks)",
    "booked_span_weeks": "Booked span (weeks)",
    "ref": "Ref",
    "file_row": "File row",
    "data_error": "Data error",
    "is_new": "New in scenario",
    "within_plan_year": "Within plan year",
    "before_outcome": "Outcome before",
    "before_finish_week": "Finish before (week)",
    "leader_auto_assigned": "Leader auto-assigned",
    "replaces_project_id": "Replaces project ID",
    "done_before_import": "Done before import",
    "not_placed": "Not placed",
    "queued": "Queued",
    "plan_year_end_week": "Plan year ends (week)",
    "simulated_week": "Simulated at (week)",
    "horizon_weeks": "Horizon (weeks)",
    "base_year": "Base year",
    "plan_version": "Plan version",
    "source_file_name": "Source file",
    "source_file_sha256": "Source file SHA-256",
    "imported_at": "Imported at",
    "saved_at": "Saved at",
}


def humanize(key: str) -> str:
    """`planned_start_week` -> `Planned start week`. A value that is not a
    `snake_case` key (already a label, or user text) is returned unchanged."""

    if not _KEY_RE.match(key):
        return key
    words = [_WORDS.get(w, w) for w in key.split("_") if w]
    if not words:
        return key
    first = words[0]
    words[0] = first[:1].upper() + first[1:]
    return " ".join(words)


def label_for(key: str, labels: Mapping[str, str] | None = None) -> str:
    if labels and key in labels:
        return labels[key]
    if key in HEADER_LABELS:
        return HEADER_LABELS[key]
    return humanize(key)


def header_labels(headers: Sequence[str], labels: Mapping[str, str] | None = None) -> list[str]:
    """The display header of each key, made unique within the sheet (a
    repeated label gets its key in brackets)."""

    out = [label_for(h, labels) for h in headers]
    seen: dict[str, int] = {}
    for label in out:
        seen[label] = seen.get(label, 0) + 1
    # P43-R01 (security M-1): a label can be user text (an Admin-edited
    # rubric label on the Matrix), so every header goes through the formula
    # guard here, for CSV and xlsx alike.
    return [
        neutralise_formula(f"{label} ({h})" if seen[label] > 1 and label != h else label)
        for h, label in zip(headers, out, strict=True)
    ]


# --------------------------------------------------------------------------
# The workbook description
# --------------------------------------------------------------------------

Table = tuple[list[str], list[dict[str, Any]]]


class _Section:
    """Marker value: a report row that is a heading."""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "SECTION"


#: A report row `(heading, SECTION)` renders as a section heading.
SECTION: Final = _Section()


class SheetBook(dict[str, Table]):
    """`sheet name -> (keys, rows)` like the plain `ExportSheets` dict, plus
    how to present it. A plain dict is accepted everywhere a `SheetBook` is,
    with defaults (a generic title, humanised headers)."""

    def __init__(
        self,
        tables: Mapping[str, Table] | None = None,
        *,
        title: str | None = None,
        context: Iterable[str] = (),
        labels: Mapping[str, str] | None = None,
        charts: Mapping[str, GanttChart] | None = None,
        reports: Iterable[str] = (),
        order: Iterable[str] | None = None,
        title_block: bool = True,
        raw_headers: bool = False,
        summaries: Mapping[str, list[SummaryBlock]] | None = None,
    ) -> None:
        super().__init__(tables or {})
        self.title = title
        self.context: list[str] = list(context)
        self.labels: dict[str, str] = dict(labels or {})
        self.charts: dict[str, GanttChart] = dict(charts or {})
        self.reports: set[str] = set(reports)
        self.order: list[str] | None = list(order) if order is not None else None
        #: False: no title block, header on row 1 (the import template).
        self.title_block = title_block
        #: True: headers written exactly as given (the import template).
        self.raw_headers = raw_headers
        #: P43 rework: multi-table Summary sheets (not tables: never in CSV).
        self.summaries: dict[str, list[SummaryBlock]] = dict(summaries or {})


@dataclass
class SummaryBlock:
    """P43 rework: one small table of a Summary sheet."""

    title: str
    headers: list[str]
    rows: list[list[Any]]
    note: str | None = None
    #: 0-based columns holding a served share in % (0..100).
    percent_columns: frozenset[int] = frozenset()
    #: 0-based (row, column) cells holding a share in % (a headline row).
    percent_cells: frozenset[tuple[int, int]] = frozenset()


def book_labels(sheets: Mapping[str, Table]) -> dict[str, str] | None:
    return getattr(sheets, "labels", None)


@dataclass
class GanttStepBar:
    step_id: str
    name: str
    kind: str
    sequence_order: int
    start: int | None
    end: int | None
    resource: str | None = None
    skipped: bool = False
    pinned: bool = False


@dataclass
class GanttProjectBar:
    name: str
    hub: str
    priority: str | None
    priority_label: str | None
    leader: str | None
    #: One of `OUTCOME_STYLES` keys, or None (no outcome).
    outcome: str | None
    outcome_text: str
    frozen: bool = False
    steps: list[GanttStepBar] = field(default_factory=list)
    #: The served project span when the source has one; else the steps'.
    start: int | None = None
    end: int | None = None
    #: P43 rework: the project's band rank (ordering) and VIP pin (marker).
    rank: int | None = None
    is_vip: bool = False
    #: P43-R02 (G5): the project's status, when the source serves it.
    status: str | None = None

    def span(self) -> tuple[int | None, int | None]:
        if self.start is not None and self.end is not None:
            return self.start, self.end
        weeks = [
            (s.start, s.end)
            for s in self.steps
            if not s.skipped and s.start is not None and s.end is not None
        ]
        if not weeks:
            return None, None
        return min(a for a, _ in weeks), max(b for _, b in weeks)


@dataclass
class GanttChart:
    title: str
    projects: list[GanttProjectBar]
    current_week: int | None
    base_year: int | None
    #: The run's search limit (informational since P53: the drawn axis ends
    #: at the last finish, rounded up to a year end, never at H, R53-6).
    horizon_weeks: int = 0
    within_year_week: int = PLAN_YEAR_WEEKS
    context: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------
# Palette (frontend/src/surfaces/gantt/lib/step-colors.ts STEP_PALETTE_HEX and
# styles/tokens.css --step-ink-N, light theme)
# --------------------------------------------------------------------------

STEP_PALETTE_HEX: Final[tuple[str, ...]] = (
    "1A6FE0",
    "8B7FFF",
    "0D9488",
    "00C9A7",
    "F59E0B",
    "E11D48",
    "7C3AED",
    "2563EB",
    "059669",
    "D97706",
    "DB2777",
    "4F46E5",
    "0891B2",
    "65A30D",
)
#: Slots (1-based) whose label ink is white; the others are slate-900.
_WHITE_INK_SLOTS: Final[frozenset[int]] = frozenset({1, 6, 7, 8, 11, 12})
_DARK_INK = "0F172A"
_STEP_LETTERS = "ABCDEFGHIJKLMN"
_STEP_CODE_RE = re.compile(r"^(PDD|OEM)-([A-N])$")


def step_slot(step_id: str, sequence_order: int) -> int:
    """1..14: the palette slot of a step (by its letter; else its order)."""

    m = _STEP_CODE_RE.match(step_id)
    if m:
        return _STEP_LETTERS.index(m.group(2)) + 1
    return min(14, max(1, sequence_order))


def step_colour(step_id: str, sequence_order: int) -> str:
    return STEP_PALETTE_HEX[step_slot(step_id, sequence_order) - 1]


def step_ink(step_id: str, sequence_order: int) -> str:
    return "FFFFFF" if step_slot(step_id, sequence_order) in _WHITE_INK_SLOTS else _DARK_INK


def step_letter(step_id: str, sequence_order: int) -> str:
    m = _STEP_CODE_RE.match(step_id)
    if m:
        return m.group(2)
    return _STEP_LETTERS[step_slot(step_id, sequence_order) - 1]


#: Outcome key -> (default text, text colour).
OUTCOME_STYLES: Final[Mapping[str, tuple[str, str]]] = {
    "within_year": ("Within year", "15803D"),
    "spillover": ("Spillover", "B45309"),
    "left_out": ("Spillover · unplaced", "C2410C"),
    "blocked": ("Blocked", "B91C1C"),
    "queued": ("Queued", "1D4ED8"),
    "not_scheduled_priority": ("Not scheduled (P4)", "64748B"),
    "excluded": ("Not in the plan (status)", "64748B"),
    #: P43-R02 (G5): Commercialized counts as within year (OQ #109).
    "delivered": ("Delivered (Commercialized)", "15803D"),
    "data_error": ("Data error", "B91C1C"),
}
_NO_OUTCOME_COLOUR = "64748B"

KIND_LABELS: Final[Mapping[str, str]] = {
    "design": "Design",
    "lab": "Lab",
    "elapsed": "Elapsed",
}

# --------------------------------------------------------------------------
# Shared styles (one object each; openpyxl de-duplicates by value)
# --------------------------------------------------------------------------

NAVY: Final = "1F3A5F"
_SLATE_BAR: Final = "64748B"
_BAND: Final = "F1F5F9"
_PROJECT_ROW: Final = "E2E8F0"
_CURRENT_WEEK: Final = "F59E0B"
_CURRENT_WEEK_PALE: Final = "FEF3C7"
_NEXT_YEAR: Final = "CBD5E1"
_YEAR_END: Final = "DC2626"
_PIN: Final = "111827"


@lru_cache(maxsize=256)
def solid(rgb: str) -> PatternFill:
    return PatternFill(fill_type="solid", fgColor=rgb, bgColor=rgb)


@lru_cache(maxsize=64)
def hatched(rgb: str) -> PatternFill:
    """Frozen: white diagonal stripes over the step colour."""

    return PatternFill(fill_type="lightUp", fgColor="FFFFFF", bgColor=rgb)


@lru_cache(maxsize=64)
def coloured_bold(rgb: str) -> Font:
    return Font(name="Calibri", size=10, bold=True, color=rgb)


_TITLE_FONT = Font(name="Calibri", size=14, bold=True, color=NAVY)
_SUB_FONT = Font(name="Calibri", size=9, color="475569")
_HEADER_FONT = Font(name="Calibri", size=10, bold=True, color="FFFFFF")
_HEADER_FILL = solid(NAVY)
_HEADER_ALIGN = Alignment(horizontal="center", vertical="center", wrap_text=True)
_BAND_FILL = solid(_BAND)
_BOLD = Font(name="Calibri", size=10, bold=True)
_BODY = Font(name="Calibri", size=10)
_MUTED = Font(name="Calibri", size=9, color="64748B")
_MUTED_ITALIC = Font(name="Calibri", size=9, italic=True, color="64748B")
_SECTION_FONT = Font(name="Calibri", size=11, bold=True, color=NAVY)
_SECTION_FILL = solid("DBEAFE")
_RIGHT = Alignment(horizontal="right")
_LEFT_INDENT = Alignment(horizontal="left", indent=2)
_CENTER = Alignment(horizontal="center", vertical="center")
_WEEK_HEADER_FONT = Font(name="Calibri", size=7, bold=True, color="FFFFFF")
_WEEK_HEADER_NEXT_FONT = Font(name="Calibri", size=7, bold=True, color="334155")
_LETTER_FONTS: dict[str, Font] = {}
_THIN = Side(style="thin", color="CBD5E1")
_HEADER_BORDER = Border(bottom=Side(style="medium", color="0F172A"))
_WEEK_FORMAT = '"W"0'


def _week_format(week: int | None) -> str:
    """P53 (R53-8): a week cell keeps its absolute number (sortable) but
    displays the server label "W{week_of_year} {year}", never "W53+"."""

    return _WEEK_FORMAT if week is None else f'"{week_label(week)}"'


TABLE_HEADER_ROW: Final[int] = 5
#: The drawn Gantt: the year band (row 4) and the header (row 5).
CHART_HEADER_ROW: Final[int] = 5
CHART_FIXED_COLUMNS: Final[tuple[str, ...]] = (
    "Project / step",
    "Hub",
    "Priority",
    "Leader / engineer",
    "Start",
    "End",
    "Outcome",
)
CHART_FIRST_WEEK_COLUMN: Final[int] = len(CHART_FIXED_COLUMNS) + 1
_CHART_WIDTHS: Final[tuple[float, ...]] = (46, 13, 26, 22, 7, 7, 24)
_WEEK_WIDTH: Final[float] = 2.9


def _letter_font(ink: str) -> Font:
    font = _LETTER_FONTS.get(ink)
    if font is None:
        font = Font(name="Calibri", size=7, bold=True, color=ink)
        _LETTER_FONTS[ink] = font
    return font


_STYLE_NAMES: Final[tuple[str, ...]] = ("font", "fill", "border", "alignment", "number_format")


def _style(cell: Any, styles: Mapping[str, Any]) -> None:
    """Apply `styles` to a cell. Assigning a style object makes openpyxl hash
    it into the workbook's style tables, which dominates the cost of a large
    chart; the resulting style array is cached per workbook and per
    combination of (long-lived, module-level or `lru_cache`d) style objects,
    so each combination is hashed once."""

    if not styles:
        return
    wb = cell.parent.parent
    cache: dict[tuple[Any, ...], tuple[Any, list[Any]]] | None = getattr(wb, "_p43_styles", None)
    if cache is None:
        cache = {}
        wb._p43_styles = cache
    key = tuple(
        id(styles[n]) if n != "number_format" else styles[n] for n in _STYLE_NAMES if n in styles
    ) + tuple(n for n in _STYLE_NAMES if n in styles)
    hit = cache.get(key)
    if hit is not None:
        cell._style = copy(hit[0])
        return
    for name, val in styles.items():
        setattr(cell, name, val)
    # Keep the style objects alive so their ids stay unique for the cache.
    cache[key] = (copy(cell._style), list(styles.values()))


def _text(ws: Any, value: str, **style: Any) -> Any:
    """A text cell (never a formula: `data_type` forced to `s`)."""

    cell = WriteOnlyCell(ws, value=neutralise_formula(value))
    cell.data_type = "s"
    _style(cell, {k: v for k, v in style.items() if v is not None})
    return cell


def _cell(ws: Any, value: Any, **style: Any) -> Any:
    """Any value through `stringify`; bool -> Yes / No; text cells forced."""

    v = stringify(value)
    if isinstance(v, bool):
        v = "Yes" if v else "No"
    if isinstance(v, str):
        return _text(ws, v, **style)
    cell = WriteOnlyCell(ws, value=v)
    if isinstance(v, float) and "number_format" not in style:
        style = {**style, "number_format": "#,##0.00"}
    _style(cell, style)
    return cell


def _empty(ws: Any, **style: Any) -> Any:
    """A styled cell with no value."""

    cell = WriteOnlyCell(ws, value=None)
    _style(cell, style)
    return cell


def _data_cell(ws: Any, value: Any) -> Any:
    """A plain table cell, as cheap as possible: an empty value writes no
    cell, an int is written as is, text is a text cell (P13-F10)."""

    v = stringify(value)
    if v == "":
        return None
    if isinstance(v, bool):
        return _text(ws, "Yes" if v else "No")
    if isinstance(v, str):
        return _text(ws, v)
    if isinstance(v, float):
        return _cell(ws, v)
    return v


def _print_setup(ws: Any, title_rows: str) -> None:
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = 9  # A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    ws.print_title_rows = title_rows
    ws.page_margins.left = ws.page_margins.right = 0.4
    ws.page_margins.top = ws.page_margins.bottom = 0.5


def _title_block(ws: Any, title: str, context: Sequence[str], generated: str) -> None:
    """Rows 1-4: title, context, generated line, a spacer."""

    ws.append([_text(ws, title, font=_TITLE_FONT)])
    ws.append([_text(ws, " · ".join(c for c in context if c), font=_SUB_FONT)])
    ws.append([_text(ws, generated, font=_SUB_FONT)])
    ws.append([])


def _width_of(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, bool):
        return 3
    if isinstance(value, float):
        return len(f"{value:,.2f}")
    return len(str(value))


def _column_widths(
    labels: Sequence[str], keys: Sequence[str], rows: Sequence[Mapping[str, Any]]
) -> list[float]:
    widths: list[float] = []
    sample = rows[:2000]
    for label, key in zip(labels, keys, strict=True):
        longest_word = max((len(w) for w in label.split()), default=0)
        content = max((_width_of(stringify(r.get(key))) for r in sample), default=0)
        # P43 rework: headers wrap, so a column is as wide as its content
        # (capped) or its longest header word, not its whole header.
        want = max(8, longest_word + 2, min(content, MAX_COLUMN_WIDTH - 2) + 2)
        widths.append(float(min(MAX_COLUMN_WIDTH, want)))
    return widths


#: P43 rework: the widest a data column gets; longer text is cut on screen.
MAX_COLUMN_WIDTH: Final[int] = 36

#: Identifying columns, put first (in this order) and frozen.
LEAD_KEYS: Final[tuple[str, ...]] = (
    "project_name",
    "name",
    "project",
    "code",
    "hub",
    "priority",
    "set_priority",
    "step_name",
    "step_id",
    "status",
)


def is_id_key(key: str) -> bool:
    """An internal id column (UUIDs, refs, hashes): moved to the far right."""

    return (
        key == "id"
        or key.endswith("_id")
        or key.endswith("_ids")
        or key in ("ref", "source_file_sha256")
    )


def ordered_keys(keys: Sequence[str]) -> tuple[list[str], int]:
    """(display order, number of lead columns): the identifying columns
    first, ids last, everything else in its served order between."""

    lead = [k for k in LEAD_KEYS if k in keys]
    ids = [k for k in keys if is_id_key(k) and k not in lead]
    rest = [k for k in keys if k not in lead and k not in ids]
    return lead + rest + ids, len(lead)


def _header_height(labels: Sequence[str], widths: Sequence[float]) -> float:
    """Row height for wrapped header labels (about 1.1 characters per width
    unit, 13 points per line, at most 5 lines)."""

    lines = 1
    for label, width in zip(labels, widths, strict=True):
        per_line = max(1, int(width / 1.1))
        line, count = 0, 1
        for word in label.split():
            need = len(word) + (1 if line else 0)
            if line and line + need > per_line:
                count += 1
                line = len(word)
            else:
                line += need
        lines = max(lines, count)
    return float(13 * min(lines, 5) + 4)


# --------------------------------------------------------------------------
# Tables and reports
# --------------------------------------------------------------------------


def _write_table(
    wb: Workbook,
    name: str,
    table: Table,
    *,
    title: str,
    context: Sequence[str],
    generated: str,
    labels: Mapping[str, str] | None,
    title_block: bool,
    raw_headers: bool,
) -> None:
    keys, rows = table
    ws = wb.create_sheet(title=name[:31])
    lead = 0
    if not raw_headers:
        # P43 rework: identifying columns first and frozen, ids last.
        keys, lead = ordered_keys(keys)
    shown = list(keys) if raw_headers else header_labels(keys, labels)
    header_row = TABLE_HEADER_ROW if title_block else 1
    # Before the first row: write-only mode writes the sheet properties first.
    _print_setup(ws, f"{header_row}:{header_row}")
    widths = _column_widths(shown, keys, rows)
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    if keys and not raw_headers:
        ws.row_dimensions[header_row].height = _header_height(shown, widths)
    if keys:
        frozen_cols = min(max(lead, 1), len(keys) - 1) if len(keys) > 1 else 0
        ws.freeze_panes = f"{get_column_letter(frozen_cols + 1)}{header_row + 1}"
    if title_block:
        _title_block(ws, title, context, generated)
    ws.append(
        [
            _text(ws, h, font=_HEADER_FONT, fill=_HEADER_FILL, alignment=_HEADER_ALIGN,
                  border=_HEADER_BORDER)
            for h in shown
        ]
    )  # fmt: skip
    for row in rows:
        ws.append([_data_cell(ws, row.get(k)) for k in keys])
    if keys:
        last = get_column_letter(len(keys))
        ws.auto_filter.ref = f"A{header_row}:{last}{header_row + max(len(rows), 0)}"
        if rows:
            # Banded rows as one conditional format (no per-cell style). The
            # rule is a constant written here, never data.
            ws.conditional_formatting.add(
                f"A{header_row + 1}:{last}{header_row + len(rows)}",
                FormulaRule(  # type: ignore[no-untyped-call]
                    formula=[f"MOD(ROW()-{header_row},2)=0"], fill=_BAND_FILL
                ),
            )


def _write_report(
    wb: Workbook,
    name: str,
    table: Table,
    *,
    title: str,
    context: Sequence[str],
    generated: str,
    labels: Mapping[str, str] | None,
) -> None:
    """A key / value sheet (`[label, value, ...]` columns): a small report."""

    keys, rows = table
    ws = wb.create_sheet(title=name[:31])
    ws.sheet_view.showGridLines = False
    _print_setup(ws, f"{TABLE_HEADER_ROW}:{TABLE_HEADER_ROW}")
    widths = [40.0] + [max(18.0, min(40.0, len(k) + 4.0)) for k in keys[1:]]
    for c in range(len(keys)):
        sample = [_width_of(stringify(r.get(keys[c]))) for r in rows[:500]]
        widths[c] = float(min(70, max(widths[c], max(sample, default=0) + 2)))
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = f"A{TABLE_HEADER_ROW + 1}"
    _title_block(ws, title, context, generated)
    shown = header_labels(keys, labels)
    ws.append(
        [_text(ws, h, font=_HEADER_FONT, fill=_HEADER_FILL, alignment=_HEADER_ALIGN) for h in shown]
    )
    first = keys[0] if keys else None
    for row in rows:
        item = row.get(first) if first else None
        if any(row.get(k) is SECTION for k in keys[1:]):
            label = label_for(str(item), labels) if isinstance(item, str) else ""
            ws.append(
                [_text(ws, label, font=_SECTION_FONT, fill=_SECTION_FILL)]
                + [_empty(ws, fill=_SECTION_FILL) for _ in keys[1:]]
            )
            continue
        shown_item: Any = label_for(item, labels) if isinstance(item, str) else item
        line = [_cell(ws, shown_item, font=_BOLD)]
        for k in keys[1:]:
            value = row.get(k)
            if value is None:
                line.append(None)
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                line.append(_cell(ws, value, font=_BODY, alignment=_RIGHT))
            else:
                line.append(_cell(ws, value, font=_BODY))
        ws.append(line)


_PERCENT_FORMAT = '0.0"%"'


def _write_summary(
    wb: Workbook,
    name: str,
    blocks: Sequence[SummaryBlock],
    *,
    title: str,
    context: Sequence[str],
    generated: str,
) -> None:
    """P43 rework: a short report of small formatted tables."""

    ws = wb.create_sheet(title=name[:31])
    ws.sheet_view.showGridLines = False
    _print_setup(ws, "1:1")
    ncols = max((len(b.headers) for b in blocks), default=2)
    # Sized to the longest text value in each column (headers wrap).
    widths = [34.0] + [13.0] * (ncols - 1)
    for b in blocks:
        for r in b.rows:
            for c, v in enumerate(r):
                if c and isinstance(v, str):
                    widths[c] = min(30.0, max(widths[c], len(v) + 2.0))
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    _title_block(ws, title, context, generated)
    row_no = 4
    for block in blocks:
        row_no += 1
        ws.append(
            [_text(ws, block.title, font=_SECTION_FONT, fill=_SECTION_FILL)]
            + [_empty(ws, fill=_SECTION_FILL) for _ in block.headers[1:]]
        )
        row_no += 1
        ws.row_dimensions[row_no].height = _header_height(
            block.headers, widths[: len(block.headers)]
        )
        ws.append(
            [_text(ws, h, font=_HEADER_FONT, fill=_HEADER_FILL, alignment=_HEADER_ALIGN)
             for h in block.headers]
        )  # fmt: skip
        for n, values in enumerate(block.rows):
            row_no += 1
            fill = {"fill": _BAND_FILL} if n % 2 == 1 else {}
            line: list[Any] = []
            for c, v in enumerate(values):
                if c == 0:
                    line.append(_cell(ws, v, font=_BOLD, **fill))
                elif (c in block.percent_columns or (n, c) in block.percent_cells) and isinstance(
                    v, (int, float)
                ):
                    line.append(_cell(ws, float(v), font=_BODY, alignment=_RIGHT,
                                      number_format=_PERCENT_FORMAT, **fill))  # fmt: skip
                elif isinstance(v, (int, float)) and not isinstance(v, bool):
                    line.append(_cell(ws, v, font=_BODY, alignment=_RIGHT, **fill))
                elif v is None:
                    line.append(_empty(ws, **fill) if fill else None)
                else:
                    line.append(_cell(ws, v, font=_BODY, **fill))
            ws.append(line)
        if block.note:
            row_no += 1
            ws.append([_text(ws, block.note, font=_MUTED_ITALIC)])
        row_no += 1
        ws.append([])


# --------------------------------------------------------------------------
# The drawn Gantt
# --------------------------------------------------------------------------


def _year_boundaries(chart: GanttChart, horizon: int) -> list[int]:
    """The last week of each plan year inside the chart (W52, W104, ...)."""

    return list(range(PLAN_YEAR_WEEKS, horizon + 1, PLAN_YEAR_WEEKS))


def chart_horizon(chart: GanttChart) -> int:
    """W1..horizon: the last served week (so a bar is never cut), never below
    the plan-year end, rounded up to a year end (P53 R53-6: never H)."""

    ends = [
        s.end for p in chart.projects for s in p.steps if s.end is not None and not s.skipped
    ] + [p.end for p in chart.projects if p.end is not None]
    last = max([chart.within_year_week, *ends])
    return year_end(year_of(max(1, last)))


class _WeekStyler:
    """Builds the week cells of one chart row: fills, borders, letters."""

    def __init__(self, ws: Any, chart: GanttChart, horizon: int) -> None:
        self.ws = ws
        self.horizon = horizon
        self.current = chart.current_week
        self.boundaries = set(_year_boundaries(chart, horizon))
        self.within = chart.within_year_week
        self._borders: dict[tuple[bool, bool, bool, bool, bool], Border] = {}

    def border(self, *, top: bool, bottom: bool, left: bool, right: bool, year_end: bool) -> Border:
        key = (top, bottom, left, right, year_end)
        b = self._borders.get(key)
        if b is None:
            pin = Side(style="medium", color=_PIN)
            b = Border(
                top=pin if top else None,
                bottom=pin if bottom else None,
                left=pin if left else None,
                right=(
                    Side(style="medium", color=_YEAR_END) if year_end else (pin if right else None)
                ),
            )
            self._borders[key] = b
        return b

    def cells(
        self,
        bar: tuple[int, int] | None,
        *,
        fill: PatternFill | None,
        letter: str | None = None,
        ink: str | None = None,
        outlined: bool = False,
    ) -> list[Any]:
        out: list[Any] = []
        a, b = bar if bar is not None else (0, -1)
        pale = solid(_CURRENT_WEEK_PALE)
        for w in range(1, self.horizon + 1):
            on = a <= w <= b
            year_end = w in self.boundaries
            styles: dict[str, Any] = {}
            if on and fill is not None:
                styles["fill"] = fill
                if outlined or year_end:
                    styles["border"] = self.border(
                        top=outlined, bottom=outlined, left=outlined and w == a,
                        right=outlined and w == b, year_end=year_end,
                    )  # fmt: skip
                if w == a and letter:
                    styles["font"] = _letter_font(ink or _DARK_INK)
                    styles["alignment"] = _CENTER
                    out.append(_text(self.ws, letter, **styles))
                    continue
            elif w == self.current:
                styles["fill"] = pale
            if year_end and "border" not in styles:
                styles["border"] = self.border(
                    top=False, bottom=False, left=False, right=False, year_end=True
                )
            if not styles:
                out.append(None)
                continue
            cell = WriteOnlyCell(self.ws, value=None)
            _style(cell, styles)
            out.append(cell)
        return out


def _priority_text(priority: str | None, label: str | None, status: str | None = None) -> str:
    # ADR 0067: a Commercialized / Cancelled project's priority is "Not applicable".
    if not priority_applicable(status):
        return PRIORITY_NOT_APPLICABLE_LABEL
    if not priority:
        return ""
    return f"{priority} · {label}" if label else priority


def _bar_priority(p: GanttProjectBar) -> str | None:
    """ADR 0067: the bar's effective band (None for Commercialized / Cancelled)."""

    return effective_priority(p.status, p.priority)


def _write_chart(wb: Workbook, name: str, chart: GanttChart, generated: str) -> None:
    ws = wb.create_sheet(title=name[:31])
    horizon = chart_horizon(chart)
    styler = _WeekStyler(ws, chart, horizon)
    _print_setup(ws, f"{CHART_HEADER_ROW - 1}:{CHART_HEADER_ROW}")
    first_week_col = CHART_FIRST_WEEK_COLUMN

    for i, w in enumerate(_CHART_WIDTHS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for week in range(1, horizon + 1):
        ws.column_dimensions[get_column_letter(first_week_col + week - 1)].width = _WEEK_WIDTH
    ws.freeze_panes = f"{get_column_letter(first_week_col)}{CHART_HEADER_ROW + 1}"

    layout = chart_layout(chart)
    body_rows = sum(
        (1 if heading else 0) + sum(1 + len(steps) for _, steps in items)
        for heading, items in layout
    )
    legend_row = CHART_HEADER_ROW + body_rows + 2
    # Outline: step rows are level 1 under their project row (summary above).
    ws.sheet_properties.outlinePr = Outline(summaryBelow=False, summaryRight=True)
    ws.sheet_format.outlineLevelRow = 1
    ws.append([_text(ws, chart.title, font=_TITLE_FONT)])
    ws.append([_text(ws, " · ".join(c for c in chart.context if c), font=_SUB_FONT)])
    legend_note = f"{generated} · Legend: row {legend_row}, below the chart"
    ws.append([_text(ws, legend_note, font=_SUB_FONT)])

    # Row 4: the year band over the week columns.
    band: list[Any] = [None] * (first_week_col - 1)
    for week in range(1, horizon + 1):
        if (week - 1) % PLAN_YEAR_WEEKS == 0:
            year_index = (week - 1) // PLAN_YEAR_WEEKS
            if chart.base_year is not None:
                text = f"{chart.base_year + year_index} (from W{week_of_year(week)})"
            else:
                text = "Plan year" if year_index == 0 else f"Plan year +{year_index}"
            band.append(_text(ws, text, font=_BOLD))
        else:
            band.append(None)
    ws.append(band)

    # Row 5: the header.
    header: list[Any] = [
        _text(ws, h, font=_HEADER_FONT, fill=_HEADER_FILL, alignment=_HEADER_ALIGN)
        for h in CHART_FIXED_COLUMNS
    ]
    for week in range(1, horizon + 1):
        cell = WriteOnlyCell(ws, value=week)
        # P53 (R53-8): the column keeps its absolute week; it displays the
        # week of its year (the year band above names the year).
        hstyle: dict[str, Any] = {"alignment": _CENTER, "number_format": f'"{week_of_year(week)}"'}
        if week == chart.current_week:
            hstyle.update(fill=solid(_CURRENT_WEEK), font=_WEEK_HEADER_FONT)
        elif week > chart.within_year_week:
            hstyle.update(fill=solid(_NEXT_YEAR), font=_WEEK_HEADER_NEXT_FONT)
        else:
            hstyle.update(fill=_HEADER_FILL, font=_WEEK_HEADER_FONT)
        if week in styler.boundaries:
            hstyle["border"] = styler.border(
                top=False, bottom=False, left=False, right=False, year_end=True
            )
        _style(cell, hstyle)
        header.append(cell)
    ws.append(header)

    project_fill = solid(_PROJECT_ROW)
    bar_fill = solid(_SLATE_BAR)
    row_no = CHART_HEADER_ROW
    for heading, items in layout:
        if heading:
            row_no += 1
            ws.append(
                [_text(ws, heading, font=_SECTION_FONT, fill=_SECTION_FILL)]
                + [_empty(ws, fill=_SECTION_FILL) for _ in CHART_FIXED_COLUMNS[1:]]
            )
        for p, steps in items:
            row_no += 1
            ws.append(_project_line(ws, p, styler, project_fill, bar_fill))
            for st in steps:
                row_no += 1
                ws.row_dimensions[row_no].outlineLevel = 1
                ws.append(_step_line(ws, p, st, styler))

    ws.append([])
    _write_chart_legend(ws, chart, styler)
    ws.auto_filter.ref = (
        f"A{CHART_HEADER_ROW}:{get_column_letter(len(CHART_FIXED_COLUMNS))}"
        f"{CHART_HEADER_ROW + body_rows}"
    )


def _project_name(p: GanttProjectBar) -> str:
    marks = [m for m, on in (("VIP", p.is_vip), ("frozen", p.frozen)) if on]
    return p.name + (f" ({', '.join(marks)})" if marks else "")


def _project_line(
    ws: Any, p: GanttProjectBar, styler: _WeekStyler, project_fill: Any, bar_fill: Any
) -> list[Any]:
    start, end = p.span()
    colour = OUTCOME_STYLES.get(p.outcome or "", ("", _NO_OUTCOME_COLOUR))[1]
    outcome_text = p.outcome_text
    if chart_section(p) == "delivered":
        # P43-R02 (G5): one line, no bar; counted as within year.
        start = end = None
        outcome_text, colour = "Delivered — counts as within year", OUTCOME_STYLES["delivered"][1]
    line: list[Any] = [
        _text(ws, _project_name(p), font=_BOLD, fill=project_fill),
        _text(ws, p.hub, font=_BOLD, fill=project_fill),
        _text(
            ws,
            _priority_text(p.priority, p.priority_label, p.status),
            font=_BOLD,
            fill=project_fill,
        ),
        _text(ws, p.leader or "", font=_BODY, fill=project_fill),
        _cell(ws, start, font=_BOLD, fill=project_fill, number_format=_week_format(start)),
        _cell(ws, end, font=_BOLD, fill=project_fill, number_format=_week_format(end)),
        _text(ws, outcome_text, font=coloured_bold(colour), fill=project_fill),
    ]
    span = (start, end) if start is not None and end is not None else None
    line.extend(styler.cells(span, fill=bar_fill))
    return line


def _step_line(ws: Any, p: GanttProjectBar, st: GanttStepBar, styler: _WeekStyler) -> list[Any]:
    letter = step_letter(st.step_id, st.sequence_order)
    label = f"{letter} · {st.name}"
    if st.pinned:
        label += " (pinned)"
    if st.skipped:
        label += " (skipped)"
    drawn = (
        (st.start, st.end)
        if not st.skipped and st.start is not None and st.end is not None
        else None
    )
    colour_hex = step_colour(st.step_id, st.sequence_order)
    fill = hatched(colour_hex) if p.frozen else solid(colour_hex)
    row: list[Any] = [
        _text(ws, label, font=_BODY, alignment=_LEFT_INDENT),
        _text(ws, p.hub, font=_MUTED),
        _text(
            ws,
            (p.priority or "") if priority_applicable(p.status) else PRIORITY_NOT_APPLICABLE_LABEL,
            font=_MUTED,
        ),
        _text(ws, st.resource or "", font=_BODY),
        _cell(
            ws,
            None if st.skipped else st.start,
            font=_BODY,
            number_format=_week_format(st.start),
        ),
        _cell(
            ws,
            None if st.skipped else st.end,
            font=_BODY,
            number_format=_week_format(st.end),
        ),
        _text(ws, KIND_LABELS.get(st.kind, st.kind), font=_MUTED_ITALIC),
    ]
    row.extend(
        styler.cells(
            drawn,
            fill=fill,
            letter=letter,
            ink=step_ink(st.step_id, st.sequence_order),
            outlined=st.pinned,
        )
    )
    return row


#: P43 rework: the chart's sections, in order. A project's section comes from
#: its served outcome. `steps` False: one line, no step rows.
CHART_SECTIONS: Final[tuple[tuple[str, str, bool], ...]] = (
    ("plan", "In the plan", True),
    # P43-R02 (G5): Commercialized projects count as within year (OQ #109).
    ("delivered", "Delivered (Commercialized) — counts as within year", False),
    ("queued", "Queued (P3) — spare capacity only, not counted this year", True),
    # P43-R01 (workflow A4): a frozen P4 / Q project books its locked
    # capacity but is not counted (R42-2, OQ #107); its bucket is QUEUED.
    ("locked", "Locked P4 / Q — booked, not counted", True),
    ("not_scheduled_priority", "Not scheduled (P4)", False),
    ("excluded", "Not in the plan (status: On Hold, Cancelled, Draft, …)", False),
)
_PRIORITY_ORDER: Final[Mapping[str, int]] = {"P1": 0, "P2": 1, "P3": 2, "P4": 3, "Q": 4}


def chart_section(p: GanttProjectBar) -> str:
    if p.status == "Commercialized":
        return "delivered"
    if p.outcome == "queued" and p.frozen and _bar_priority(p) in ("P4", "Q"):
        return "locked"
    if p.outcome in ("queued", "not_scheduled_priority", "excluded"):
        return str(p.outcome)
    return "plan"


def chart_order_key(p: GanttProjectBar) -> tuple[int, int, str]:
    """Priority P1 → P4 / Q (none last), then band rank (none last), then
    name: the scheduler's band walk, for reading."""

    return (
        _PRIORITY_ORDER.get(_bar_priority(p) or "", 5),
        p.rank if p.rank is not None else 1_000_000,
        p.name.casefold(),
    )


def chart_layout(
    chart: GanttChart,
) -> list[tuple[str | None, list[tuple[GanttProjectBar, list[GanttStepBar]]]]]:
    """(section heading, [(project, its step rows)]) in drawing order. The
    heading is None when every project is in the plan (no other section)."""

    by_section: dict[str, list[GanttProjectBar]] = {}
    for p in chart.projects:
        by_section.setdefault(chart_section(p), []).append(p)
    only_plan = set(by_section) <= {"plan"}
    out: list[tuple[str | None, list[tuple[GanttProjectBar, list[GanttStepBar]]]]] = []
    for key, heading, with_steps in CHART_SECTIONS:
        projects = sorted(by_section.get(key, []), key=chart_order_key)
        if not projects:
            continue
        items = [
            (
                p,
                sorted(p.steps, key=lambda st: (st.sequence_order, st.step_id))
                if with_steps
                else [],
            )
            for p in projects
        ]
        out.append((None if only_plan else heading, items))
    return out


def _legend_line(ws: Any, label: str, note: str, swatch: list[Any]) -> list[Any]:
    line: list[Any] = [_text(ws, label, font=_BODY, alignment=_LEFT_INDENT)]
    line.extend([None] * (len(CHART_FIXED_COLUMNS) - 2))
    line.append(_text(ws, note, font=_MUTED_ITALIC))
    line.extend(swatch)
    return line


def _swatch(
    ws: Any,
    fill: PatternFill | None,
    *,
    letter: str | None = None,
    ink: str | None = None,
    border: Border | None = None,
    width: int = 4,
) -> list[Any]:
    out: list[Any] = []
    for i in range(width):
        cell = WriteOnlyCell(ws, value=None)
        if fill is not None:
            cell.fill = fill
        if i == 0 and letter:
            cell.value = letter
            cell.data_type = "s"
            cell.font = _letter_font(ink or _DARK_INK)
            cell.alignment = _CENTER
        if border is not None:
            cell.border = border
        out.append(cell)
    return out


def _write_chart_legend(ws: Any, chart: GanttChart, styler: _WeekStyler) -> None:
    ws.append([_text(ws, "Legend", font=_SECTION_FONT, fill=_SECTION_FILL)])
    names: dict[str, tuple[str, str, int]] = {}
    for p in chart.projects:
        for st in p.steps:
            names.setdefault(st.step_id, (st.name, st.kind, st.sequence_order))
    for wf in ("PDD", "OEM"):
        present = sorted(
            ((sid, v) for sid, v in names.items() if sid.startswith(f"{wf}-")),
            key=lambda item: (item[1][2], item[0]),
        )
        if not present:
            continue
        ws.append([_text(ws, f"{wf} workflow steps (bar colour)", font=_BOLD)])
        for sid, (step_name, kind, order) in present:
            letter = step_letter(sid, order)
            ws.append(
                _legend_line(
                    ws,
                    f"{letter} · {step_name} ({sid})",
                    KIND_LABELS.get(kind, kind),
                    _swatch(ws, solid(step_colour(sid, order)), letter=letter,
                            ink=step_ink(sid, order)),
                )
            )  # fmt: skip
    ws.append([_text(ws, "Markers", font=_BOLD)])
    sample = STEP_PALETTE_HEX[0]
    year_end = styler.border(top=False, bottom=False, left=False, right=False, year_end=True)
    pin = styler.border(top=True, bottom=True, left=True, right=True, year_end=False)
    markers: list[tuple[str, str, list[Any]]] = [
        ("Project row: first step start to last step end", "Project",
         _swatch(ws, solid(_SLATE_BAR))),
        ("Frozen project: hatched bars", "Frozen", _swatch(ws, hatched(sample))),
        ("Pinned step: outlined bar (typed start / end weeks)", "Pinned",
         _swatch(ws, solid(sample), border=pin)),
        (
            (
                f"Current week ({week_label(chart.current_week)})"
                if chart.current_week
                else "Current week"
            ),
            "Now",
            _swatch(ws, solid(_CURRENT_WEEK_PALE), width=1),
        ),
        (f"End of the plan year (red line after {week_label(chart.within_year_week)})",
         "Year end",
         _swatch(ws, None, border=year_end, width=1)),
        ("Weeks after the plan year (header shaded)", "Next year", _swatch(ws, solid(_NEXT_YEAR))),
    ]  # fmt: skip
    for label, note, swatch in markers:
        ws.append(_legend_line(ws, label, note, swatch))
    ws.append([_text(ws, "Outcome", font=_BOLD)])
    for text, colour in OUTCOME_STYLES.values():
        line: list[Any] = [_text(ws, "Project outcome", font=_BODY, alignment=_LEFT_INDENT)]
        line.extend([None] * (len(CHART_FIXED_COLUMNS) - 2))
        line.append(_text(ws, text, font=coloured_bold(colour)))
        ws.append(line)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def generated_line(clock_week: int | None = None, plan_year: int | None = None) -> str:
    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    parts = [f"Generated {now}"]
    if clock_week is not None:
        # P53 (R53-8): the absolute week is never printed raw ("W1 2027", not
        # "W53"); `plan_year` is implied by the label and kept for callers.
        parts.append(f"plan week {week_label(clock_week)}")
    return " · ".join(parts)


def write_workbook(sheets: Mapping[str, Table], *, generated: str | None = None) -> bytes:
    """Every sheet of `sheets` (a `SheetBook` or a plain dict), styled. See
    the module docstring."""

    book = sheets if isinstance(sheets, SheetBook) else SheetBook(sheets)
    gen = generated or generated_line()
    title = book.title or "Export"
    order = book.order or [*book.summaries, *book.charts, *book.keys()]
    wb = Workbook(write_only=True)
    for name in order:
        if name in book.summaries:
            _write_summary(
                wb, name, book.summaries[name], title=f"{title} — Summary",
                context=book.context, generated=gen,
            )  # fmt: skip
        elif name in book.charts:
            _write_chart(wb, name, book.charts[name], gen)
        elif name in book:
            if name in book.reports:
                _write_report(
                    wb, name, book[name], title=title, context=book.context, generated=gen,
                    labels=book.labels,
                )  # fmt: skip
            else:
                _write_table(
                    wb, name, book[name], title=f"{title} — {name}" if len(book) > 1 else title,
                    context=book.context, generated=gen, labels=book.labels,
                    title_block=book.title_block, raw_headers=book.raw_headers,
                )  # fmt: skip
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


__all__ = [
    "CHART_FIRST_WEEK_COLUMN",
    "CHART_FIXED_COLUMNS",
    "CHART_HEADER_ROW",
    "HEADER_LABELS",
    "KIND_LABELS",
    "OUTCOME_STYLES",
    "SECTION",
    "STEP_PALETTE_HEX",
    "TABLE_HEADER_ROW",
    "GanttChart",
    "GanttProjectBar",
    "GanttStepBar",
    "SheetBook",
    "SummaryBlock",
    "book_labels",
    "chart_horizon",
    "generated_line",
    "header_labels",
    "humanize",
    "label_for",
    "neutralise_formula",
    "step_colour",
    "step_ink",
    "step_letter",
    "stringify",
    "write_workbook",
]
