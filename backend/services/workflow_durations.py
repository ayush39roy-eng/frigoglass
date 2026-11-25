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
- P33 (ADR 0046 §B, OR-1..OR-3; contract P33 F4): `own_effort_kinds`,
  `live_step_effective_weeks` / `live_step_skipped` (THE service-side `eff`
  and skip predicate on `(plan_weeks, kind, cert, own_effort,
  effort_weeks)`) and `run_input_lead_and_override` (the live builder's
  mapping). Since P33, `duration_weeks` is only the table value the row was
  created / last recomputed with; no `eff` reader uses it — the project's
  own copy is `plan_weeks`.

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
from scheduling import certification_off_skips, is_partial_room, merged_step_override

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
        # Both sides are `text` referencing `categories.code` (P33-T07, ADR
        # 0047; before, both were the `project_category` enum) — compared
        # directly.
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


#: The kinds a project's own effort figure can govern (OR-1).
EFFORT_KINDS: frozenset[str] = frozenset({"design", "lab"})


def own_effort_kinds(
    rows: Iterable[tuple[str, int | None]], kind_of: Mapping[str, object]
) -> frozenset[str]:
    """ADR 0046 OR-1, DOMAIN_RULES "Category templates" §B: the kinds `k` with
    `ownEffort(p, k)`, i.e. some step of the project of kind `k` carries a
    non-null `effort_weeks` (R2 applied: a figure > 0, a step of the kind
    with `effort_weight_weeks > 0`, certification testing on for lab).

    `rows` are one project's `(step_id, effort_weeks)` pairs; `kind_of`
    maps a step id to its kind (enum or value). Elapsed steps never have own
    effort."""

    out: set[str] = set()
    for step_id, effort_weeks in rows:
        if effort_weeks is None:
            continue
        kind = _kind_value(kind_of.get(step_id, "elapsed"))
        if kind in EFFORT_KINDS:
            out.add(kind)
    return frozenset(out)


def live_step_effective_weeks(
    *,
    plan_weeks: int,
    kind: object,
    certification_testing_required: bool,
    own_effort: bool,
    effort_weeks: int | None,
    excluded: bool = False,
    lab_hold_weeks: int | None = None,
) -> int:
    """DOMAIN_RULES "Category templates" §B (ADR 0046 OR-2) as replaced by
    R35-1 (P35, ADR 0049) and amended by ADR 0071 (DOMAIN_RULES "Lab hold
    weeks", I67), `eff(p, s)` of a live step row:

        eff = 0                       excluded(p, s)       # ADR 0049, first
            = 0                       kind = lab and not cert and not partialRoom   # R62-2
            = plan_weeks              partialRoom(p, s)    # R62-1: no lab-figure share
            = effort_weeks ?? 0       ownEffort(p, kind)   # its own figure is the timeline
            = plan_weeks              otherwise            # the project's template copy

    `lab_hold_weeks` is the row's `plan_lab_hold_weeks` (None = "Full", the
    pre-P62 predicate). `partialRoom` and the certification-off term are the
    engine's own functions (`scheduling.is_partial_room`,
    `scheduling.certification_off_skips`). A `partialRoom` step with
    `plan_weeks` 0 (C/PDD-J, C/PDD-L, R62-11) is skipped and nothing revives
    it.

    `own_effort` is `ownEffort(p, kind(s))` (`own_effort_kinds`). Equal to
    R33-1 on the live builder's input (contract F4): on an own-effort step
    the lead is its weight, which is > 0 exactly where `effort_weeks` is
    non-null (I26), and the override is `effort_weeks`; elsewhere the lead is
    `plan_weeks` and there is no override. 0 means skipped (the one
    predicate, `live_step_skipped`).

    P33-T13: the T05-A2 user-override term is gone. Migration p33c cleared
    every hand-set `duration_override_weeks` and a CHECK keeps it null
    (ADR 0048)."""

    if excluded:
        # R35-1 (ADR 0049 as ruled at P35-T03): first branch.
        return 0
    k = _kind_value(kind)
    if certification_off_skips(
        kind=k,
        certification_testing_required=certification_testing_required,
        lab_hold_weeks=lab_hold_weeks,
    ):
        return 0
    if is_partial_room(kind=k, lab_hold_weeks=lab_hold_weeks):
        # ADR 0071 R62-1 / I67: outside the lab split, the copy is the length
        # (the user override is retired, CHECK `step_timing_retired`).
        return plan_weeks
    if own_effort and k in EFFORT_KINDS:
        return 0 if effort_weeks is None else effort_weeks
    return plan_weeks


def live_step_skipped(
    *,
    plan_weeks: int,
    kind: object,
    certification_testing_required: bool,
    own_effort: bool,
    effort_weeks: int | None,
    excluded: bool = False,
    lab_hold_weeks: int | None = None,
) -> bool:
    """THE service-side skip predicate (ADR 0041 R5 as revised by ADR 0046
    §B; contract P33 F4; R35-1; ADR 0071 R62-2): skipped ⟺
    `live_step_effective_weeks(...) == 0`, on `(plan_weeks, kind, cert,
    own_effort, effort_weeks, excluded, lab_hold_weeks)`."""

    return (
        live_step_effective_weeks(
            plan_weeks=plan_weeks,
            kind=kind,
            certification_testing_required=certification_testing_required,
            own_effort=own_effort,
            effort_weeks=effort_weeks,
            excluded=excluded,
            lab_hold_weeks=lab_hold_weeks,
        )
        == 0
    )


def display_duration_weeks(
    *,
    plan_weeks: int,
    kind: object,
    certification_testing_required: bool,
    own_effort: bool,
    effort_weeks: int | None,
    excluded: bool = False,
    lab_hold_weeks: int | None = None,
) -> int:
    """The duration a stage is shown with (Workspace / agent context): `eff`,
    except that a lab step skipped only because certification testing is off
    shows its copy (`plan_weeks`, P12-F04, unchanged), so it still reads as a
    planned length; a 0-length step, an effort-zeroed step and an excluded
    step (P35, R35-1) show 0. Its `skipped` flag is served beside it.
    ADR 0071: a `partialRoom` step is never cert-skipped (R62-2), so it
    shows its `eff` (= `plan_weeks`)."""

    if excluded:
        return 0
    if certification_off_skips(
        kind=_kind_value(kind),
        certification_testing_required=certification_testing_required,
        lab_hold_weeks=lab_hold_weeks,
    ):
        return plan_weeks
    return live_step_effective_weeks(
        plan_weeks=plan_weeks,
        kind=kind,
        certification_testing_required=certification_testing_required,
        own_effort=own_effort,
        effort_weeks=effort_weeks,
        lab_hold_weeks=lab_hold_weeks,
    )


def run_input_lead_and_override(
    *,
    plan_weeks: int,
    effort_weight_weeks: int,
    table_weeks: int,
    own_effort: bool,
    effort_weeks: int | None,
    excluded: bool = False,
    kind: str | None = None,
    lab_hold_weeks: int | None = None,
) -> tuple[int | None, int | None]:
    """Contract P33 F4 (ADR 0046 OR-3), exact since p33c:
    `(lead_weeks, duration_override_weeks)` of one live step in the solver
    input.

    - `ownEffort(p, kind(s))`: `lead_weeks` = `effort_weight_weeks`,
      override = `effort_weeks`;
    - any other step: `lead_weeks` = `plan_weeks`, override = None;
    - `lead_weeks` is None when it equals the table.

    `table_weeks` is the input table's value for the project's workflow,
    category and step (0 when it has none, as `duration_for`). The scheduler
    then evaluates R33-1: `lead = lead_weeks ?? table`, `eff = 0` if `lead =
    0` or lab without certification, else `override ?? lead`.

    P33-T13: the T05-A1 user-override term is gone (p33c cleared every
    hand-set value; a CHECK keeps them null, ADR 0048).

    R35-9 (P35, ADR 0049): an **excluded** step maps to `lead_weeks = 0`
    (None when the table is already 0) and no override, whatever the rows
    above would give. It sits above OR-3's table as its first row; the
    scheduler then gives `eff = 0` before any override (R33-1), so no new
    scheduler field or snapshot key exists (I33).

    ADR 0071: with `kind` and `lab_hold_weeks` (`plan_lab_hold_weeks`), a
    `partialRoom` step (`scheduling.is_partial_room`) maps to `lead_weeks =
    plan_weeks` and no override; the builder sends the hold in
    `StepTimingInput.lab_hold_weeks`."""

    if excluded:
        return (None if table_weeks == 0 else 0), None
    if kind is not None and is_partial_room(kind=kind, lab_hold_weeks=lab_hold_weeks):
        # ADR 0071 R62-1 / contract P62 §2: a `partialRoom` step takes no
        # effort share, so `lead_weeks = plan_weeks`, whatever ownEffort says.
        own_effort = False
    lead = effort_weight_weeks if own_effort else plan_weeks
    # ADR 0041 R4 through the engine's precedence (`user ?? effort`, the user
    # override retired by p33c; ADR 0071: None on a `partialRoom` step).
    override = merged_step_override(
        None, effort_weeks if own_effort else None, kind=kind, lab_hold_weeks=lab_hold_weeks
    )
    if own_effort and effort_weeks is None:
        # ADR 0070: a revived weight can sit on an own-effort step that has no
        # share (held back, or not yet re-derived). OR-2 gives it `eff = 0`,
        # so the run must too: lead 0, never `override ?? weight`. Before ADR
        # 0070 such a step always had weight 0 (I26), so this is the same
        # input on every earlier state.
        lead = 0
    return (None if lead == table_weeks else lead), override
