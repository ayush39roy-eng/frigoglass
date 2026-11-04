"""Synthetic capacity-planning workbooks for the P32-T04 tests (ADR 0044).

Built with openpyxl in memory. Every name, code and number is invented; the
client's real workbook is never read by the tests or copied into them.
"""

from __future__ import annotations

import io
from collections.abc import Sequence
from typing import Any

import openpyxl

#: The client's header row, in the client's column order (incl. the trailing
#: space on the engineer header and the commercially sensitive columns the
#: parser must never read).
HEADERS: tuple[str, ...] = (
    "S/N",
    "Project code",
    "Plant",
    "Expenses",
    "PRIORITY",
    "Project description",
    "RPD HUB",
    "Project Category",
    "PDD Project Stage",
    "Status",
    "Recommended Design Engineer ",
    "Spillover from 2026",
    "Num of Projects",
    "Must Do",
    "Tooling",
    "CAPEX",
    "notes",
    "Customer",
    "Region / country",
    "Annual volume",
    "Req. Comm. date",
    "Business case summary",
    "Complexity",
    "Est. Dur. (Months)",
    "Comments",
)

SECRET_CUSTOMER = "Zebracorp Secret Customer"
SECRET_NOTE = "confidential margin note 4242"
SECRET_CAPEX = 987654.32

PDD_SECTION: tuple[tuple[str, tuple[Any, ...]], ...] = (
    ("Special Category ", (1, 9, 4, 1, 7, 6, 2, 6, 2, 1, 2, 3, 1, 1)),
    ("A+", (1, 8, 4, 1, 6, 6, 2, 6, 2, 1, 2, 3, 1, 1)),
    ("A", (1, 4, 4, 1, 6, 4, 2, 6, 2, 1, 2, 3, 1, 1)),
    ("B", (1, 0, 0, 1, 4, None, 0, 6, None, 1, 2, 1, 1, 1)),
    ("C+", (1, 0, 0, 1, 2, None, 0, 1, None, 1, 1, 0, 0, 1)),
    ("D", (1, 0, 0, 1, 1, None, 0, 1, None, 1, None, 0, 0, 1)),
)
OEM_SECTION: tuple[tuple[str, tuple[Any, ...]], ...] = (
    ("A-OEM", (1, 1, 1, 2, 2, 2, 4, 6, 0, 1, 0, 0, 0, 1)),
    ("B-OEM", (1, 1, 1, 0, 0, 2, 2, 6, 0, 1, 0, 0, 0, 0)),
    ("C-OEM", (0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0)),
)


def row(**kw: Any) -> dict[str, Any]:
    """A data row by header name (short keys)."""

    keys = {
        "sn": "S/N",
        "code": "Project code",
        "plant": "Plant",
        "expenses": "Expenses",
        "priority": "PRIORITY",
        "name": "Project description",
        "hub": "RPD HUB",
        "category": "Project Category",
        "stage": "PDD Project Stage",
        "status": "Status",
        "engineer": "Recommended Design Engineer ",
        "spillover": "Spillover from 2026",
        "num": "Num of Projects",
        "must_do": "Must Do",
        "complexity": "Complexity",
        "est": "Est. Dur. (Months)",
    }
    out = {keys[k]: v for k, v in kw.items()}
    out.setdefault("Customer", SECRET_CUSTOMER)
    out.setdefault("notes", SECRET_NOTE)
    out.setdefault("CAPEX", SECRET_CAPEX)
    out.setdefault("Business case summary", "secret business case")
    return out


def _write_steps(ws: Any, pdd: Sequence[Any], oem: Sequence[Any] | None) -> None:
    ws.append(["PD RoadMap Steps -->", *[f"PDD-{c}" for c in "ABCDEFGHIJKLMN"]])
    ws.append([None, *[f"Step {c}" for c in "ABCDEFGHIJKLMN"]])
    ws.append(["Project Category", "Lead Times (wks) per Phase", *[None] * 13, "Sum"])
    for label, weeks in pdd:
        ws.append([label, *weeks, 999])
    if oem is not None:
        ws.append([])
        ws.append(["OEM Development Steps -->", *[f"OEM-{c}" for c in "ABCDEFGHIJKLMN"]])
        ws.append([None, *[f"Step {c}" for c in "ABCDEFGHIJKLMN"]])
        ws.append(["Project Category", "Lead Times (wks) per Phase", *[None] * 13])
        for label, weeks in oem:
            ws.append([label, *weeks])


def build_workbook(
    rows: Sequence[dict[str, Any]],
    *,
    headers: Sequence[str] = HEADERS,
    steps: bool = True,
    pdd: Sequence[Any] = PDD_SECTION,
    oem: Sequence[Any] | None = OEM_SECTION,
    stray_row: bool = True,
    leading_sheet: bool = False,
    projects_title: str = "draft 1 291026",
    rename: dict[str, str] | None = None,
) -> bytes:
    """`rename` maps a canonical header to the text written in the file (to
    test header variants); cell values are still looked up by the canonical
    name."""

    wb = openpyxl.Workbook()
    first = wb.active
    assert first is not None
    if leading_sheet:
        first.title = "Cover"
        first.append(["Capacity planning", None, "cover sheet"])
        ws = wb.create_sheet(projects_title)
    else:
        first.title = projects_title
        ws = first
    if stray_row:
        ws.append([None] * 15 + [2987, "K euro"])
    ws.append([(rename or {}).get(h, h) for h in headers])
    for r in rows:
        ws.append([r.get(h) for h in headers])
    if steps:
        _write_steps(wb.create_sheet("Process steps "), pdd, oem)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


#: The 2026-11-05 "priorities" shape (P32-R06): no Status column, the models
#: column renamed "Num of Models". Use with `rename=PRIORITIES_RENAME`; rows are
#: still built with `row(...)` (canonical keys; `status` must not be given).
PRIORITIES_HEADERS: tuple[str, ...] = tuple(h for h in HEADERS if h != "Status")
PRIORITIES_RENAME: dict[str, str] = {
    "Num of Projects": "Num of Models",
    "Recommended Design Engineer ": "Recommended Design Engineer",
}


def build_priorities_workbook(rows: Sequence[dict[str, Any]], **kw: Any) -> bytes:
    return build_workbook(rows, headers=PRIORITIES_HEADERS, rename=PRIORITIES_RENAME, **kw)
