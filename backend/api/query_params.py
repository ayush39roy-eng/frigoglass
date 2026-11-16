"""P31 (docs/API_CONTRACT_P31.md) and ADR 0051 (docs/API_CONTRACT_MULTISELECT.md):
the repeatable filter query params, declared once so every endpoint takes them
the same way.

`?category=A%2B&category=B&type=NM&type=CO&hub_id=..&hub_id=..`: OR within a
param, AND across params, absent or empty = no filter, one value = the
pre-multi-select behaviour. An unknown value is a 422 (FastAPI validates every
element against the enum / uuid / length). Each list is capped at
`MAX_FILTER_VALUES` values (422 above that).

`hub_id` and `region` are the exception to "AND across params": they are the
one global hub / country filter and are UNIONED (`services.hub_scope.
global_hub_filter`, ADR 0051), always ANDed with the RBAC scope.

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

import uuid
from typing import Annotated, Literal

from fastapi import Depends, Query
from pydantic import StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from models.enums import LabRegion, ProjectPriority, ProjectStatus, ProjectType
from schemas.category import CategoryCode
from schemas.dashboard import RegisterTypeFilter
from services.categories import UNMAPPED, load_catalog, unknown_category_error
from services.project_filters import STEP_CODE_MAX_LENGTH

#: ADR 0051: at most this many values per repeatable filter param (422 above).
MAX_FILTER_VALUES = 50

_REPEAT_DOC = (
    "Repeatable. Values are ORed; ANDed with every other filter. Absent = no filter. "
    f"At most {MAX_FILTER_VALUES} values."
)
_CATEGORY_DOC = _REPEAT_DOC
_TYPE_DOC = (
    "Repeatable (`?type=NM&type=CO`). Values are ORed; ANDed with every other "
    f"filter. Absent = no filter. At most {MAX_FILTER_VALUES} values."
)
_UNMAPPED_DOC = " `Unmapped` selects projects with no value (IS NULL)."
_HUB_DOC = (
    "Repeatable global hub filter (ADR 0020 / 0051). UNIONED with `region` (a project is "
    "in view when its hub is listed OR its hub's lab region is listed), always ANDed with "
    "the caller's hub scope: an out-of-scope hub contributes nothing. "
    f"At most {MAX_FILTER_VALUES} values."
)
_REGION_DOC = (
    "Repeatable country filter (ADR 0025 / 0051): the hub's lab region. UNIONED with "
    "`hub_id`, always ANDed with the caller's hub scope. "
    f"At most {MAX_FILTER_VALUES} values."
)

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
        list[CategoryCode] | None,
        Query(alias="category", description=_CATEGORY_DOC, max_length=MAX_FILTER_VALUES),
    ] = None,
) -> list[str] | None:
    return await check_category_codes(db, category, allow_unmapped=False)


async def _dashboard_category_list(
    db: Annotated[AsyncSession, Depends(get_db)],
    category: Annotated[
        list[DashboardCategoryValue] | None,
        Query(
            alias="category",
            description=_CATEGORY_DOC + _UNMAPPED_DOC,
            max_length=MAX_FILTER_VALUES,
        ),
    ] = None,
) -> list[str] | None:
    return await check_category_codes(db, category, allow_unmapped=True)


CategoryListQuery = Annotated[list[str] | None, Depends(_category_list)]
TypeListQuery = Annotated[
    list[ProjectType] | None,
    Query(alias="type", description=_TYPE_DOC, max_length=MAX_FILTER_VALUES),
]

#: Dashboard endpoints: the pie slices include an "Unmapped" bucket for a null
#: type / category, so the filter admits the same sentinel.
DashboardCategoryListQuery = Annotated[list[str] | None, Depends(_dashboard_category_list)]
DashboardTypeListQuery = Annotated[
    list[DashboardTypeValue] | None,
    Query(alias="type", description=_TYPE_DOC + _UNMAPPED_DOC, max_length=MAX_FILTER_VALUES),
]

# ADR 0051: the global hub / country filter and the per-surface filters.
HubIdListQuery = Annotated[
    list[uuid.UUID] | None,
    Query(alias="hub_id", description=_HUB_DOC, max_length=MAX_FILTER_VALUES),
]
RegionListQuery = Annotated[
    list[LabRegion] | None,
    Query(alias="region", description=_REGION_DOC, max_length=MAX_FILTER_VALUES),
]
StatusListQuery = Annotated[
    list[ProjectStatus] | None,
    Query(alias="status_", description=_REPEAT_DOC, max_length=MAX_FILTER_VALUES),
]
PriorityListQuery = Annotated[
    list[ProjectPriority] | None,
    Query(alias="priority", description=_REPEAT_DOC, max_length=MAX_FILTER_VALUES),
]
LeaderListQuery = Annotated[
    list[uuid.UUID] | None,
    Query(alias="leader_engineer_id", description=_REPEAT_DOC, max_length=MAX_FILTER_VALUES),
]

#: A workflow step code (`PDD-A`, ...) with the pre-ADR-0051 per-value bound.
StepCode = Annotated[str, StringConstraints(max_length=STEP_CODE_MAX_LENGTH)]
CurrentStepListQuery = Annotated[
    list[StepCode] | None,
    Query(alias="current_step", description=_REPEAT_DOC, max_length=MAX_FILTER_VALUES),
]
