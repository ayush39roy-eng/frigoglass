"""Server-made week labels on the absolute week line (P53, ADR 0063 R53-1 /
R53-6). No label reads W53 or later (owner rule 2026-11-18): week 60 is
"W8 2027"."""

from __future__ import annotations

from scheduling.weeks import week_of_year, year_of


def week_label(week: int) -> str:
    """ "W{week_of_year} {year}", e.g. 53 → "W1 2027"."""

    return f"W{week_of_year(week)} {year_of(week)}"


def year_end_label(year: int) -> str:
    return f"End of {year}"
