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
from scheduling.workflow import is_step_skipped as scheduling_is_step_skipped
from scheduling.workflow import merged_step_override, step_effective_weeks

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


def _kind_value(kind: object) -> str:
    value = getattr(kind, "value", kind)
    return str(value)


def live_step_effective_weeks(
    *,
    lead_weeks: int,
    kind: object,
    certification_testing_required: bool,
    user_override_weeks: int | None,
    effort_weeks: int | None,
) -> int:
    """ADR 0041 "Invariant wording" `eff(p, s)` of a live step row, through
    the scheduler's own functions (never re-implemented here):

        eff = 0                                lead = 0, or lab ∧ ¬cert
        eff = user ?? effort ?? lead           otherwise (R4)

    `lead_weeks` is the step's lead-time duration
    (`ProjectWorkflowStep.duration_weeks`), `user_override_weeks` the user's
    `duration_override_weeks` and `effort_weeks` the derived effort column.
    This is the duration used everywhere the lead time was (remaining
    duration, roll-up weights, demand load); 0 means skipped (R5)."""

    return step_effective_weeks(
        lead_weeks=lead_weeks,
        kind=_kind_value(kind),
        certification_testing_required=certification_testing_required,
        override_weeks=merged_step_override(user_override_weeks, effort_weeks),
    )


def live_step_skipped(
    *,
    lead_weeks: int,
    kind: object,
    certification_testing_required: bool,
    user_override_weeks: int | None,
    effort_weeks: int | None,
) -> bool:
    """ADR 0041 R5, THE skip predicate (`scheduling.is_step_skipped`):
    skipped ⟺ lead = 0 ∨ (lab ∧ ¬cert) ∨ effective = 0."""

    return scheduling_is_step_skipped(
        lead_weeks=lead_weeks,
        kind=_kind_value(kind),
        certification_testing_required=certification_testing_required,
        override_weeks=merged_step_override(user_override_weeks, effort_weeks),
    )


def display_duration_weeks(
    *,
    lead_weeks: int,
    kind: object,
    certification_testing_required: bool,
    user_override_weeks: int | None,
    effort_weeks: int | None,
) -> int:
    """The duration a stage is shown with (Workspace / agent context): `eff`,
    except that a lab step skipped only because certification testing is off
    shows its lead-time value (overrides ignored, P12-F04, unchanged), so it
    still reads as a planned length; a lead-0 step and an effort-zeroed step
    show 0. Its `skipped` flag is served beside it."""

    if _kind_value(kind) == "lab" and not certification_testing_required:
        return lead_weeks
    return live_step_effective_weeks(
        lead_weeks=lead_weeks,
        kind=kind,
        certification_testing_required=certification_testing_required,
        user_override_weeks=user_override_weeks,
        effort_weeks=effort_weeks,
    )


def effective_duration_weeks(
    lead_time_weeks: int,
    duration_override_weeks: int | None,
    *,
    effort_weeks: int | None = None,
    skipped: bool = False,
) -> int:
    """ADR 0019 §1 / ADR 0041 R4: `user ?? effort ?? lead_time` for a step
    that is not skipped by its lead time; a lead-0 step (or one the caller
    says is `skipped` for certification) keeps its lead-time value and the
    overrides are ignored, as the scheduler does. Prefer
    `live_step_effective_weeks`, which also applies the lab/certification
    gate and answers 0 for every skipped step."""

    if skipped or lead_time_weeks == 0:
        return lead_time_weeks
    merged = merged_step_override(duration_override_weeks, effort_weeks)
    return lead_time_weeks if merged is None else merged
