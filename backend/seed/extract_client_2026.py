"""Extract the client's real 2026 project pipeline (ADR 0024) from their Excel
workbook into `client_2026_seed_data.json`, the default dataset of
`seed_demo_data.py`.

The workbook (`24-25-26 Global RPD Project Pipeline.xlsx`) is client data and
is never committed; only the JSON this script writes is. Treat the workbook as
untrusted input: run this with an isolated interpreter and pass the path as an
argument, from a directory that is not the workbook's own:

    uv run --no-project --with openpyxl python -I backend/seed/extract_client_2026.py \\
        /path/to/pipeline.xlsx [backend/seed/client_2026_seed_data.json]

It depends on the standard library plus `openpyxl` only (no backend imports),
so it runs under `python -I` without the backend's virtualenv.

Source and selection
--------------------
- Sheet `2024-25-26 Projects`. The header is row 5 and data starts at row 6.
  Only rows with a Project Name (column I) are read.
- The dataset is every row whose `Project Request (MM/YY)` (column B) falls in
  **2026**: 253 projects. Every one of them is kept, including Cancelled,
  Commercialized and On Hold rows. Those statuses are displayed but never
  scheduled (DOMAIN_RULES "Booking rules").

Column mapping (0-based column index → JSON field)
--------------------------------------------------
- 0 `S.No.` → `s_no`. It is not unique in the sheet (596 repeats), so it is
  traceability only.
- 1 request date → `request_date` (ISO date) and `request_week` (ISO week).
  A `datetime` cell is used as is. A text cell `MM/YY` or `MM/YYYY` is parsed
  to the first of that month.
- 2 `Marketing Priority` (rank 1..13 or blank) → `marketing_priority`.
- 6 `Online PD Database Project Code`, 7 `RM Saving Project Codes` and 0 →
  `external_code`, which must be unique (`projects.external_code`). The first
  usable value wins:
  1. column 6 if it looks like `NN-NNNNN` (the PD database form);
  2. else column 7 unless it is one of `N/A`, `NA`, `Missing`, `-`, `TBD`,
     `TBA`, `TBR` or blank;
  3. else the generated code `26-S{S.No:04d}`.
  A code already taken by an earlier row (sheet order) falls through to the
  next rule. A generated code that is still taken gets `-2`, `-3`, ...
  `code_source` records which rule applied.
- 8 `Project Name` → `name`: whitespace collapsed, capped at 300 characters.
- 9 `Plant/OEM` → `plant`. Traceability only; there is no plant column.
- 10 `RPDO hub` → `hub`. `OEM-Seitek` and `OEM-SEITEK` (the workbook's
  spellings) map to the app hub `OEM-Seltek`. Every other value must be one of
  the six app hubs, otherwise the script fails loudly.
- 4 `Project Category` → `category`, with the OEM rule (ADR 0007): a project
  on an OEM hub carries `A-OEM`/`B-OEM`/`C-OEM` (`A+`/`A` → `A-OEM`, `B` →
  `B-OEM`, `C` → `C-OEM`). An `X-OEM` category on a non-OEM hub becomes `X`.
- 5 `Project Type` → `type`. `CO`, `NO`, `NM`, `IMP` and `RC` map one to one.
  `BC` (Business Continuity), `AC` (Alternative Component) and `SER`
  (Service) are in the workbook's own vocabulary (`Lists & Explanations`) but
  not in the app's `ProjectType` enum, so `type` is null for them. The raw
  code is kept in `excel_type`.
- 18 `Certification Testing Required` → `certification_testing_required`:
  true only for `Yes`. `No` and blank both give false. This matches the
  client's own lab-load pivot, which sums lab weeks only for projects flagged
  "Yes" (docs/CLIENT_FORMULAS.md §2.3).
- 32 `Project Status` → `status`: `In Que` → In Queue, `Development` → In
  Development, `Industrialization` → Under Industrialization, and
  `Commercialized`, `On Hold`, `Cancelled` unchanged. Any other value fails
  loudly.
- 33 `Project Review Remarks` → `comments`: trimmed, null when blank, capped
  at 4000 characters.
- 34 `Project Leader` → `leader`: trimmed. For a shared value such as
  `Lokesh/Rahul`, only the first name is kept. Null when blank. The leader
  roster is derived from this column (`leaders`, below).
- 44 `Customer` → `customer` (`ALL`/`COKE`/`KA`/`WM`, upper-cased; null when
  blank). This is the encrypted `customer_name` field. It is written here
  because it is the client's own data. It is never logged.
- 52 `Development Step` → `development_step`. Kept only when it is a workflow
  step id (`PDD-A`..`PDD-N` or `OEM-A`..`OEM-N`). `Not Started` and blank
  give null.
- 3 `Project to be considered for Capacity Calculation` → `capacity_flag`.
  Traceability only.

The workbook has no financial values for these rows (TCOGS, selling price,
gross margin), so none are emitted.

Priority (no prioritization dimensions in the workbook)
-------------------------------------------------------
- `priority` is P1 for Marketing Priority 1–5 and P2 for 6–13.
- An unranked row gets a band from its status:
  - Under Industrialization or In Development → P3;
  - In Queue → P4;
  - the non-scheduled statuses (Commercialized, On Hold, Cancelled) → P4.
- The 13 dimension scores are derived deterministically by `seed_demo_data`
  so that their band equals `priority` (see `seed/client_2026.py`).

Leaders → engineers
-------------------
`leaders` lists every distinct leader with the hub where they lead the most
rows of this dataset. Ties go to the alphabetically first hub. The seed
turns these into engineers, adds the named capacity engineers, and fills
blank leaders (`seed/client_2026.py`).
"""

from __future__ import annotations

import datetime as _dt
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

SHEET = "2024-25-26 Projects"
HEADER_ROW = 5
FIRST_DATA_ROW = 6
REQUEST_YEAR = 2026

# 0-based column indexes (header row 5).
COL_SNO = 0
COL_REQUEST = 1
COL_MKT_PRIORITY = 2
COL_CAPACITY_FLAG = 3
COL_CATEGORY = 4
COL_TYPE = 5
COL_PD_CODE = 6
COL_RM_CODE = 7
COL_NAME = 8
COL_PLANT = 9
COL_HUB = 10
COL_CERT = 18
COL_STATUS = 32
COL_REMARKS = 33
COL_LEADER = 34
COL_CUSTOMER = 44
COL_DEV_STEP = 52

#: Header text expected at each used column. A changed layout fails loudly
#: instead of silently reading the wrong column.
EXPECTED_HEADERS = {
    COL_SNO: "S.No.",
    COL_REQUEST: "Project Request (MM/YY)",
    COL_MKT_PRIORITY: "Marketing Priority",
    COL_CATEGORY: "Project Category",
    COL_TYPE: "Project Type",
    COL_PD_CODE: "Online PD Database Project Code",
    COL_NAME: "Project Name",
    COL_HUB: "RPDO hub",
    COL_CERT: "Certification Testing Required",
    COL_STATUS: "Project Status",
    COL_LEADER: "Project Leader",
    COL_CUSTOMER: "Customer",
    COL_DEV_STEP: "Development Step",
}

HUB_MAP = {
    "R&D-Greece": "R&D-Greece",
    "R&D-India": "R&D-India",
    "PD-India": "PD-India",
    "PD-Romania": "PD-Romania",
    "OEM-HCK": "OEM-HCK",
    "OEM-Seltek": "OEM-Seltek",
    "OEM-Seitek": "OEM-Seltek",
    "OEM-SEITEK": "OEM-Seltek",
}
OEM_HUBS = frozenset({"OEM-HCK", "OEM-Seltek"})

STATUS_MAP = {
    "In Que": "In Queue",
    "In Queue": "In Queue",
    "Development": "In Development",
    "Industrialization": "Under Industrialization",
    "Commercialized": "Commercialized",
    "On Hold": "On Hold",
    "Cancelled": "Cancelled",
}
SCHEDULED_STATUSES = frozenset({"In Queue", "In Development", "Under Industrialization"})

TYPE_MAP = {"CO": "CO", "NO": "NO", "NM": "NM", "IMP": "IMP", "RC": "RC"}

_TO_OEM = {"A+": "A-OEM", "A": "A-OEM", "B": "B-OEM", "C": "C-OEM"}
_FROM_OEM = {"A-OEM": "A", "B-OEM": "B", "C-OEM": "C"}
_ALL_CATEGORIES = frozenset({"A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM"})

_PD_CODE_RE = re.compile(r"^\d{2}-\d{3,6}$")
_RM_CODE_RE = re.compile(r"^[A-Za-z0-9_\-]{3,60}$")
_STEP_ID_RE = re.compile(r"^(PDD|OEM)-[A-N]$")
_NO_CODE = frozenset({"", "N/A", "NA", "MISSING", "-", "TBD", "TBA", "TBR"})
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

NAME_MAX = 300
COMMENTS_MAX = 4000
LEADER_MAX = 200


def _text(value: Any) -> str:
    """A cell as clean text: control characters removed, whitespace trimmed."""

    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return _CONTROL_RE.sub("", str(value)).strip()


def _one_line(value: Any) -> str:
    return " ".join(_text(value).split())


def _request_date(value: Any) -> _dt.date | None:
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    text = _text(value)
    match = re.fullmatch(r"(\d{1,2})/(\d{2}|\d{4})", text)
    if not match:
        return None
    month, year = int(match.group(1)), int(match.group(2))
    if year < 100:
        year += 2000
    if not 1 <= month <= 12:
        return None
    return _dt.date(year, month, 1)


def _marketing_priority(value: Any) -> int | None:
    text = _text(value)
    if not text:
        return None
    try:
        rank = float(text)
    except ValueError:
        return None
    if not rank.is_integer() or rank < 1:
        return None
    return int(rank)


def priority_for(marketing_priority: int | None, status: str) -> str:
    """Band from the Marketing Priority rank, else from the status (docstring)."""

    if marketing_priority is not None:
        if marketing_priority <= 5:
            return "P1"
        if marketing_priority <= 13:
            return "P2"
    if status in ("Under Industrialization", "In Development"):
        return "P3"
    return "P4"


def category_for(hub: str, excel_category: str) -> str:
    """The OEM category rule (ADR 0007), both directions."""

    if excel_category not in _ALL_CATEGORIES:
        raise ValueError(f"unknown Project Category {excel_category!r}")
    if hub in OEM_HUBS:
        return _TO_OEM.get(excel_category, excel_category)
    return _FROM_OEM.get(excel_category, excel_category)


def leader_for(raw: Any) -> str | None:
    text = _one_line(raw)
    if not text:
        return None
    first = text.split("/")[0].strip()
    return first[:LEADER_MAX] or None


def _header_matches(cell: Any, expected: str) -> bool:
    return " ".join(_text(cell).split()).lower() == expected.lower()


def read_rows(xlsx_path: Path) -> list[tuple[int, tuple[Any, ...]]]:
    """(excel_row_number, values) for every data row with a Project Name."""

    import openpyxl  # imported here so the module's helpers need no openpyxl

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    try:
        ws = wb[SHEET]
        header = next(
            ws.iter_rows(min_row=HEADER_ROW, max_row=HEADER_ROW, values_only=True)
        )
        for col, expected in EXPECTED_HEADERS.items():
            if not _header_matches(header[col], expected):
                raise ValueError(
                    f"column {col} header is {header[col]!r}, expected {expected!r}"
                )
        out: list[tuple[int, tuple[Any, ...]]] = []
        for number, values in enumerate(
            ws.iter_rows(min_row=FIRST_DATA_ROW, values_only=True), start=FIRST_DATA_ROW
        ):
            padded = tuple(values) + (None,) * max(0, COL_DEV_STEP + 1 - len(values))
            if _one_line(padded[COL_NAME]):
                out.append((number, padded))
        return out
    finally:
        wb.close()


def extract(rows: list[tuple[int, tuple[Any, ...]]]) -> dict[str, Any]:
    """Map the sheet rows to the seed JSON (module docstring). Pure."""

    projects: list[dict[str, Any]] = []
    used_codes: set[str] = set()
    for number, row in rows:
        request = _request_date(row[COL_REQUEST])
        if request is None or request.year != REQUEST_YEAR:
            continue

        name = _one_line(row[COL_NAME])[:NAME_MAX]
        excel_hub = _one_line(row[COL_HUB])
        if excel_hub not in HUB_MAP:
            raise ValueError(f"row {number}: unknown RPDO hub {excel_hub!r}")
        hub = HUB_MAP[excel_hub]

        excel_status = _one_line(row[COL_STATUS])
        if excel_status not in STATUS_MAP:
            raise ValueError(f"row {number}: unknown Project Status {excel_status!r}")
        status = STATUS_MAP[excel_status]

        excel_category = _one_line(row[COL_CATEGORY])
        category = category_for(hub, excel_category)

        excel_type = _one_line(row[COL_TYPE]).upper()
        marketing_priority = _marketing_priority(row[COL_MKT_PRIORITY])

        s_no = _text(row[COL_SNO])
        pd_code = _one_line(row[COL_PD_CODE])
        rm_code = _one_line(row[COL_RM_CODE])
        if _PD_CODE_RE.fullmatch(pd_code) and pd_code not in used_codes:
            code, source = pd_code, "pd_database"
        elif (
            rm_code.upper() not in _NO_CODE
            and _RM_CODE_RE.fullmatch(rm_code)
            and rm_code not in used_codes
        ):
            code, source = rm_code, "rm_saving"
        else:
            base = f"26-S{int(s_no):04d}" if s_no.isdigit() else f"26-R{number:04d}"
            code, n = base, 1
            while code in used_codes:
                n += 1
                code = f"{base}-{n}"
            source = "generated"
        used_codes.add(code)

        dev_step = _one_line(row[COL_DEV_STEP]).upper()
        customer = _one_line(row[COL_CUSTOMER]).upper()
        comments = _text(row[COL_REMARKS])[:COMMENTS_MAX]
        projects.append(
            {
                "excel_row": number,
                "s_no": s_no,
                "external_code": code,
                "code_source": source,
                "name": name,
                "hub": hub,
                "excel_hub": excel_hub,
                "category": category,
                "excel_category": excel_category,
                "type": TYPE_MAP.get(excel_type),
                "excel_type": excel_type or None,
                "status": status,
                "excel_status": excel_status,
                "marketing_priority": marketing_priority,
                "priority": priority_for(marketing_priority, status),
                "certification_testing_required": _one_line(row[COL_CERT]).lower() == "yes",
                "leader": leader_for(row[COL_LEADER]),
                "customer": customer or None,
                "comments": comments or None,
                "development_step": dev_step if _STEP_ID_RE.fullmatch(dev_step) else None,
                "request_date": request.isoformat(),
                "request_week": request.isocalendar()[1],
                "plant": _one_line(row[COL_PLANT]) or None,
                "capacity_flag": _one_line(row[COL_CAPACITY_FLAG]) or None,
            }
        )

    hub_counts: dict[str, Counter[str]] = {}
    for p in projects:
        if p["leader"]:
            hub_counts.setdefault(p["leader"], Counter())[p["hub"]] += 1
    leaders = []
    for name in sorted(hub_counts):
        counts = hub_counts[name]
        home = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        leaders.append(
            {
                "name": name,
                "hub": home,
                "project_count": sum(counts.values()),
                "hub_counts": dict(sorted(counts.items())),
            }
        )

    return {
        "source": {
            "workbook": "24-25-26 Global RPD Project Pipeline.xlsx (client; not committed)",
            "sheet": SHEET,
            "selection": f"Project Request (MM/YY) in {REQUEST_YEAR}",
            "extractor": "backend/seed/extract_client_2026.py",
        },
        "project_count": len(projects),
        "leaders": leaders,
        "projects": projects,
    }


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(__doc__.split("\n\n")[0], file=sys.stderr)
        print(f"usage: {argv[0]} <pipeline.xlsx> [out.json]", file=sys.stderr)
        return 2
    xlsx = Path(argv[1])
    out = (
        Path(argv[2])
        if len(argv) == 3
        else Path(__file__).resolve().parent / "client_2026_seed_data.json"
    )
    data = extract(read_rows(xlsx))
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    # Counts only: never print row values (customer is an encrypted field).
    print(f"wrote {data['project_count']} projects, {len(data['leaders'])} leaders to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
