"""P56 (owner 2026-11-19): a project registered with only a name and a hub.

Registration requires only `name` and `hub_id` (P56; `services.
project_hard_gates.HARD_GATE_FIELDS` is empty). The scheduler, however,
cannot place a project in a schedulable status without a priority and a
category: `scheduling.workflow.validate_schedulable_project` raises
`ValueError` for the WHOLE run (the priority is sort key 3, the category
selects the lead-time row of every step). So such a project is **left out of
the scheduler input** here, in the service layer, and served as "not
scheduled" with the missing field(s) named, until the field is filled in.

The one predicate (`missing_schedule_fields`) mirrors what the engine needs,
nothing more:

- Status not schedulable (Commercialized / On Hold / Cancelled / Draft): the
  engine excludes it before validation, so nothing is missing.
- `priority` unset: missing.
- A non-frozen P4 / Q project is excluded by the engine before validation
  (ADR 0056 R42-3, `not_scheduled_priority`), so its category is not needed.
- Otherwise `category` unset: missing.

Leader, type and the financial fields are never scheduler requirements: type
and the financials are not scheduler inputs at all, and a project without a
leader is the engine's own `LEFT_OUT` / `no_leader` outcome (DOMAIN_RULES
"Booking rules").

Nothing here reads or logs a financial field.
"""

from __future__ import annotations

import dataclasses
from typing import Protocol

from sqlalchemy import ColumnElement, and_, or_

import domain_constants as dc
from models.enums import NON_SCHEDULABLE_STATUSES, ProjectPriority
from models.project import Project
from scheduling.types import ProjectInput, ScheduleInput
from services.outcome_buckets import outcome_label

#: Served order of the missing fields (and of the label's words).
SCHEDULE_REQUIRED_FIELDS: tuple[str, ...] = ("priority", "category")

#: The label's prefix; the rest names the missing field(s).
NOT_SCHEDULED_MISSING_PREFIX = "Not scheduled — missing"


def _value(v: object) -> str | None:
    if v is None:
        return None
    return str(getattr(v, "value", v))


def missing_schedule_fields(
    *, status: object, priority: object, category: object, frozen: bool
) -> tuple[str, ...]:
    """The scheduler-required fields this project lacks, in
    `SCHEDULE_REQUIRED_FIELDS` order; `()` when the project can enter a run
    (or its status keeps it out of scheduling anyway). Accepts enums or their
    wire values."""

    if _value(status) not in dc.SCHEDULABLE_STATUS_ORDER:
        return ()
    prio = _value(priority)
    missing: list[str] = []
    if prio not in dc.PRIORITY_ORDER:
        missing.append("priority")
    elif not frozen and prio in dc.NOT_SCHEDULED_PRIORITIES:
        # R42-3: excluded by the engine before validation.
        return ()
    if category is None:
        missing.append("category")
    return tuple(missing)


def missing_input_fields(project: ProjectInput) -> tuple[str, ...]:
    return missing_schedule_fields(
        status=project.status,
        priority=project.priority,
        category=project.category,
        frozen=project.frozen,
    )


class _ProjectLike(Protocol):
    @property
    def status(self) -> object: ...
    @property
    def priority(self) -> object: ...
    @property
    def category(self) -> object: ...
    @property
    def frozen(self) -> bool: ...


def missing_project_fields(project: _ProjectLike) -> tuple[str, ...]:
    """`missing_schedule_fields` of a live `Project` row."""

    return missing_schedule_fields(
        status=project.status,
        priority=project.priority,
        category=project.category,
        frozen=project.frozen,
    )


def drop_unschedulable_inputs(schedule_input: ScheduleInput) -> ScheduleInput:
    """The input without the projects `missing_input_fields` flags. Returns
    the SAME object when nothing is dropped, so an input with every field set
    (all hosted data before P56) is unchanged, hash included (I8, I14)."""

    kept = tuple(p for p in schedule_input.projects if not missing_input_fields(p))
    if len(kept) == len(schedule_input.projects):
        return schedule_input
    return dataclasses.replace(schedule_input, projects=kept)


def missing_fields_label(fields: tuple[str, ...] | list[str]) -> str | None:
    """The label: "Not scheduled — missing priority", "… missing category" or
    "… missing priority and category"; `None` for no field."""

    if not fields:
        return None
    return f"{NOT_SCHEDULED_MISSING_PREFIX} {' and '.join(fields)}"


def project_missing_label(project: _ProjectLike) -> str | None:
    return missing_fields_label(missing_project_fields(project))


def served_outcome_label(
    outcome: object | None, projected_end_week: int | None, project: _ProjectLike
) -> str | None:
    """The served `outcome_label`: the stored row's label when the project
    has an outcome row in the run (`outcome_buckets.outcome_label`, I50:
    the stored row wins); with no row, the P56 "Not scheduled — missing …"
    text when the live project lacks a scheduler-required field, else
    `None` (as before)."""

    if outcome is None:
        return project_missing_label(project)
    return outcome_label(outcome, projected_end_week)  # type: ignore[arg-type]


def sql_missing_schedule_fields() -> ColumnElement[bool]:
    """SQL form of `missing_schedule_fields(...) != ()` over `projects`
    (parameterised; no string SQL)."""

    not_scheduled = [ProjectPriority(p) for p in sorted(dc.NOT_SCHEDULED_PRIORITIES)]
    return and_(
        Project.status.not_in(list(NON_SCHEDULABLE_STATUSES)),
        or_(
            Project.priority.is_(None),
            and_(
                Project.category.is_(None),
                or_(Project.frozen.is_(True), Project.priority.not_in(not_scheduled)),
            ),
        ),
    )


__all__ = [
    "NOT_SCHEDULED_MISSING_PREFIX",
    "SCHEDULE_REQUIRED_FIELDS",
    "drop_unschedulable_inputs",
    "missing_fields_label",
    "missing_input_fields",
    "missing_project_fields",
    "missing_schedule_fields",
    "project_missing_label",
    "served_outcome_label",
    "sql_missing_schedule_fields",
]
