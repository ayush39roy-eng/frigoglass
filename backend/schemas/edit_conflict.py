"""P47 (ADR 0059 C1): the optional `base` of an edit and the 409
`EDIT_CONFLICT` body.

`base` holds, for each field the request changes, the value the user started
from, exactly as the read endpoint served it. Only fields that are both in
the request and in `base` are checked (`services.edit_conflict`). A request
without `base` behaves as before P47.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, JsonValue, StringConstraints

#: More keys than any edit has fields; bounds the work a request can ask for.
EDIT_BASE_MAX_KEYS = 200

EditBase = Annotated[
    dict[Annotated[str, StringConstraints(min_length=1, max_length=100)], JsonValue],
    Field(
        max_length=EDIT_BASE_MAX_KEYS,
        description=(
            "ADR 0059: for each field this request changes, the value the user "
            "started from, as the read endpoint served it. Optional (omit it, or "
            "send an object; `{}` = no check); only fields "
            "present both here and in the request are checked. A stored value "
            "that differs answers 409 `EDIT_CONFLICT` and nothing is written."
        ),
    ),
]

EDIT_CONFLICT = "EDIT_CONFLICT"
EDIT_CONFLICT_MESSAGE = "Someone else changed this while you were editing."
#: Shown instead of a financial value (TCOGS, margin, selling price,
#: customer name) in `your_value` / `current_value`.
HIDDEN_VALUE = "<hidden>"


class EditConflict(BaseModel):
    """One field whose stored value is no longer the request's `base`."""

    entity: str
    id: str
    label: str | None
    field: str
    #: What the request asked to store (`"<hidden>"` for a financial field).
    your_value: JsonValue
    #: What is stored now (`"<hidden>"` for a financial field).
    current_value: JsonValue
    #: Full name of the actor of the latest audit row for this field (else
    #: for the entity); null when there is none, it was a system change, or
    #: the row was written in a hub outside the caller's scope.
    changed_by: str | None
    #: ISO time of that audit row; null when there is none.
    changed_at: str | None


class EditConflictResponse(BaseModel):
    """The 409 body (documentation model; built by `services.edit_conflict`)."""

    code: Literal["EDIT_CONFLICT"]
    detail: str
    conflicts: list[EditConflict]
