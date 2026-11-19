"""R53-8 (ADR 0063): no literal week bound and no raw absolute-week label is
left in `backend/services` or `backend/api`.

Weeks are absolute from 2026 W1 and never re-based (R53-1), so a literal
52 / 53 / 78 / 79 / 104 / 105 in code is a 2026-only week bound unless it is
a duration (weeks per year, a lead-time cap, a row limit). And an f-string
`W{...}` must print a week of the year (`week_of_year(...)`, or go through
`services.week_labels.week_label`), never the absolute week (no label reads
W53 or later, owner rule 2026-11-18).

The scan reads tokens, so comments and docstrings are ignored. Every
remaining hit must be on the allowlist below with its reason; a new hit
fails the test. Line text (stripped) is the key, so moving a line does not
break the allowlist but editing it does (re-review on edit).
"""

from __future__ import annotations

import io
import tokenize
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
SCANNED = ("services", "api")

#: Numbers that are week bounds of the 2026 line (52 / 78 / 104 and their +1).
WEEK_BOUNDS = frozenset({"52", "53", "78", "79", "104", "105"})

#: (relative path, stripped line) -> reason. Durations and counts only.
NUMBER_ALLOWLIST: dict[tuple[str, str], str] = {
    (
        "services/capacity_supply.py",
        "weeks_in_year = float(calendar.weeks_in_year) if calendar is not None else 52.0",
    ): "duration: weeks per year when a hub has no calendar (ADR 0008)",
    (
        "services/engineer_supply.py",
        "WEEKS = 52",
    ): "duration: weeks per plan year (window length, offsets from the window start)",
    (
        "services/plan_import_xlsx.py",
        "MAX_LEAD_WEEKS = 104",
    ): "duration: lead-time cap in weeks, not a week number",
    (
        "services/step_pins.py",
        "PIN_MAX_WEEK = 52",
    ): "dead export (workflow-auditor P53-T05 A2); pins are bounded by plan_year_end_week(CW)",
    (
        "services/whatif_import.py",
        "year_end_week: int = 52",
    ): "dataclass default only; every constructor passes the resolved preset (R53-4)",
    (
        "services/whatif_chat.py",
        "return plan_year_end_week(clock.week) if clock is not None else 52",
    ): "fallback for a context with neither schedule nor clock (tests); live always has both",
    (
        "services/outcome_buckets.py",
        "*, left_out: bool, projected_end_week: int | None, year_end_week: int = 52",
    ): "pre-P53 QUEUED rows only, all 2026 runs (R53-2)",
    (
        "api/routers/workflow_settings.py",
        "weeks_in_year = cal.weeks_in_year if cal is not None else 52",
    ): "duration: calendar weeks per year default",
    (
        "api/routers/workflow_settings.py",
        "cal = HubWorkCalendar(hub_id=hub_id, weeks_in_year=52, **fields)",
    ): "duration: calendar weeks per year default",
    ("api/routers/checkins.py", "HISTORY_LIMIT = 52"): "count: at most 52 history rows",
}

#: (relative path, f-string expression after `W{`) -> reason.
LABEL_ALLOWLIST: dict[tuple[str, str], str] = {
    (
        "services/whatif_import.py",
        "w",
    ): "`plan_week_short`: w is the week of the year from `week_year(week)`",
}


def _files() -> list[Path]:
    return sorted(p for d in SCANNED for p in (BACKEND / d).rglob("*.py"))


def _scan(path: Path) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    rel = path.relative_to(BACKEND).as_posix()
    src = path.read_text(encoding="utf-8")
    lines = src.splitlines()
    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    numbers: list[tuple[str, str]] = []
    labels: list[tuple[str, str]] = []
    for i, tok in enumerate(toks):
        if tok.type == tokenize.NUMBER and tok.string.split(".")[0] in WEEK_BOUNDS:
            numbers.append((rel, lines[tok.start[0] - 1].strip()))
        if (
            tok.type == tokenize.FSTRING_MIDDLE
            and tok.string.endswith("W")
            and not tok.string[-2:-1].isalnum()
            and i + 1 < len(toks)
            and toks[i + 1].string == "{"
        ):
            depth, parts = 0, []
            for t in toks[i + 1 :]:
                if t.string == "{":
                    depth += 1
                    if depth == 1:
                        continue
                if t.string == "}":
                    depth -= 1
                    if depth == 0:
                        break
                parts.append(t.string)
            expr = "".join(parts)
            if not expr.startswith("week_of_year("):
                labels.append((rel, expr))
    return numbers, labels


def test_no_literal_week_bound_or_raw_week_label() -> None:
    bad_numbers: list[tuple[str, str]] = []
    bad_labels: list[tuple[str, str]] = []
    seen_numbers: set[tuple[str, str]] = set()
    seen_labels: set[tuple[str, str]] = set()
    for path in _files():
        numbers, labels = _scan(path)
        for hit in numbers:
            seen_numbers.add(hit)
            if hit not in NUMBER_ALLOWLIST:
                bad_numbers.append(hit)
        for hit in labels:
            seen_labels.add(hit)
            if hit not in LABEL_ALLOWLIST:
                bad_labels.append(hit)
    assert not bad_numbers, f"literal week bound(s) (R53-8): {bad_numbers}"
    assert not bad_labels, f"raw absolute-week label(s), use week_label(): {bad_labels}"
    # The allowlist carries no stale entry (a fixed line must leave it).
    assert set(NUMBER_ALLOWLIST) <= seen_numbers, set(NUMBER_ALLOWLIST) - seen_numbers
    assert set(LABEL_ALLOWLIST) <= seen_labels, set(LABEL_ALLOWLIST) - seen_labels


def test_scanner_catches_a_raw_label_and_a_bound(tmp_path: Path) -> None:
    probe = tmp_path / "probe.py"
    probe.write_text(
        "def f(cw: int) -> str:\n"
        '    """W{cw} in a docstring is fine; so is 104."""\n'
        "    # 52 in a comment is fine\n"
        "    if cw > 52:\n"
        '        return f"after W{cw}"\n'
        '    return f"W{week_of_year(cw)}"\n',
        encoding="utf-8",
    )
    # _scan keys by path relative to BACKEND; probe lives elsewhere.
    global BACKEND
    saved = BACKEND
    BACKEND = tmp_path
    try:
        numbers, labels = _scan(probe)
    finally:
        BACKEND = saved
    assert numbers == [("probe.py", "if cw > 52:")]
    assert labels == [("probe.py", "cw")]
