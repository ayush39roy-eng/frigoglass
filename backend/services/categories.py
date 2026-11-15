"""The `categories` table as the single source of category vocabulary
(ADR 0047, P33-T07; DOMAIN_RULES "Category templates" §E; contract P33 B1/B3).

Every reader that used the `ProjectCategory` enum, `CATEGORY_ORDER` or the
OEM category sets reads a `CategoryCatalog` instead:

- `codes` in rank order (lists, filters, breakdown buckets);
- `workflow_by_code` (the hub/workflow rule, `category_allowed_for_hub`);
- `schedule_categories()` -> `ScheduleInput.categories` (sort key 5 = rank).

`domain_constants.CATEGORY_ORDER` is now the seed default only (the seven
codes `p33a_categories` seeds), used by seed scripts and pure tests.

Validation (B3): an unknown code is a 422 with the same envelope the enum
gave (`unknown_category_error`, a FastAPI-style `detail` list), and a code of
the wrong workflow for the hub keeps its existing `CATEGORY_WORKFLOW_MISMATCH`
/ `CATEGORY_NOT_FOR_HUB` handling in the caller.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from fastapi.exceptions import RequestValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from models.category import RESERVED_ELIGIBILITY_CODE, Category
from models.project import workflow_id_for_hub
from scheduling.types import CategoryInput

__all__ = [
    "RESERVED_ELIGIBILITY_CODE",
    "CategoryCatalog",
    "UNMAPPED",
    "check_category_code",
    "check_eligibility_codes",
    "default_catalog",
    "load_catalog",
    "unknown_category_error",
]

#: The Dashboard / exports "no category" bucket (unchanged wire value).
UNMAPPED = "Unmapped"


@dataclass(frozen=True)
class CategoryRow:
    code: str
    label: str
    workflow_id: str
    rank: int


@dataclass(frozen=True)
class CategoryCatalog:
    """The categories table, ordered by rank."""

    rows: tuple[CategoryRow, ...]
    _by_code: Mapping[str, CategoryRow] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_by_code", {r.code: r for r in self.rows})

    @property
    def codes(self) -> tuple[str, ...]:
        """Every code in rank order."""
        return tuple(r.code for r in self.rows)

    @property
    def workflow_by_code(self) -> dict[str, str]:
        return {r.code: r.workflow_id for r in self.rows}

    @property
    def rank_by_code(self) -> dict[str, int]:
        return {r.code: r.rank for r in self.rows}

    def is_known(self, code: object) -> bool:
        return isinstance(code, str) and code in self._by_code

    def get(self, code: str) -> CategoryRow | None:
        return self._by_code.get(code)

    def codes_for_workflow(self, workflow_id: str) -> tuple[str, ...]:
        """The workflow's codes in rank order."""
        return tuple(r.code for r in self.rows if r.workflow_id == workflow_id)

    def codes_for_hub(self, hub_is_oem: bool) -> tuple[str, ...]:
        return self.codes_for_workflow(workflow_id_for_hub(hub_is_oem))

    def is_oem_category(self, code: str | None) -> bool:
        row = self._by_code.get(code) if code is not None else None
        return row is not None and row.workflow_id == dc.WORKFLOW_ID_FOR_OEM_HUB

    @property
    def eligibility_values(self) -> tuple[str, ...]:
        """Valid `engineers.allowed_categories` elements: every code plus the
        reserved blanket `OEM` (contract B3)."""
        return (*self.codes, RESERVED_ELIGIBILITY_CODE)

    def sort_codes(self, codes: Iterable[str]) -> list[str]:
        """Distinct `codes` in rank order (unknown codes last, by code)."""
        rank = self.rank_by_code
        big = len(rank) + 1
        return sorted(set(codes), key=lambda c: (rank.get(c, big), c))

    def schedule_categories(self) -> tuple[CategoryInput, ...]:
        """`ScheduleInput.categories` (ADR 0047 §3), in rank order. Equal to
        `scheduling.default_categories()` on the seeded table, so the
        canonical input and the run snapshot omit it (R33-7)."""
        return tuple(
            CategoryInput(code=r.code, workflow_id=r.workflow_id, rank=r.rank) for r in self.rows
        )


def default_catalog() -> CategoryCatalog:
    """The seven seeded categories (the `p33a_categories` seed): for code that
    has no session (seed scripts, pure tests)."""

    return CategoryCatalog(
        rows=tuple(
            CategoryRow(
                code=code,
                label=code,
                workflow_id=(
                    dc.WORKFLOW_ID_FOR_OEM_HUB
                    if code in dc.OEM_CATEGORIES
                    else dc.WORKFLOW_ID_FOR_NON_OEM_HUB
                ),
                rank=rank,
            )
            for rank, code in enumerate(dc.CATEGORY_ORDER, start=1)
        )
    )


async def load_catalog(db: AsyncSession) -> CategoryCatalog:
    """Read the categories table, ordered by rank (then code)."""

    rows = (
        await db.execute(
            select(Category.code, Category.label, Category.workflow_id, Category.rank).order_by(
                Category.rank, Category.code
            )
        )
    ).all()
    return CategoryCatalog(
        rows=tuple(
            CategoryRow(code=code, label=label, workflow_id=wf, rank=rank)
            for code, label, wf, rank in rows
        )
    )


def unknown_category_error(
    values: Sequence[Any], *, loc: Sequence[str | int], allowed: Sequence[str]
) -> RequestValidationError:
    """The 422 an unknown category used to get from the enum (contract B3:
    "Unknown values give 422 with the same codes as today"): a
    `RequestValidationError`, rendered by the app's sanitising validation
    handler as `{"detail": [{"type": "enum", "loc", "msg", "input", "ctx"}]}`,
    the shape Pydantic's enum check produced. `values` are the offending
    inputs; nothing financial ever reaches here."""

    quoted = [repr(a) for a in allowed]
    expected = (
        " or ".join(quoted)
        if len(quoted) < 3
        else ", ".join(quoted[:-1]) + " or " + quoted[-1]
    )
    return RequestValidationError(
        [
            {
                "type": "enum",
                "loc": tuple(loc),
                "msg": f"Input should be {expected}",
                "input": v,
                "ctx": {"expected": expected},
            }
            for v in values
        ]
    )


async def check_category_code(
    db: AsyncSession, code: str | None, *, loc: Sequence[str | int]
) -> CategoryCatalog:
    """422 (enum-shaped) unless `code` is None or a category code. Returns the
    catalog for the caller's workflow check."""

    catalog = await load_catalog(db)
    if code is not None and not catalog.is_known(code):
        raise unknown_category_error([code], loc=loc, allowed=catalog.codes)
    return catalog


async def check_eligibility_codes(
    db: AsyncSession, values: Sequence[str] | None, *, loc: Sequence[str | int]
) -> None:
    """422 (enum-shaped) unless every element of an engineer's
    `allowed_categories` is a category code or the reserved `OEM` (contract
    B3). The DB trigger `trg_engineers_allowed_categories_known` is the
    backstop."""

    if not values:
        return
    catalog = await load_catalog(db)
    allowed = catalog.eligibility_values
    bad = [v for v in values if v not in allowed]
    if bad:
        raise unknown_category_error(bad, loc=loc, allowed=allowed)
