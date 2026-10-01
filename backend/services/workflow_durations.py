"""Step durations from the lead-time table (docs/DOMAIN_RULES.md "Lead times",
ADR 0007): `duration_weeks = lead_time[workflow][category][step_id]`.

Two entry points, deliberately built on SQLAlchemy *lightweight* table
constructs (`sa.table`/`sa.column`) rather than the ORM models so that the
Alembic migration that introduced the table (P9-T01) and every later caller
(seed script, Workflow Settings PUT in P9-T03) share one statement without the
migration depending on how the ORM models evolve afterwards:

- `recompute_step_durations_statement(...)` — a single parameterised
  `UPDATE project_workflow_steps … FROM projects, hubs, workflow_lead_times`
  that rewrites `duration_weeks` for every (or the given) project's live step
  rows from the table currently stored in `workflow_lead_times`.
- `lead_time_lookup(...)` / `duration_for(...)` — the same rule in pure Python,
  for callers that build step rows before they exist in the DB (the seed).

No raw SQL string interpolation anywhere here — every value is a bound
parameter; the statements are built with SQLAlchemy Core.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping, Sequence

import sqlalchemy as sa
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc

# --- Lightweight table handles (no ORM dependency) ---------------------------

_projects = sa.table(
    "projects",
    sa.column("id", sa.Uuid()),
    sa.column("hub_id", sa.Uuid()),
    sa.column("category", sa.String()),
)
_hubs = sa.table("hubs", sa.column("id", sa.Uuid()), sa.column("is_oem", sa.Boolean()))
_lead_times = sa.table(
    "workflow_lead_times",
    sa.column("workflow_id", sa.String()),
    sa.column("category", sa.String()),
    sa.column("step_id", sa.String()),
    sa.column("weeks", sa.Integer()),
)
_steps = sa.table(
    "project_workflow_steps",
    sa.column("id", sa.Uuid()),
    sa.column("project_id", sa.Uuid()),
    sa.column("step_template_id", sa.String()),
    sa.column("duration_weeks", sa.Integer()),
)


def workflow_id_expression() -> sa.ColumnElement[str]:
    """SQL form of `models.project.workflow_id_for_hub`: OEM hub → "OEM", else "PDD"."""
    return sa.case(
        (_hubs.c.is_oem.is_(True), sa.literal(dc.WORKFLOW_ID_FOR_OEM_HUB)),
        else_=sa.literal(dc.WORKFLOW_ID_FOR_NON_OEM_HUB),
    )


def recompute_step_durations_statement(
    project_ids: Sequence[uuid.UUID] | None = None,
) -> sa.Update:
    """`UPDATE project_workflow_steps SET duration_weeks = lt.weeks FROM …`.

    Joins each live step row to its project's hub (for the workflow) and
    category, then to the matching `workflow_lead_times` row. Rows with no
    match (a Draft project whose `category` is still NULL, or a step whose
    template is not in the project's workflow) are left untouched.

    `project_ids=None` means every project — what the migration and a
    Workflow Settings edit want; the seed passes the ids it just inserted.
    """
    stmt = (
        sa.update(_steps)
        .values(duration_weeks=_lead_times.c.weeks)
        .where(_steps.c.project_id == _projects.c.id)
        .where(_hubs.c.id == _projects.c.hub_id)
        .where(_lead_times.c.step_id == _steps.c.step_template_id)
        # Both sides are the `project_category` enum — compared directly (a
        # cast to varchar on one side would make Postgres reject the comparison).
        .where(_lead_times.c.category == _projects.c.category)
        .where(_lead_times.c.workflow_id == workflow_id_expression())
    )
    if project_ids is not None:
        stmt = stmt.where(_steps.c.project_id.in_(list(project_ids)))
    return stmt


async def recompute_step_durations(
    session: AsyncSession, project_ids: Sequence[uuid.UUID] | None = None
) -> int:
    """Execute `recompute_step_durations_statement` and return the row count."""
    result = await session.execute(recompute_step_durations_statement(project_ids))
    assert isinstance(result, CursorResult)  # an UPDATE always yields a CursorResult
    return int(result.rowcount or 0)


# --- Pure-Python form of the same rule --------------------------------------

LeadTimeKey = tuple[str, str, str]  # (workflow_id, category, step_id)


def lead_time_lookup(
    rows: Iterable[tuple[str, str, str, int]] = dc.LEAD_TIME_SEED,
) -> dict[LeadTimeKey, int]:
    """`{(workflow_id, category, step_id): weeks}` from `(workflow_id, category,
    step_id, weeks)` tuples — the seed's shape and the shape a DB reload of
    `workflow_lead_times` is trivially mapped to.
    """
    return {(wf, cat, step): int(weeks) for wf, cat, step, weeks in rows}


def duration_for(
    lookup: Mapping[LeadTimeKey, int], workflow_id: str, category: str | None, step_id: str
) -> int:
    """`lead_time[workflow][category][step_id]`; `0` (skipped) when the project
    has no category yet or the table has no entry — never a `max(1, …)` floor
    (ADR 0007).
    """
    if category is None:
        return 0
    return lookup.get((workflow_id, category, step_id), 0)
