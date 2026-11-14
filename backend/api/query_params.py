"""P31 (docs/API_CONTRACT_P31.md) and ADR 0050 (docs/API_CONTRACT_MULTISELECT.md):
the repeatable filter query params, declared once so every endpoint takes them
the same way.

`?category=A%2B&category=B&type=NM&type=CO&hub_id=..&hub_id=..`: OR within a
param, AND across params, absent or empty = no filter, one value = the
pre-multi-select behaviour. An unknown value is a 422 (FastAPI validates every
element against the enum / uuid / length). Each list is capped at
`MAX_FILTER_VALUES` values (422 above that).

`hub_id` and `region` are the exception to "AND across params": they are the
one global hub / country filter and are UNIONED (`services.hub_scope.
global_hub_filter`, ADR 0050), always ANDed with the RBAC scope.

The Python default is `None`, not `[]`: export builders call some of these
route functions directly, and a `Query(...)` default would then arrive as a
`FieldInfo` object. `None` and `[]` mean the same thing
(`services.category_type_filter.any_of`).
"""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import Query
from pydantic import StringConstraints

from models.enums import LabRegion, ProjectCategory, ProjectPriority, ProjectStatus, ProjectType
from schemas.dashboard import RegisterTypeFilter
from services.project_filters import STEP_CODE_MAX_LENGTH

#: ADR 0050: at most this many values per repeatable filter param (422 above).
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
    "Repeatable global hub filter (ADR 0020 / 0050). UNIONED with `region` (a project is "
    "in view when its hub is listed OR its hub's lab region is listed), always ANDed with "
    "the caller's hub scope: an out-of-scope hub contributes nothing. "
    f"At most {MAX_FILTER_VALUES} values."
)
_REGION_DOC = (
    "Repeatable country filter (ADR 0025 / 0050): the hub's lab region. UNIONED with "
    "`hub_id`, always ANDed with the caller's hub scope. "
    f"At most {MAX_FILTER_VALUES} values."
)

#: P31: a Dashboard category / type value, or the analytics null bucket key.
DashboardCategoryValue = ProjectCategory | Literal["Unmapped"]
DashboardTypeValue = RegisterTypeFilter

CategoryListQuery = Annotated[
    list[ProjectCategory] | None,
    Query(alias="category", description=_CATEGORY_DOC, max_length=MAX_FILTER_VALUES),
]
TypeListQuery = Annotated[
    list[ProjectType] | None,
    Query(alias="type", description=_TYPE_DOC, max_length=MAX_FILTER_VALUES),
]

#: Dashboard endpoints: the pie slices include an "Unmapped" bucket for a null
#: type / category, so the filter admits the same sentinel.
DashboardCategoryListQuery = Annotated[
    list[DashboardCategoryValue] | None,
    Query(
        alias="category",
        description=_CATEGORY_DOC + _UNMAPPED_DOC,
        max_length=MAX_FILTER_VALUES,
    ),
]
DashboardTypeListQuery = Annotated[
    list[DashboardTypeValue] | None,
    Query(alias="type", description=_TYPE_DOC + _UNMAPPED_DOC, max_length=MAX_FILTER_VALUES),
]

# ADR 0050: the global hub / country filter and the per-surface filters.
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

#: A workflow step code (`PDD-A`, ...) with the pre-ADR-0050 per-value bound.
StepCode = Annotated[str, StringConstraints(max_length=STEP_CODE_MAX_LENGTH)]
CurrentStepListQuery = Annotated[
    list[StepCode] | None,
    Query(alias="current_step", description=_REPEAT_DOC, max_length=MAX_FILTER_VALUES),
]
