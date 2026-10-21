"""Project Registration's required-field ("hard gate") check.

Per `docs/PROJECT_AND_STACK.md` §2 (Project Registration): "Create/edit
projects: assign leader, category (A+/A/B/C), type, hub, actual start date,
financial fields (TCOGS, gross margin, selling price ...)."

**ADR 0034 (2026-10-21, owner ruling): Draft is retired from registration.**
`POST /projects` checks these fields up front and creates the project
`In Queue`; a missing field is a 422 `HARD_GATE_FIELDS_MISSING`
(`hard_gate_error`). The same check and the same error shape still guard
`POST /projects/{id}/submit`, which only legacy `Draft` rows can use.

`priority` is part of the list since ADR 0034: a project is schedulable the
moment it is created, and the scheduler rejects a schedulable project with
no priority as a configuration error for the whole run
(`scheduling.workflow.validate_schedulable_project`). `hub` and `name` are
required by the request schema itself. `customer_name` is deliberately NOT
gated (PROJECT_AND_STACK §2 does not name it; P3-T01 decision).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from api.errors import HTTP_422, CodedHTTPException
from models.project import Project

#: (field_name, human-readable label) pairs. Order matches the
#: PROJECT_AND_STACK.md §2 sentence; `priority` (ADR 0034) last.
HARD_GATE_FIELDS: tuple[tuple[str, str], ...] = (
    ("leader_engineer_id", "leader"),
    ("category", "category"),
    ("type", "type"),
    ("actual_start_week", "actual start date"),
    ("tcogs_eur", "TCOGS"),
    ("selling_price_eur", "selling price"),
    ("gross_margin_pct", "gross margin"),
    ("priority", "priority"),
)

#: Error code of the 422 (create and legacy leave-Draft).
HARD_GATE_ERROR_CODE = "HARD_GATE_FIELDS_MISSING"


def missing_hard_gate_field_names(values: Mapping[str, Any]) -> list[str]:
    """Field names (in `HARD_GATE_FIELDS` order) whose value is absent or
    `None`. Only a presence check: the financial values are never read
    further, logged or echoed.
    """

    return [name for name, _label in HARD_GATE_FIELDS if values.get(name) is None]


def missing_hard_gate_fields(project: Project) -> list[str]:
    """Human-readable labels of every required field still missing on a
    stored project. Empty list => the project may leave Draft. The caller
    must not put these attributes' values into an audit row or log line.
    """

    labels = dict(HARD_GATE_FIELDS)
    values = {name: getattr(project, name) for name, _label in HARD_GATE_FIELDS}
    return [labels[name] for name in missing_hard_gate_field_names(values)]


def hard_gate_error(missing_names: list[str], message: str) -> CodedHTTPException:
    """The 422 shared by `POST /projects` and `POST /projects/{id}/submit`
    (docs/API_CONTRACT_P23.md §2)::

        {"code": "HARD_GATE_FIELDS_MISSING",
         "detail": {"message": str,
                    "missing_fields": [label, ...],
                    "field_errors": {field_name: message, ...}}}

    `missing_fields` keeps the leave-Draft labels; `field_errors` keys are
    request field names. No submitted value is echoed.
    """

    labels = dict(HARD_GATE_FIELDS)
    return CodedHTTPException(
        HTTP_422,
        HARD_GATE_ERROR_CODE,
        {
            "message": message,
            "missing_fields": [labels[name] for name in missing_names],
            "field_errors": {
                name: f"{labels[name][0].upper()}{labels[name][1:]} is required."
                for name in missing_names
            },
        },
    )
