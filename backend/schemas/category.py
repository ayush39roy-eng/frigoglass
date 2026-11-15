"""Category wire types (ADR 0047, P33-T07; contract P33 B1/B3).

Categories are rows of the `categories` table, not an enum, so a schema can
only check the *format* of a code here (`CategoryCode`: 1..16 characters of
`[A-Za-z0-9+\\- ]`, as the table's CHECK). Whether the code exists, and
whether it belongs to the hub's workflow, is checked against the table by
the caller (`services.categories`, `api.query_params`), with the same 422
envelope the enum produced.

Response fields carry `CategoryCodeOut` (a plain string): a stored category
is always a table code.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints

from models.category import CATEGORY_CODE_MAX_LENGTH, CATEGORY_CODE_PATTERN

#: A category code in a request: format only; existence is checked against
#: the table by the caller.
CategoryCode = Annotated[
    str,
    StringConstraints(
        min_length=1, max_length=CATEGORY_CODE_MAX_LENGTH, pattern=CATEGORY_CODE_PATTERN
    ),
]

#: An engineer eligibility value in a request: a category code or the
#: reserved blanket `OEM` (which matches the same pattern).
EligibilityCode = CategoryCode

#: A category code in a response.
CategoryCodeOut = str


class CategoryRead(BaseModel):
    """`GET /reference/categories` (contract B1): one category, in rank order."""

    model_config = ConfigDict(extra="forbid")

    code: str
    label: str
    workflow_id: str
    rank: int
