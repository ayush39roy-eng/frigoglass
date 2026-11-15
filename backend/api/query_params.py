"""P31 (docs/API_CONTRACT_P31.md): the repeatable `category` / `type` query
params, declared once so every endpoint takes them the same way.

`?category=A%2B&category=B&type=NM&type=CO`: OR within a param, AND across
params, absent or empty = no filter, one value = the pre-P31 behaviour. An
unknown value is a 422.

P33-T07 (ADR 0047, contract B3): categories are rows of the `categories`
table, so the category params are dependencies that read the table and
answer an unknown code with the same 422 envelope the enum gave
(`services.categories.unknown_category_error`, `loc = ["query",
"category"]`). The OpenAPI parameter is unchanged except that it is a string
(not an enum).

The Python default is `None`, not `[]`: export builders call some of these
route functions directly, and a `Query(...)` default would then arrive as a
`FieldInfo` object. Called directly, the dependency does not run and the
caller's (already validated) list is used as is. `None` and `[]` mean the
same thing (`services.category_type_filter.any_of`).
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from models.enums import ProjectType
from schemas.category import CategoryCode
from schemas.dashboard import RegisterTypeFilter
from services.categories import UNMAPPED, load_catalog, unknown_category_error

_CATEGORY_DOC = "Repeatable. Values are ORed; ANDed with every other filter. Absent = no filter."
_TYPE_DOC = (
    "Repeatable (`?type=NM&type=CO`). Values are ORed; ANDed with every other "
    "filter. Absent = no filter."
)
_UNMAPPED_DOC = " `Unmapped` selects projects with no value (IS NULL)."

#: P31: a Dashboard category / type value, or the analytics null bucket key.
#: P33-T07: a category code (checked against the table) or `Unmapped`.
DashboardCategoryValue = CategoryCode | Literal["Unmapped"]
DashboardTypeValue = RegisterTypeFilter


async def check_category_codes(
    db: AsyncSession, values: list[str] | None, *, allow_unmapped: bool
) -> list[str] | None:
    """`values` when every element is a category code (or `Unmapped` when
    allowed); else the enum-shaped 422 (`RequestValidationError`)."""

    if not values:
        return values
    catalog = await load_catalog(db)
    bad = [
        v
        for v in values
        if not catalog.is_known(v) and not (allow_unmapped and v == UNMAPPED)
    ]
    if bad:
        allowed = [*catalog.codes, UNMAPPED] if allow_unmapped else list(catalog.codes)
        raise unknown_category_error(bad, loc=("query", "category"), allowed=allowed)
    return values


async def _category_list(
    db: Annotated[AsyncSession, Depends(get_db)],
    category: Annotated[
        list[CategoryCode] | None, Query(alias="category", description=_CATEGORY_DOC)
    ] = None,
) -> list[str] | None:
    return await check_category_codes(db, category, allow_unmapped=False)


async def _dashboard_category_list(
    db: Annotated[AsyncSession, Depends(get_db)],
    category: Annotated[
        list[DashboardCategoryValue] | None,
        Query(alias="category", description=_CATEGORY_DOC + _UNMAPPED_DOC),
    ] = None,
) -> list[str] | None:
    return await check_category_codes(db, category, allow_unmapped=True)


CategoryListQuery = Annotated[list[str] | None, Depends(_category_list)]
TypeListQuery = Annotated[list[ProjectType] | None, Query(alias="type", description=_TYPE_DOC)]

#: Dashboard endpoints: the pie slices include an "Unmapped" bucket for a null
#: type / category, so the filter admits the same sentinel.
DashboardCategoryListQuery = Annotated[list[str] | None, Depends(_dashboard_category_list)]
DashboardTypeListQuery = Annotated[
    list[DashboardTypeValue] | None,
    Query(alias="type", description=_TYPE_DOC + _UNMAPPED_DOC),
]
