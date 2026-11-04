"""Parse the client's capacity-planning workbook (P32-T04, ADR 0044, docs/API_CONTRACT_P32.md B2).

Pure: bytes in, typed rows / lead times / issues out. No database, no I/O
other than reading the in-memory workbook. Two layers:

1. `read_workbook(data)` opens the `.xlsx` (openpyxl `read_only=True`,
   `data_only=True`: formulas are read as their cached values, never
   evaluated; XML parsed through `defusedxml`, refused otherwise), finds the
   projects sheet and the `Process steps` sheet by CONTENT (header names, step
   codes), never by sheet name or column letter, and returns the raw cell
   values of the known columns only.
2. `map_rows(raw, ctx)` applies every mapping rule of ADR 0044 §4–§6 against
   the plan context (roster, matchable projects, workflows, app lead times).

**What is never read.** Only the columns named in `_FIELDS` are looked at.
`Customer`, `CAPEX`, `Tooling`, `notes`, `Annual volume`, `Business case
summary`, `Comments`, `Region / country`, `Req. Comm. date` (and any other
column) are never copied out of the row tuple, never returned, never logged.

**Limits** (ADR 0044 §11): at most `MAX_SHEETS` sheets, `MAX_COLUMNS` columns
and `MAX_DATA_ROWS` data rows are scanned; a workbook whose parts would
inflate past `MAX_UNCOMPRESSED_BYTES` is refused before openpyxl sees it.
"""

from __future__ import annotations

import io
import math
import re
import zipfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import domain_constants as dc
from scheduling.plan_import import PLAN_BASE_YEAR

#: Weeks are absolute from W1 of this year (ADR 0044 §7): 1..52 = 2026, 53..104 = 2027.
BASE_YEAR = PLAN_BASE_YEAR

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
MAX_DATA_ROWS = 2000
MAX_COLUMNS = 60
MAX_SHEETS = 20
HEADER_SCAN_ROWS = 10
STEPS_SCAN_ROWS = 200
MAX_LEAD_WEEKS = 104
_TEXT_MAX = 200
_RAW_MAX = 100

STEP_LETTERS = "ABCDEFGHIJKLMN"
WORKFLOWS = ("PDD", "OEM")

SEV_INFO = "info"
SEV_WARNING = "warning"
SEV_ERROR = "error"


class ImportFormatError(ValueError):
    """The bytes are not a workbook in the expected format (422 `IMPORT_FORMAT`)."""


# --- context (from the plan) ---------------------------------------------------------------


@dataclass(frozen=True)
class RosterEntry:
    engineer_id: str
    name: str
    hub: str
    capacity_hub: str
    fte: float


@dataclass(frozen=True)
class MatchableProject:
    project_id: str
    name: str
    external_code: str | None
    hub: str
    priority: str | None
    #: The plan project's leader (kept for a blank engineer, ADR 0044 §5 amended).
    leader_engineer_id: str | None = None
    #: The plan project's status, category and current step (the first step,
    #: in walk order, that is neither Done nor skipped): fallbacks for a blank
    #: cell (ADR 0044 amendment 2026-11-05, P32-R06).
    status: str | None = None
    category: str | None = None
    current_step_id: str | None = None


@dataclass(frozen=True)
class StepMeta:
    workflow: str
    step_id: str
    name: str
    kind: str
    sequence_order: int
    predecessor_ids: tuple[str, ...]


@dataclass(frozen=True)
class ParseContext:
    #: Designers that can be matched (FTE > 0, counted in capacity).
    roster: tuple[RosterEntry, ...]
    #: Projects of the caller's hub scope (only these are matchable).
    projects: tuple[MatchableProject, ...]
    steps: tuple[StepMeta, ...]
    #: (workflow, app category) -> {step_id: weeks}
    app_lead_times: Mapping[tuple[str, str], Mapping[str, int]]
    current_week: int
    base_year: int = BASE_YEAR


# --- output ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class ParseIssue:
    row_key: str | None
    file_row: int | None
    field: str | None
    severity: str
    code: str
    message: str


@dataclass(frozen=True)
class LeadTimeRow:
    workflow: str
    label: str
    weeks: dict[str, int]


@dataclass(frozen=True)
class Leader:
    kind: str  # "existing" | "new" | "auto"
    engineer_id: str | None = None
    name: str | None = None


@dataclass(frozen=True)
class ParsedRow:
    key: str
    file_row: int
    sn: str | None
    code: str | None
    plant: str | None
    name: str
    hub: str
    hub_raw: str | None
    category: str
    category_raw: str | None
    lead_time_label: str
    status: str
    status_raw: str | None
    stage_step_id: str | None
    stage_raw: str | None
    rank: int | None
    priority: str
    priority_source: str  # "rank" | "running" | "matched" | "default"
    engineer_raw: str | None
    leader: Leader
    matched_project_id: str | None
    matched_project_name: str | None
    match_by: str | None  # "name" | "code"
    num_projects: int | None
    must_do: bool | None
    spillover_from_previous: bool | None
    complexity: str | None
    est_duration_months: str | None
    certification_testing_required: bool
    step_weeks: dict[str, int]
    include: bool = True


@dataclass(frozen=True)
class ParseCounts:
    rows: int
    schedulable: int
    not_scheduled: int
    matched: int
    new: int
    auto_assign: int
    new_designers: int
    #: Σ max(1, num_projects) over the schedulable included rows.
    projects_after_expansion: int
    #: Rows whose status came from PRIORITY "Running", the matched plan
    #: project or "Spillover from …" = Yes (no Status cell, P32-R06).
    derived_status: int = 0
    #: Rows excluded as budget lines (`NOT_A_PROJECT`, P32-R06).
    not_a_project: int = 0


@dataclass(frozen=True)
class ParseResult:
    projects_sheet: str
    steps_sheet: str | None
    lead_times: tuple[LeadTimeRow, ...]
    rows: tuple[ParsedRow, ...]
    issues: tuple[ParseIssue, ...]
    counts: ParseCounts
    #: Engineer ids matched by at least one row (the response's roster adds
    #: these to the caller's in-scope designers).
    matched_engineer_ids: frozenset[str]


# --- raw reading -----------------------------------------------------------------------------

#: field -> header aliases (normalised: casefold, single spaces). A header
#: cell matches an alias exactly, or starts with it (prefix-tolerant). Exact
#: matches are assigned before prefix matches.
_FIELDS: dict[str, tuple[str, ...]] = {
    "sn": ("s/n", "s.n.", "s/no", "sn"),
    "code": ("project code",),
    "plant": ("plant",),
    "expenses": ("expenses",),
    "priority": ("priority",),
    "name": ("project description",),
    "hub": ("rpd hub",),
    "category": ("project category",),
    "stage": ("pdd project stage", "project stage"),
    "status": ("status",),
    "engineer": ("recommended design engineer", "design engineer"),
    "spillover": ("spillover",),
    # "Num of Models" is the 2026-11-05 workbook's name for the same column.
    "num_projects": (
        "num of projects",
        "number of projects",
        "no. of projects",
        "num of models",
        "num of model(s)",
        "number of models",
        "no. of models",
    ),
    "must_do": ("must do",),
    "complexity": ("complexity",),
    "est_duration": ("est. dur", "est dur", "estimated duration"),
}
_EXPECTED_HEADERS = (
    "S/N, Project code, Plant, Expenses, PRIORITY, Project description, RPD HUB, "
    "Project Category, PDD Project Stage, Status, Recommended Design Engineer, "
    "Spillover from 2026, Num of Projects (or Num of Models), Must Do, Complexity, "
    "Est. Dur. (Months)"
)


@dataclass(frozen=True)
class RawRow:
    file_row: int
    values: dict[str, Any]  # field -> cell value (known fields only)


@dataclass(frozen=True)
class RawWorkbook:
    projects_sheet: str
    rows: tuple[RawRow, ...]
    steps_sheet: str | None
    #: (workflow, label) -> {step_id: weeks}; label as in the file (stripped).
    lead_times: dict[tuple[str, str], dict[str, int]]
    issues: tuple[ParseIssue, ...]
    #: The fields whose column was found in the header row (None: unknown,
    #: inferred from the rows' keys).
    columns: frozenset[str] | None = None


def _norm_header(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split()).casefold()


def _match_headers(cells: Sequence[Any]) -> dict[str, int]:
    normed = [_norm_header(c) for c in cells]
    found: dict[str, int] = {}
    used: set[int] = set()
    for exact in (True, False):
        for fld, aliases in _FIELDS.items():
            if fld in found:
                continue
            for idx, h in enumerate(normed):
                if not h or idx in used:
                    continue
                if any((h == a) if exact else h.startswith(a) for a in aliases):
                    found[fld] = idx
                    used.add(idx)
                    break
    return found


def _is_header(found: Mapping[str, int]) -> bool:
    return "name" in found and ("status" in found or "hub" in found)


def _check_zip(data: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            infos = zf.infolist()
    except zipfile.BadZipFile as exc:
        raise ImportFormatError("The file is not a valid .xlsx workbook.") from exc
    if len(infos) > 2000 or sum(i.file_size for i in infos) > MAX_UNCOMPRESSED_BYTES:
        raise ImportFormatError("The workbook is too large once uncompressed.")


def _open(data: bytes) -> Any:
    import openpyxl
    import openpyxl.xml

    # openpyxl parses through defusedxml when it is importable. Refuse to
    # parse untrusted XML otherwise (entity expansion, external entities).
    if not openpyxl.xml.DEFUSEDXML:  # pragma: no cover - defusedxml is a hard dependency
        raise RuntimeError("defusedxml is required to parse uploaded workbooks")
    _check_zip(data)
    try:
        return openpyxl.load_workbook(
            io.BytesIO(data), read_only=True, data_only=True, keep_links=False
        )
    except Exception as exc:  # openpyxl raises a zoo of types on a corrupt file
        raise ImportFormatError("The file could not be read as an .xlsx workbook.") from exc


def _sheet_rows(ws: Any, max_row: int) -> Iterable[tuple[Any, ...]]:
    rows: Iterable[tuple[Any, ...]] = ws.iter_rows(
        min_row=1, max_row=max_row, max_col=MAX_COLUMNS, values_only=True
    )
    return rows


def _step_code(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    m = re.fullmatch(r"(PDD|OEM)\s*-\s*([A-N])", value.strip(), flags=re.IGNORECASE)
    if not m:
        return None
    return f"{m.group(1).upper()}-{m.group(2).upper()}"


def _section_columns(row: Sequence[Any]) -> tuple[str, dict[str, int]] | None:
    """If `row` holds the 14 step codes of one workflow, (workflow, step -> column)."""

    for wf in WORKFLOWS:
        cols: dict[str, int] = {}
        for idx, cell in enumerate(row):
            code = _step_code(cell)
            if code is not None and code.startswith(wf + "-") and code not in cols:
                cols[code] = idx
        if len(cols) == dc.STEPS_PER_WORKFLOW:
            return wf, cols
    return None


def _lead_value(cell: Any) -> tuple[int, bool]:
    """(weeks, ok). Blank = 0 (ok); non-numeric / negative / fractional /
    over 104 are coerced and reported."""

    if cell is None or (isinstance(cell, str) and not cell.strip()):
        return 0, True
    num: float | None = None
    if isinstance(cell, bool):
        num = None
    elif isinstance(cell, int | float):
        num = float(cell)
    elif isinstance(cell, str):
        try:
            num = float(cell.strip())
        except ValueError:
            num = None
    if num is None or not math.isfinite(num):
        return 0, False
    if num < 0:
        return 0, False
    if num > MAX_LEAD_WEEKS:
        return MAX_LEAD_WEEKS, False
    rounded = round(num)
    return int(rounded), rounded == num


def _row_label(row: Sequence[Any], first_step_col: int) -> str:
    for idx in range(min(first_step_col, len(row))):
        cell = row[idx]
        if cell is not None and str(cell).strip():
            return " ".join(str(cell).split())[:_RAW_MAX]
    return ""


def _read_steps_sheet(
    ws: Any, issues: list[ParseIssue]
) -> dict[tuple[str, str], dict[str, int]] | None:
    rows = list(_sheet_rows(ws, STEPS_SCAN_ROWS))
    table: dict[tuple[str, str], dict[str, int]] = {}
    found_section = False
    i = 0
    while i < len(rows):
        sec = _section_columns(rows[i])
        if sec is None:
            i += 1
            continue
        found_section = True
        wf, cols = sec
        first_col = min(cols.values())
        seen_category = False
        j = i + 1
        while j < len(rows):
            row = rows[j]
            if _section_columns(row) is not None:
                break
            label = _row_label(row, first_col)
            numeric = any(
                isinstance(row[c], int | float) and not isinstance(row[c], bool)
                for c in cols.values()
                if c < len(row)
            )
            if not label:
                if seen_category:
                    break
                j += 1
                continue
            if not numeric and not seen_category:
                # The step-name row or the "Project Category | Lead Times" row.
                j += 1
                continue
            seen_category = True
            weeks: dict[str, int] = {}
            for step, col in sorted(cols.items()):
                value, ok = _lead_value(row[col] if col < len(row) else None)
                weeks[step] = value
                if not ok:
                    issues.append(
                        ParseIssue(
                            None,
                            None,
                            "lead_times",
                            SEV_WARNING,
                            "LEAD_TIME_VALUE",
                            f"Process steps, row {j + 1} ({label}), {step}: the value is not a "
                            f"whole number of weeks between 0 and {MAX_LEAD_WEEKS}; "
                            f"{value} is used.",
                        )
                    )
            key = (wf, label)
            if key not in table:
                table[key] = weeks
            j += 1
        i = j
    return table if found_section else None


def read_workbook(data: bytes) -> RawWorkbook:
    """Layer 1: find the two sheets and read the known columns."""

    wb = _open(data)
    try:
        issues: list[ParseIssue] = []
        sheets = list(wb.worksheets)[:MAX_SHEETS]
        projects: tuple[str, int, dict[str, int], Any] | None = None
        for ws in sheets:
            for r_idx, row in enumerate(_sheet_rows(ws, HEADER_SCAN_ROWS), start=1):
                found = _match_headers(row)
                if _is_header(found):
                    projects = (ws.title, r_idx, found, ws)
                    break
            if projects is not None:
                break
        if projects is None:
            raise ImportFormatError(
                "No projects sheet found: expected a header row (within the first "
                f"{HEADER_SCAN_ROWS} rows) with at least 'Project description' and 'Status' or "
                f"'RPD HUB'. Recognised headers: {_EXPECTED_HEADERS}."
            )
        title, header_row, cols, ws = projects
        raw_rows: list[RawRow] = []
        name_col = cols["name"]
        last = header_row + MAX_DATA_ROWS
        for r_idx, row in enumerate(
            ws.iter_rows(
                min_row=header_row + 1,
                max_row=last + 1,
                max_col=MAX_COLUMNS,
                values_only=True,
            ),
            start=header_row + 1,
        ):
            name = row[name_col] if name_col < len(row) else None
            if name is None or not str(name).strip():
                continue
            if r_idx > last:
                raise ImportFormatError(
                    f"The projects sheet has more than {MAX_DATA_ROWS} data rows."
                )
            raw_rows.append(
                RawRow(
                    file_row=r_idx,
                    values={f: (row[c] if c < len(row) else None) for f, c in cols.items()},
                )
            )

        steps_sheet: str | None = None
        lead: dict[tuple[str, str], dict[str, int]] = {}
        for ws2 in sheets:
            step_issues: list[ParseIssue] = []
            table = _read_steps_sheet(ws2, step_issues)
            if table is not None and any(wf == "PDD" for wf, _ in table):
                steps_sheet = str(ws2.title).strip()[:_RAW_MAX]
                lead = table
                issues.extend(step_issues)
                break
        if steps_sheet is None:
            issues.append(
                ParseIssue(
                    None,
                    None,
                    "lead_times",
                    SEV_WARNING,
                    "NO_PROCESS_STEPS",
                    "No 'Process steps' sheet (a row with PDD-A … PDD-N) was found; "
                    "the app's lead-time table is used for every row.",
                )
            )
        return RawWorkbook(
            projects_sheet=str(title).strip()[:_RAW_MAX],
            rows=tuple(raw_rows),
            steps_sheet=steps_sheet,
            lead_times=lead,
            issues=tuple(issues),
            columns=frozenset(cols),
        )
    finally:
        wb.close()


# --- cell helpers ----------------------------------------------------------------------------


def _text(value: Any, limit: int = _TEXT_MAX) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    s = " ".join(str(value).split())
    return s[:limit] if s else None


def _norm(value: Any) -> str:
    """Case, whitespace (incl. tabs / NBSP) folded."""

    return " ".join(str(value or "").split()).casefold()


def _int_value(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value.is_integer() else None
    s = str(value).strip()
    if re.fullmatch(r"\d+(\.0+)?", s):
        return int(float(s))
    return None


_MAX_NUM_PROJECTS = 100
#: Sentinel: a non-blank Num of Projects that is not a whole number 1..100.
_INVALID_NUM = -1


def _num_projects(value: Any) -> int | None:
    """`Num of Projects` (owner rule 2026-11-04: n >= 2 means n projects).

    None for a blank cell, the count for a whole number 1..100 (`2`, `2.0`,
    `" 3 "`), else `_INVALID_NUM` (the caller warns and reads it as 1)."""

    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        value = int(value)
    n = None if isinstance(value, bool) else _int_value(value)
    if n is None or not 1 <= n <= _MAX_NUM_PROJECTS:
        return _INVALID_NUM
    return n


def _yes_no(value: Any) -> bool | None:
    s = _norm(value)
    if s in ("yes", "y", "true", "1", "x"):
        return True
    if s in ("no", "n", "false", "0"):
        return False
    return None


# --- mapping ---------------------------------------------------------------------------------

_INDIA = "__india__"
_STATUS_MAP: dict[str, str] = {
    "que": "In Queue",
    "in que": "In Queue",
    "queue": "In Queue",
    "in queue": "In Queue",
    "development": "In Development",
    "in development": "In Development",
    "industrialization": "Under Industrialization",
    "industrialisation": "Under Industrialization",
    "under industrialization": "Under Industrialization",
    "on hold": "On Hold",
    "in buyoff": "In Buyoff",
    "commercialized": "Commercialized",
    "cancelled": "Cancelled",
}
_NOT_SCHEDULED = frozenset({"Commercialized", "On Hold", "Cancelled"})
_STATUS_VALUES = frozenset(_STATUS_MAP.values())
_SCHEDULABLE = frozenset(dc.SCHEDULABLE_STATUS_ORDER)
_CATEGORY_BASE: dict[str, tuple[str, str]] = {
    # normalised raw -> (base category, file label)
    "a+": ("A+", "A+"),
    "a": ("A", "A"),
    "b": ("B", "B"),
    "c": ("C", "C"),
    "c+": ("C", "C+"),
    "d": ("C", "D"),
    "a-oem": ("A-OEM", "A-OEM"),
    "b-oem": ("B-OEM", "B-OEM"),
    "c-oem": ("C-OEM", "C-OEM"),
}
_TO_OEM = {"A+": "A-OEM", "A": "A-OEM", "B": "B-OEM", "C": "C-OEM"}
SPECIAL_LABEL = "Special Category"
_NO_ENGINEER = frozenset({"", "tbc", "tbd", "tba", "-", "--", "n/a", "na", "none", "?"})
_REAL_CODE = re.compile(r"^\d{2}-\d{5}")


def _hub_token(value: Any) -> tuple[str | None, bool]:
    """(hub or `_INDIA` or None, oem_defaulted)."""

    s = _norm(value)
    if not s:
        return None, False
    for hub in dc.HUB_LAB_REGION:
        if s == hub.casefold():
            return hub, False
    compact = re.sub(r"[\s_]+", " ", s)
    if compact in ("greece", "gr", "r&d greece", "rd greece"):
        return "R&D-Greece", False
    if compact in ("pd rom", "rom", "romania", "pd romania", "pd-rom", "ro"):
        return "PD-Romania", False
    if compact in ("india", "ind", "inn", "saf", "egypt"):
        return _INDIA, False
    if compact.startswith("oem"):
        rest = re.sub(r"^oem[\s/\-_]*", "", compact)
        if rest.startswith("hck"):
            return "OEM-HCK", False
        if rest.startswith("seitek") or rest.startswith("seltek"):
            return "OEM-Seitek", False
        return "OEM-HCK", True
    return None, False


_ROM_PARTNER = re.compile(r"^(?:pd[\s\-]*)?rom(?:ania)?\s*/\s*(\S.*)$")


def _rom_partner(value: Any) -> str | None:
    """`Rom/<partner>` (P32-R06): the partner text as written, else None."""

    text = _text(value, _RAW_MAX)
    if text is None:
        return None
    m = _ROM_PARTNER.match(text.casefold())
    if m is None:
        return None
    return text.split("/", 1)[1].strip() or None


#: A row with a blank PRIORITY whose description matches one of these is a
#: budget line, not a project (P32-R06, `NOT_A_PROJECT`).
_BUDGET_LINE = (
    re.compile(r"^provision\b"),
    # CAPEX only as a short budget heading ("R&D CAPEX", "PDD Europe CAPEX
    # Romania": at most 3 words before, 2 after), never a project that
    # mentions CAPEX in a sentence ("… feasibility to define cost & capex").
    re.compile(r"^(?:\S+\s+){0,3}capex(?:\s+\S+){0,2}$"),
    re.compile(r"certification program"),
    re.compile(r"^update certification"),
)
_RUNNING = "running"
#: The rank of a "Running" row: first in its band (the schema allows 0; the service
#: shifts every rank by one before the engine, which takes 1..9999).
RUNNING_RANK = 0
#: An OEM category given to a non-OEM workflow (a plan fallback only).
_FROM_OEM = {"A-OEM": "A", "B-OEM": "B", "C-OEM": "C"}


def is_budget_line(name: str) -> bool:
    n = _norm(name)
    return any(p.search(n) for p in _BUDGET_LINE)


def _tokens(name: str) -> list[str]:
    return [t for t in re.split(r"[\s\-_.]+", name.casefold()) if t]


@dataclass
class _Roster:
    entries: tuple[RosterEntry, ...]
    by_full: dict[str, list[RosterEntry]] = field(default_factory=dict)
    by_first: dict[str, list[RosterEntry]] = field(default_factory=dict)
    by_last: dict[str, list[RosterEntry]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for e in self.entries:
            if not (e.fte > 0):
                continue
            toks = _tokens(e.name)
            if not toks:
                continue
            self.by_full.setdefault(" ".join(toks), []).append(e)
            self.by_first.setdefault(toks[0], []).append(e)
            self.by_last.setdefault(toks[-1], []).append(e)

    def match(self, raw: str) -> RosterEntry | None:
        toks = _tokens(raw)
        if not toks:
            return None
        for table, key in (
            (self.by_full, " ".join(toks)),
            (self.by_first, toks[0]),
            (self.by_last, toks[-1]),
        ):
            hits = table.get(key, [])
            if len(hits) == 1:
                return hits[0]
        return None


def _workflow_of(hub: str) -> str:
    return dc.WORKFLOW_ID_FOR_OEM_HUB if hub in dc.OEM_HUBS else dc.WORKFLOW_ID_FOR_NON_OEM_HUB


def map_rows(raw: RawWorkbook, ctx: ParseContext) -> ParseResult:
    """Layer 2: ADR 0044 §4–§6 on every raw row."""

    issues: list[ParseIssue] = list(raw.issues)
    roster = _Roster(ctx.roster)
    roster_by_id = {e.engineer_id: e for e in ctx.roster if e.fte > 0}
    steps_by_wf: dict[str, list[StepMeta]] = {}
    for s in sorted(ctx.steps, key=lambda s: (s.workflow, s.sequence_order)):
        steps_by_wf.setdefault(s.workflow, []).append(s)
    file_lead = {
        (wf, _norm(label)): (label, weeks) for (wf, label), weeks in raw.lead_times.items()
    }

    # Matching indexes (ADR 0044 §4).
    proj_by_name: dict[str, list[MatchableProject]] = {}
    proj_by_code: dict[str, list[MatchableProject]] = {}
    for p in ctx.projects:
        proj_by_name.setdefault(_norm(p.name), []).append(p)
        if p.external_code:
            proj_by_code.setdefault(_norm(p.external_code), []).append(p)
    file_names = Counter(_norm(r.values.get("name")) for r in raw.rows)
    file_codes = Counter(
        _norm(r.values.get("code"))
        for r in raw.rows
        if _REAL_CODE.match(str(r.values.get("code") or "").strip())
    )
    claimed: dict[str, int] = {}  # project_id -> file_row that took it
    seen_names: dict[str, int] = {}
    # P32-R06: the 2026-11-05 workbook has no Status column.
    columns = (
        raw.columns if raw.columns is not None else frozenset(f for r in raw.rows for f in r.values)
    )
    has_status_col = "status" in columns
    if raw.rows and not has_status_col:
        issues.append(
            ParseIssue(
                None,
                None,
                "status",
                SEV_INFO,
                "STATUS_NOT_IN_FILE",
                "The file has no Status column; statuses were derived from PRIORITY, the plan "
                "and Spillover from 2026.",
            )
        )
    derived_n = 0
    budget_n = 0

    rows: list[ParsedRow] = []
    matched_engineers: set[str] = set()
    for rr in raw.rows:
        v = rr.values
        key = f"row-{rr.file_row}"

        def issue(
            fld: str | None, sev: str, code: str, msg: str, _k: str = key, _r: int = rr.file_row
        ) -> None:
            issues.append(ParseIssue(_k, _r, fld, sev, code, msg))

        name = _text(v.get("name"), 300) or ""
        nname = _norm(name)
        if nname in seen_names:
            issue(
                "name",
                SEV_WARNING,
                "DUPLICATE_ROW",
                f"Row {rr.file_row} has the same project description as row "
                f"{seen_names[nname]}; both are imported.",
            )
        else:
            seen_names[nname] = rr.file_row

        code_raw = _text(v.get("code"), 64)
        special = _norm(code_raw) == _norm(SPECIAL_LABEL)
        code = None if special else code_raw

        # Engineer (resolved first: the India hub depends on the leader's hub).
        eng_raw = _text(v.get("engineer"), _RAW_MAX)
        match = None
        if eng_raw is not None and _norm(eng_raw) not in _NO_ENGINEER:
            match = roster.match(eng_raw)

        # Matching (ADR 0044 §4).
        matched: MatchableProject | None = None
        match_by: str | None = None
        cands = proj_by_name.get(nname, [])
        if len(cands) == 1 and file_names[nname] == 1:
            matched, match_by = cands[0], "name"
        elif code is not None and _REAL_CODE.match(code):
            ccands = proj_by_code.get(_norm(code), [])
            if len(ccands) == 1 and file_codes[_norm(code)] == 1:
                matched, match_by = ccands[0], "code"
            elif ccands or cands:
                issue(
                    "name",
                    SEV_INFO,
                    "MATCH_AMBIGUOUS",
                    "The row matches more than one plan project or row; it is imported as a "
                    "new project.",
                )
        elif cands:
            issue(
                "name",
                SEV_INFO,
                "MATCH_AMBIGUOUS",
                "The row matches more than one plan project or row; it is imported as a new "
                "project.",
            )
        if matched is not None and matched.project_id in claimed:
            issue(
                "name",
                SEV_INFO,
                "MATCH_AMBIGUOUS",
                f"Row {claimed[matched.project_id]} already replaces the same plan project; "
                "this row is imported as a new project.",
            )
            matched, match_by = None, None
        if matched is not None:
            claimed[matched.project_id] = rr.file_row
            issue(
                "name",
                SEV_INFO,
                "MATCHED",
                f"Replaces the plan project {matched.name!r} (matched by {match_by}).",
            )

        # ADR 0044 §5 (amended 2026-11-04): a blank / TBC engineer on a row
        # matched to a plan project takes that project's leader (when they are
        # on the roster: FTE > 0, counted in capacity).
        leader_from_plan = False
        if (
            match is None
            and (eng_raw is None or _norm(eng_raw) in _NO_ENGINEER)
            and matched is not None
            and matched.leader_engineer_id in roster_by_id
        ):
            match = roster_by_id[str(matched.leader_engineer_id)]
            leader_from_plan = True

        # Hub (ADR 0044 §5; P32-R06: Rom/<partner>, the plan's hub for a blank cell).
        hub_raw = _text(v.get("hub"), _RAW_MAX)
        hub: str | None = None
        oem_defaulted = False
        source = None
        partner = _rom_partner(v.get("hub"))
        if partner is not None and _norm(partner).startswith("oem"):
            seitek = any(t in _norm(v.get("expenses")) for t in ("seitek", "seltek"))
            hub, source = ("OEM-Seitek" if seitek else "OEM-HCK"), "hub"
            oem_defaulted = not seitek
            issue(
                "hub",
                SEV_INFO,
                "HUB_MAPPED",
                f"RPD HUB {hub_raw!r} is a Romania OEM project; {hub} is used"
                + (" (Seitek in Expenses)." if seitek else "."),
            )
        elif partner is not None:
            hub, source = "PD-Romania", "hub"
            issue(
                "hub",
                SEV_INFO,
                "HUB_MAPPED",
                f"RPD HUB {hub_raw!r} is PD-Romania working with {partner[:40]}; "
                "PD-Romania is used.",
            )
        else:
            tok, oem_def = _hub_token(v.get("hub"))
            if tok is not None:
                hub, oem_defaulted, source = tok, oem_def, "hub"
            elif matched is not None:
                hub, source = matched.hub, "plan"
                issue(
                    "hub",
                    SEV_INFO,
                    "HUB_FROM_PLAN",
                    f"RPD HUB is blank or not recognised; the matched plan project's hub "
                    f"{hub} is used.",
                )
            else:
                for fld in ("expenses", "plant"):
                    tok, oem_def = _hub_token(v.get(fld))
                    if tok is not None:
                        hub, oem_defaulted, source = tok, oem_def, fld
                        break
        if hub == _INDIA:
            hub = (
                "R&D-India"
                if match is not None and match.capacity_hub == "R&D-India"
                else "PD-India"
            )
        if hub is None:
            hub = match.capacity_hub if match is not None else "R&D-Greece"
            issue(
                "hub",
                SEV_WARNING,
                "HUB_DEFAULTED",
                f"No recognisable hub in RPD HUB / Expenses / Plant; {hub} is used.",
            )
        elif source in ("expenses", "plant"):
            issue(
                "hub",
                SEV_INFO,
                "HUB_DEFAULTED",
                f"RPD HUB is blank or not recognised; {hub} is taken from "
                f"{'Expenses' if source == 'expenses' else 'Plant'}.",
            )
        if oem_defaulted:
            issue(
                "hub",
                SEV_WARNING,
                "HUB_OEM_DEFAULTED",
                f"OEM hub '{_text(v.get(source or 'hub'), 40)}' is not an app hub; OEM-HCK is "
                "used (both OEM hubs share R&D-Greece capacity).",
            )

        cat_raw = _text(v.get("category"), _RAW_MAX)
        ncat = _norm(cat_raw)
        cat_from_plan = False
        if ncat == _norm(SPECIAL_LABEL):
            special, ncat = True, ""
        stage_raw = _text(v.get("stage"), _RAW_MAX)
        stage_code = _step_code(stage_raw)
        cat_is_oem = ncat in ("a-oem", "b-oem", "c-oem")
        stage_is_oem = stage_code is not None and stage_code.startswith("OEM-")
        if hub not in dc.OEM_HUBS and (cat_is_oem or stage_is_oem):
            forced = None
            for fld in ("hub", "expenses", "plant"):
                tok, _ = _hub_token(v.get(fld))
                if tok in dc.OEM_HUBS:
                    forced = tok
                    break
            hub = forced or "OEM-HCK"
            issue(
                "hub",
                SEV_WARNING,
                "HUB_OEM_DEFAULTED",
                f"The {'category' if cat_is_oem else 'stage'} is OEM but the hub is not; "
                f"{hub} is used.",
            )
        wf = _workflow_of(hub)

        # Category and the lead-time row (ADR 0044 §5, §6).
        if ncat in _CATEGORY_BASE:
            category, label = _CATEGORY_BASE[ncat]
            if label != category:
                issue(
                    "category",
                    SEV_INFO,
                    "CATEGORY_MAPPED",
                    f"Category {label} uses its own lead times from the file and is scheduled "
                    f"as {category}.",
                )
        elif special:
            category, label = "A+", SPECIAL_LABEL
            issue(
                "category",
                SEV_INFO,
                "CATEGORY_MAPPED",
                "Special Category uses the file's Special Category lead times and is "
                "scheduled as A+.",
            )
        elif (
            not cat_raw
            and matched is not None
            and (matched.category in _TO_OEM or matched.category in _FROM_OEM)
        ):
            # P32-R06: a blank category takes the matched plan project's.
            category = label = str(matched.category)
            cat_from_plan = True
            issue(
                "category",
                SEV_INFO,
                "CATEGORY_FROM_PLAN",
                f"Category is blank; the matched plan project's category {category} is used.",
            )
            if wf != "OEM" and category in _FROM_OEM:
                category = label = _FROM_OEM[category]
                issue(
                    "category",
                    SEV_INFO,
                    "CATEGORY_MAPPED",
                    f"{hub} is not an OEM hub; the plan's OEM category is scheduled as {category}.",
                )
        else:
            category = "B"
            label = "B"
            issue(
                "category",
                SEV_WARNING,
                "CATEGORY_DEFAULTED",
                f"Category {'is blank' if not cat_raw else f'{cat_raw!r} is not recognised'}; "
                f"{'B-OEM' if wf == 'OEM' else 'B'} is used.",
            )
        if special and ncat in _CATEGORY_BASE:
            label = SPECIAL_LABEL
        if wf == "OEM" and category in _TO_OEM:
            mapped = _TO_OEM[category]
            if ncat in _CATEGORY_BASE or special or cat_from_plan:
                issue(
                    "category",
                    SEV_INFO,
                    "CATEGORY_MAPPED",
                    f"An OEM-hub project needs an OEM category; {mapped} is used.",
                )
            category, label = mapped, mapped

        steps = steps_by_wf.get(wf, [])
        step_ids = [s.step_id for s in steps]
        app_row = ctx.app_lead_times.get((wf, category), {})
        if raw.steps_sheet is None:
            lead_label = "app"
            step_weeks = {s: int(app_row.get(s, 0)) for s in step_ids}
        else:
            hit = file_lead.get((wf, _norm(label)))
            if hit is None and label != category:
                hit = file_lead.get((wf, _norm(category)))
                if hit is not None:
                    issue(
                        "category",
                        SEV_WARNING,
                        "LEAD_TIME_ROW_MISSING",
                        f"The Process steps sheet has no '{label}' row; its '{category}' row "
                        "is used.",
                    )
            if hit is None:
                lead_label = "app"
                step_weeks = {s: int(app_row.get(s, 0)) for s in step_ids}
                issue(
                    "category",
                    SEV_INFO if label == category else SEV_WARNING,
                    "LEAD_TIME_ROW_MISSING",
                    f"The Process steps sheet has no '{label}' row; the app's lead times for "
                    f"{category} are used.",
                )
            else:
                lead_label = hit[0]
                step_weeks = {s: int(hit[1].get(s, 0)) for s in step_ids}

        # Status (P32-R06: derived when the column is absent or the cell blank;
        # first match wins: Running, the matched plan project, Spillover = Yes).
        rank_cell = v.get("priority")
        priority_blank = rank_cell is None or not str(rank_cell).strip()
        running = _norm(rank_cell) == _RUNNING
        spill = _yes_no(v.get("spillover"))
        status_raw = _text(v.get("status"), _RAW_MAX)
        nstat = _norm(status_raw)
        plan_status = (
            matched.status if matched is not None and matched.status in _STATUS_VALUES else None
        )
        if nstat in _STATUS_MAP:
            status = _STATUS_MAP[nstat]
        elif status_raw is None and running:
            status = "In Development"
            derived_n += 1
            issue(
                "status",
                SEV_INFO,
                "STATUS_FROM_RUNNING",
                "Status is not given; PRIORITY says Running, so In Development is used.",
            )
        elif status_raw is None and plan_status is not None:
            status = str(plan_status)
            derived_n += 1
            issue(
                "status",
                SEV_INFO,
                "STATUS_FROM_PLAN",
                f"Status is not given; the matched plan project's status {status} is used.",
            )
        elif status_raw is None and spill is True:
            status = "In Development"
            derived_n += 1
            issue(
                "status",
                SEV_INFO,
                "STATUS_FROM_SPILLOVER",
                "Status is not given; the row is a spillover from the previous year, so In "
                "Development is used.",
            )
        else:
            status = "In Queue"
            if has_status_col or status_raw is not None:
                why = "is blank" if not status_raw else f"{status_raw!r} is not recognised"
                issue(
                    "status",
                    SEV_WARNING,
                    "STATUS_DEFAULTED",
                    f"Status {why}; In Queue is used.",
                )
        if status in _NOT_SCHEDULED:
            issue(
                "status",
                SEV_INFO,
                "STATUS_NOT_SCHEDULED",
                f"{status} — not mapped (listed for review, never simulated).",
            )

        # Stage.
        stage_step_id: str | None = None
        if stage_raw is not None:
            if stage_code is None:
                issue(
                    "stage",
                    SEV_WARNING,
                    "STAGE_UNKNOWN",
                    f"Stage {stage_raw!r} is not a step code; the workflow's first step is used.",
                )
            else:
                letter = stage_code[-1]
                stage_step_id = f"{wf}-{letter}"
                if not stage_code.startswith(wf + "-"):
                    issue(
                        "stage",
                        SEV_WARNING,
                        "STAGE_WORKFLOW_MISMATCH",
                        f"Stage {stage_code} is mapped to {stage_step_id} ({hub} follows the "
                        f"{wf} workflow).",
                    )
        elif (
            matched is not None
            and matched.current_step_id is not None
            and matched.current_step_id.startswith(wf + "-")
        ):
            # P32-R06: a blank stage takes the matched plan project's current
            # step (the first step, in walk order, neither Done nor skipped).
            stage_step_id = matched.current_step_id
            issue(
                "stage",
                SEV_INFO,
                "STAGE_FROM_PLAN",
                f"Stage is blank; the matched plan project's current step {stage_step_id} is used.",
            )

        # Priority (ADR 0044 §5; P32-R06: "Running" is P1, rank 0, first).
        rank = None
        if running:
            rank = RUNNING_RANK
        elif not priority_blank:
            rank = _int_value(rank_cell)
            if rank is None or not (1 <= rank <= 9999):
                issue(
                    "priority",
                    SEV_WARNING,
                    "RANK_INVALID",
                    "PRIORITY is not a whole rank from 1; it is ignored.",
                )
                rank = None
        if running:
            priority, psrc = "P1", "running"
        elif rank is not None:
            priority, psrc = "P1", "rank"
        elif matched is not None and matched.priority in dc.PRIORITY_ORDER:
            priority, psrc = str(matched.priority), "matched"
        else:
            priority, psrc = "P3", "default"

        # Leader.
        if match is not None:
            leader = Leader("existing", match.engineer_id, match.name)
            matched_engineers.add(match.engineer_id)
            if leader_from_plan:
                issue(
                    "engineer",
                    SEV_INFO,
                    "ENGINEER_FROM_PLAN",
                    "No design engineer is named; the matched plan project's leader is kept "
                    "(choose another to replace it).",
                )
        elif eng_raw is None or _norm(eng_raw) in _NO_ENGINEER:
            leader = Leader("auto")
            issue(
                "engineer",
                SEV_WARNING,
                "ENGINEER_MISSING",
                "No design engineer is named; one is auto-assigned (choose one to replace it).",
            )
        else:
            leader = Leader("new", None, eng_raw)
            issue(
                "engineer",
                SEV_WARNING,
                "ENGINEER_UNKNOWN",
                f"{eng_raw!r} is not on the roster; a new What-if designer of that name is "
                f"added to {dc.capacity_hub_name(hub)} (FTE 1.0).",
            )

        # P32-R06: a budget line (blank PRIORITY, a description such as
        # "Provision for …", "… CAPEX …", "… Certification program") is not a
        # project: excluded, the planner can include it on Review.
        budget = priority_blank and is_budget_line(name)
        if budget:
            budget_n += 1
            issue(
                "name",
                SEV_INFO,
                "NOT_A_PROJECT",
                "Looks like a budget line, not a project — excluded; include it on Review if it "
                "is a project.",
            )

        num = _num_projects(v.get("num_projects"))
        if num is _INVALID_NUM:
            num = None
            issue(
                "num_projects",
                SEV_WARNING,
                "NUM_PROJECTS_INVALID",
                f"Num of Projects {_text(v.get('num_projects'), 40)!r} is not a whole number "
                f"from 1 to {_MAX_NUM_PROJECTS}; the row is read as 1 project.",
            )
        rows.append(
            ParsedRow(
                key=key,
                file_row=rr.file_row,
                sn=_text(v.get("sn"), 20),
                code=code,
                plant=_text(v.get("plant"), _RAW_MAX),
                name=name,
                hub=hub,
                hub_raw=hub_raw,
                category=category,
                category_raw=cat_raw,
                lead_time_label=lead_label,
                status=status,
                status_raw=status_raw,
                stage_step_id=stage_step_id,
                stage_raw=stage_raw,
                rank=rank,
                priority=priority,
                priority_source=psrc,
                engineer_raw=eng_raw,
                leader=leader,
                matched_project_id=matched.project_id if matched else None,
                matched_project_name=matched.name if matched else None,
                match_by=match_by,
                num_projects=num,
                must_do=_yes_no(v.get("must_do")),
                spillover_from_previous=spill,
                complexity=_text(v.get("complexity"), 20),
                est_duration_months=_text(v.get("est_duration"), 40),
                certification_testing_required=True,
                step_weeks=step_weeks,
                # Owner rule 2026-11-04: On Hold / Cancelled / Commercialized
                # rows are not mapped.
                include=status in _SCHEDULABLE and not budget,
            )
        )

    lead_rows = tuple(
        LeadTimeRow(workflow=wf, label=label, weeks=dict(weeks))
        for (wf, label), weeks in raw.lead_times.items()
    )
    new_designers = {
        (_norm(r.leader.name), dc.capacity_hub_name(r.hub)) for r in rows if r.leader.kind == "new"
    }
    schedulable = sum(1 for r in rows if r.status in _SCHEDULABLE)
    matched_n = sum(1 for r in rows if r.matched_project_id)
    # Owner rule 2026-11-04: Num of Projects n >= 2 is n projects (the
    # simulate default expands); blank / 1 / invalid is one.
    after_expansion = sum(
        max(1, r.num_projects or 1) for r in rows if r.include and r.status in _SCHEDULABLE
    )
    counts = ParseCounts(
        rows=len(rows),
        schedulable=schedulable,
        not_scheduled=len(rows) - schedulable,
        matched=matched_n,
        new=len(rows) - matched_n,
        auto_assign=sum(1 for r in rows if r.leader.kind == "auto"),
        new_designers=len(new_designers),
        projects_after_expansion=after_expansion,
        derived_status=derived_n,
        not_a_project=budget_n,
    )
    order = {r.key: i for i, r in enumerate(rows)}
    issues.sort(key=lambda i: -1 if i.row_key is None else order.get(i.row_key, 0))
    return ParseResult(
        projects_sheet=raw.projects_sheet,
        steps_sheet=raw.steps_sheet,
        lead_times=lead_rows,
        rows=tuple(rows),
        issues=tuple(issues),
        counts=counts,
        matched_engineer_ids=frozenset(matched_engineers),
    )


def parse_plan_workbook(data: bytes, ctx: ParseContext) -> ParseResult:
    if len(data) > MAX_FILE_BYTES:
        raise ImportFormatError("The file is larger than 5 MB.")
    return map_rows(read_workbook(data), ctx)
