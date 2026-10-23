"""P31 (docs/API_CONTRACT_P31.md): the repeatable `category` / `type` query
params, declared once so every endpoint takes them the same way.

`?category=A%2B&category=B&type=NM&type=CO`: OR within a param, AND across
params, absent or empty = no filter, one value = the pre-P31 behaviour. An
unknown value is a 422 (FastAPI validates every element against the enum).

The Python default is `None`, not `[]`: export builders call some of these
route functions directly, and a `Query(...)` default would then arrive as a
`FieldInfo` object. `None` and `[]` mean the same thing
(`services.category_type_filter.any_of`).
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import Query

from models.enums import ProjectCategory, ProjectType
from schemas.dashboard import RegisterTypeFilter

_CATEGORY_DOC = "Repeatable. Values are ORed; ANDed with every other filter. Absent = no filter."
_TYPE_DOC = (
    "Repeatable (`?type=NM&type=CO`). Values are ORed; ANDed with every other "
    "filter. Absent = no filter."
)
_UNMAPPED_DOC = " `Unmapped` selects projects with no value (IS NULL)."

#: P31: a Dashboard category / type value, or the analytics null bucket key.
DashboardCategoryValue = ProjectCategory | Literal["Unmapped"]
DashboardTypeValue = RegisterTypeFilter

CategoryListQuery = Annotated[
    list[ProjectCategory] | None, Query(alias="category", description=_CATEGORY_DOC)
]
TypeListQuery = Annotated[list[ProjectType] | None, Query(alias="type", description=_TYPE_DOC)]

#: Dashboard endpoints: the pie slices include an "Unmapped" bucket for a null
#: type / category, so the filter admits the same sentinel.
DashboardCategoryListQuery = Annotated[
    list[DashboardCategoryValue] | None,
    Query(alias="category", description=_CATEGORY_DOC + _UNMAPPED_DOC),
]
DashboardTypeListQuery = Annotated[
    list[DashboardTypeValue] | None,
    Query(alias="type", description=_TYPE_DOC + _UNMAPPED_DOC),
]
