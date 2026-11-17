"""P43 (ADR 0057): read a styled export back by machine key.

Exports now carry a title block and human column names
(`services.xlsx_writer`). Tests that check row values by the API's field
names read through these helpers: a row dict holds each value under its
human label AND under every machine key that label can stand for (e.g.
"Engineer" is `assigned_engineer_name` on the Gantt and `engineer_name` on a
scenario's Steps sheet).
"""

from __future__ import annotations

import csv
import io
import re
from typing import Any

import openpyxl

from services.xlsx_writer import _WORDS, HEADER_LABELS, TABLE_HEADER_ROW

_REVERSE: dict[str, list[str]] = {}
for _key, _label in HEADER_LABELS.items():
    _REVERSE.setdefault(_label, []).append(_key)
_REVERSE_WORDS = {v: k for k, v in _WORDS.items()}
_SUFFIX = re.compile(r"^(.*) \(([a-z][a-z0-9_]*)\)$")


def keys_of(label: str) -> list[str]:
    """Every machine key a header label can stand for (plus the label)."""

    out: list[str] = [label]
    if label in _REVERSE:
        return out + _REVERSE[label]
    m = _SUFFIX.match(label)
    if m:  # a de-duplicated label: "Label (key)"
        return [label, m.group(2)]
    words = label.split(" ")
    out.append("_".join(_REVERSE_WORDS.get(w, w.lower()) for w in words))
    return list(dict.fromkeys(out))


def key_for(label: str) -> str:
    """The primary machine key of a header label."""

    ks = keys_of(label)
    return ks[1] if len(ks) > 1 else label


def _row(labels: list[Any], values: list[Any]) -> dict[str, Any]:
    row: dict[str, Any] = {}
    for label, value in zip(labels, values, strict=False):
        if label is None:
            continue
        for k in keys_of(str(label)):
            row.setdefault(k, value)
    return row


def csv_rows(content: bytes) -> list[dict[str, Any]]:
    reader = csv.reader(io.StringIO(content.decode("utf-8-sig"), newline=""))
    lines = list(reader)
    if not lines:
        return []
    header = lines[0]
    return [_row(header, line) for line in lines[1:]]


def csv_header(content: bytes) -> list[str]:
    return next(csv.reader(io.StringIO(content.decode("utf-8-sig"), newline="")))


def workbook(content: bytes) -> Any:
    return openpyxl.load_workbook(io.BytesIO(content))


def sheet_values(ws: Any) -> list[list[Any]]:
    return [[c.value for c in r] for r in ws.iter_rows()]


def table(ws: Any, header_row: int = TABLE_HEADER_ROW) -> tuple[list[str], list[dict[str, Any]]]:
    """(header labels, row dicts) of a styled table sheet. Empty cells read
    as None (the plain writer wrote "")."""

    values = sheet_values(ws)
    header = [str(v) if v is not None else "" for v in values[header_row - 1]]
    while header and header[-1] == "":
        header.pop()
    rows = [_row(header, list(r)) for r in values[header_row:]]
    return header, rows


def xlsx_table(
    content: bytes, sheet: str, header_row: int = TABLE_HEADER_ROW
) -> tuple[list[str], list[dict[str, Any]]]:
    return table(workbook(content)[sheet], header_row)


def report(ws: Any) -> dict[str, Any]:
    """A key / value report sheet as `{label: value}` (a section heading
    reads as its label with a None value; an empty value reads as None)."""

    out: dict[str, Any] = {}
    for r in sheet_values(ws)[TABLE_HEADER_ROW:]:
        if len(r) >= 2 and r[0] not in (None, ""):
            out[str(r[0])] = r[1]
    return out
