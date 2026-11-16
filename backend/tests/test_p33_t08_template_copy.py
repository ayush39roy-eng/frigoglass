"""P33-T08: the per-project copy of the category template (ADR 0046 as ruled:
owner ruling OR-1..OR-6 > R33 > text; DOMAIN_RULES "Category templates"
§A/§B; contract P33 E4 and F4 with T05-A1 / T05-A2).

Small worlds on the shared savepoint-isolated DB (CURRENT_WEEK 31). The
template is the migration seed, so `effort_weight_weeks = weeks` until a
test edits a template row directly (the apply endpoint is P33-T10):

    PDD / B design weights A1 D1 E4 J1 K2 M1 (T = 10); figure 4 -> A1 E2 K1
    PDD / A design weights A1 B4 D1 E6 I2 J1 K2 M1 (T = 18)

The T08 own-figure test (acceptance): changing template weeks (and even a
project's own `plan_weeks`) leaves an own-effort project's split and run
unchanged (I32 iii), while a project without a figure follows its copy
(I32 ii).
"""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import asyncpg  # type: ignore[import-untyped]
import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    RoleName,
    WorkflowStepStatus,
)
from models.project import Project
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime
from scheduling import run_greedy_sgs
from scheduling.effort_split import EffortStepInput, derive_project_effort
from scheduling.workflow import build_lead_time_table, step_effective_weeks
from services.demand_load import load_demand
from services.schedule_persistence import build_schedule_input_from_db
from services.template_copy import merge_copy_changes, reached_step_ids
from services.workflow_durations import live_step_effective_weeks, own_effort_kinds
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_chamber, make_engineer, make_hub, registration_body
from tests.p12_helpers import act_as, client_for, live_step, set_progress, stepped_project

CW = TEST_WEEK
PDD = [f"PDD-{c}" for c in "ABCDEFGHIJKLMN"]


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _world(db: AsyncSession) -> SimpleNamespace:
    greece = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    cats = [EngineerAllowedCategory(c) for c in ("A+", "A", "B", "C")]
    lead = await make_engineer(db, greece, name="Lead GR", allowed_categories=cats)
    other = await make_engineer(db, greece, name="Lead GR 2", allowed_categories=cats)
    await make_chamber(db, lab_region=LabRegion.GREECE, allowed_stages=["PDD-F", "PDD-H"])
    await db.flush()
    return SimpleNamespace(greece=greece, lead=lead, other=other)


async def _rows(db: AsyncSession, project: Project) -> dict[str, ProjectWorkflowStep]:
    rows = (
        await db.execute(
            select(ProjectWorkflowStep)
            .execution_options(populate_existing=True)
            .where(ProjectWorkflowStep.project_id == project.id)
        )
    ).scalars()
    return {r.step_template_id: r for r in rows}


async def _template(db: AsyncSession, category: str, step_id: str) -> WorkflowLeadTime:
    row: WorkflowLeadTime = (
        await db.execute(
            select(WorkflowLeadTime)
            .execution_options(populate_existing=True)
            .where(
                WorkflowLeadTime.workflow_id == "PDD",
                WorkflowLeadTime.category == category,
                WorkflowLeadTime.step_id == step_id,
            )
        )
    ).scalar_one()
    return row


async def _set_template(
    db: AsyncSession,
    category: str,
    step_id: str,
    *,
    weeks: int | None = None,
    gap: int | None = None,
) -> None:
    """A template edit as the apply writes it (P33-T10): `weeks` / `gap_weeks`
    only, never the weights, and no project copy."""

    values: dict[str, int] = {}
    if weeks is not None:
        values["weeks"] = weeks
    if gap is not None:
        values["gap_weeks"] = gap
    await db.execute(
        update(WorkflowLeadTime)
        .where(
            WorkflowLeadTime.workflow_id == "PDD",
            WorkflowLeadTime.category == category,
            WorkflowLeadTime.step_id == step_id,
        )
        .values(**values)
    )
    await db.flush()


async def _figure(db: AsyncSession, project: Project, **figures: Any) -> None:
    await act_as(db, RoleName.ADMIN)
    async with client_for(db) as client:
        resp = await client.patch(f"/projects/{project.id}", json=figures)
        assert resp.status_code == 200, resp.text


def _effort(rows: dict[str, ProjectWorkflowStep]) -> dict[str, int | None]:
    return {sid: r.effort_weeks for sid, r in rows.items() if r.effort_weeks is not None}


async def _run_of(db: AsyncSession) -> dict[str, str]:
    """`repr` of each project's outcome in a fresh greedy run on the live
    input (rows, finish weeks, flags)."""

    out = run_greedy_sgs(await build_schedule_input_from_db(db, current_week=TEST_WEEK))
    return {o.project_id: repr(o) for o in out.project_outcomes}


# --- Registration and the copy ------------------------------------------------------


async def test_registration_copies_weeks_and_gaps_onto_all_14_rows(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    await _set_template(db_session, "B", "PDD-E", weeks=5, gap=-1)
    await _set_template(db_session, "B", "PDD-H", gap=2)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects", json=registration_body(w.greece, w.lead, category="B")
        )
        assert resp.status_code == 201, resp.text
    project = await db_session.get(Project, resp.json()["id"])
    assert project is not None
    rows = await _rows(db_session, project)
    assert sorted(rows) == PDD
    for sid, r in rows.items():
        t = await _template(db_session, "B", sid)
        assert (r.plan_weeks, r.plan_gap_weeks) == (t.weeks, t.gap_weeks), sid
    assert (rows["PDD-E"].plan_weeks, rows["PDD-E"].plan_gap_weeks) == (5, -1)
    assert rows["PDD-H"].plan_gap_weeks == 2
    assert rows["PDD-E"].template_change_id is None


async def test_registration_figure_splits_over_the_weights_not_the_weeks(
    db_session: AsyncSession,
) -> None:
    """R33-2 / OR-5: B/E's length is 8 but its weight stays 4, so figure 4
    still gives A1 E2 K1 (with weights = weeks it would be E3 K1)."""

    w = await _world(db_session)
    await _set_template(db_session, "B", "PDD-E", weeks=8)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects",
            json=registration_body(w.greece, w.lead, category="B", design_effort_weeks=4),
        )
        assert resp.status_code == 201, resp.text
    project = await db_session.get(Project, resp.json()["id"])
    assert project is not None
    rows = await _rows(db_session, project)
    assert _effort(rows) == {
        "PDD-A": 1, "PDD-D": 0, "PDD-E": 2, "PDD-J": 0, "PDD-K": 1, "PDD-M": 0,
    }  # fmt: skip
    assert rows["PDD-E"].plan_weeks == 8  # kept, unused while the figure governs


async def test_effort_weight_is_immutable_and_defaults_to_weeks(db_session: AsyncSession) -> None:
    row = await _template(db_session, "B", "PDD-E")
    assert row.effort_weight_weeks == row.weeks == 4
    with pytest.raises(DBAPIError) as exc:
        async with db_session.begin_nested():
            await db_session.execute(
                update(WorkflowLeadTime)
                .where(
                    WorkflowLeadTime.workflow_id == "PDD",
                    WorkflowLeadTime.category == "B",
                    WorkflowLeadTime.step_id == "PDD-E",
                )
                .values(effort_weight_weeks=5)
            )
    orig = exc.value.orig
    cause = getattr(orig, "__cause__", None) or orig
    assert isinstance(cause, asyncpg.CheckViolationError)
    assert cause.constraint_name == "ck_workflow_lead_times_effort_weight_immutable"
    # An UPDATE that leaves the weight alone is fine; so is a raw INSERT
    # without one (it takes `weeks`).
    await _set_template(db_session, "B", "PDD-E", weeks=9)
    assert (await _template(db_session, "B", "PDD-E")).effort_weight_weeks == 4
    await db_session.execute(
        text(
            "INSERT INTO categories (code, label, workflow_id, rank) VALUES ('B2', 'B2', 'PDD', 8)"
        )
    )
    await db_session.execute(
        text(
            "INSERT INTO workflow_lead_times (workflow_id, category, step_id, weeks) "
            "VALUES ('PDD', 'B2', 'PDD-E', 7)"
        )
    )
    row = (
        await db_session.execute(
            select(WorkflowLeadTime).where(
                WorkflowLeadTime.category == "B2", WorkflowLeadTime.step_id == "PDD-E"
            )
        )
    ).scalar_one()
    assert (row.weeks, row.effort_weight_weeks, row.gap_weeks) == (7, 7, 0)


# --- The live builder (contract F4, OR-3, T05-A1) ---------------------------------------


async def test_builder_default_copy_is_the_pre_p33_input(db_session: AsyncSession) -> None:
    """After the backfill (copy = table, gap 0, weight = weeks) no row carries
    `lead_weeks` or `wait_weeks`, and the effort merge is today's."""

    w = await _world(db_session)
    p = await stepped_project(
        db_session, w.greece, name="B4", leader=w.lead, category=ProjectCategory.B
    )
    await _figure(db_session, p, design_effort_weeks=4)
    q = await stepped_project(
        db_session, w.greece, name="A0", leader=w.other, category=ProjectCategory.A
    )
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    by_id = {x.project_id: x for x in si.projects}
    assert all(
        t.lead_weeks is None and t.wait_weeks == 0 for x in si.projects for t in x.step_timing
    )
    assert by_id[str(q.id)].step_timing == ()
    assert {t.step_id: t.duration_override_weeks for t in by_id[str(p.id)].step_timing} == {
        "PDD-A": 1, "PDD-D": 0, "PDD-E": 2, "PDD-J": 0, "PDD-K": 1, "PDD-M": 0,
    }  # fmt: skip


async def test_builder_maps_copies_and_gaps(  # P33-T13: T05-A1 terms removed
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    p = await stepped_project(
        db_session, w.greece, name="B4", leader=w.lead, category=ProjectCategory.B
    )
    await _figure(db_session, p, design_effort_weeks=4)
    q = await stepped_project(
        db_session, w.greece, name="B0", leader=w.other, category=ProjectCategory.B
    )
    rows_q = await _rows(db_session, q)
    rows_q["PDD-E"].plan_weeks = 6  # its own copy (≠ table 4)
    rows_q["PDD-H"].plan_gap_weeks = 3  # a wait
    rows_q["PDD-K"].plan_gap_weeks = -1  # an overlap
    rows_q["PDD-A"].plan_gap_weeks = 0
    # P33-T13: the T05-A1 hand-set fields are gone (p33c CHECK, ADR 0048);
    # L's wait comes from its copy alone.
    rows_q["PDD-L"].plan_gap_weeks = 2
    rows_p = await _rows(db_session, p)
    rows_p["PDD-E"].plan_weeks = 9  # unused: design follows the figure
    await db_session.flush()
    # A template edit makes the own-effort weights differ from the table.
    await _set_template(db_session, "B", "PDD-K", weeks=5)

    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    timing = {x.project_id: {t.step_id: t for t in x.step_timing} for x in si.projects}
    tq, tp = timing[str(q.id)], timing[str(p.id)]
    assert (tq["PDD-E"].lead_weeks, tq["PDD-E"].duration_override_weeks) == (6, None)
    assert (tq["PDD-H"].wait_weeks, tq["PDD-H"].overlap_weeks) == (3, 0)
    assert (tq["PDD-K"].overlap_weeks, tq["PDD-K"].wait_weeks) == (1, 0)
    # Not own effort: K's copy is 2, the table now says 5.
    assert tq["PDD-K"].lead_weeks == 2
    assert (tq["PDD-L"].overlap_weeks, tq["PDD-L"].wait_weeks) == (0, 2)
    assert "PDD-M" not in tq and "PDD-N" not in tq and "PDD-A" not in tq
    # No floor and no user override ever reach the live input (ADR 0048).
    assert all(
        t.start_not_before_week is None for x in si.projects for t in x.step_timing
    )
    # Own effort: lead = the weight (2 ≠ table 5), override = the effort share.
    assert (tp["PDD-K"].lead_weeks, tp["PDD-K"].duration_override_weeks) == (2, 1)
    assert (tp["PDD-E"].lead_weeks, tp["PDD-E"].duration_override_weeks) == (None, 2)
    # R33-9: no row carries a lead equal to its table value.
    table = build_lead_time_table(si.lead_times)
    for x in si.projects:
        for row in x.step_timing:
            assert row.lead_weeks != table[(x.workflow_id, x.category or "", row.step_id)]
    # The builder's eff (R33-1) equals §B on every step.
    kinds = {t.step_id: t.kind for t in si.workflow_steps}
    for project in (p, q):
        rows = await _rows(db_session, project)
        own = own_effort_kinds(((s, r.effort_weeks) for s, r in rows.items()), kinds)
        x = next(x for x in si.projects if x.project_id == str(project.id))
        for sid, r in rows.items():
            got = timing[str(project.id)].get(sid)
            lead = (
                got.lead_weeks
                if got is not None and got.lead_weeks is not None
                else table[("PDD", "B", sid)]
            )
            r331 = step_effective_weeks(
                lead_weeks=lead,
                kind=kinds[sid],
                certification_testing_required=x.certification_testing_required,
                override_weeks=got.duration_override_weeks if got is not None else None,
            )
            assert r331 == live_step_effective_weeks(
                plan_weeks=r.plan_weeks,
                kind=kinds[sid],
                certification_testing_required=x.certification_testing_required,
                own_effort=kinds[sid] in own,
                effort_weeks=r.effort_weeks,
            ), (project.name, sid)


async def test_builder_drops_a_gap_on_a_first_step(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    q = await stepped_project(
        db_session, w.greece, name="B0", leader=w.lead, category=ProjectCategory.B
    )
    (await live_step(db_session, q, "PDD-A")).plan_gap_weeks = 2
    await db_session.flush()
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    assert next(x for x in si.projects if x.project_id == str(q.id)).step_timing == ()


# --- I32: own effort is the timeline; the rest follows the copy ------------------------


async def test_template_weeks_leave_an_own_effort_projects_split_and_run_unchanged(
    db_session: AsyncSession,
) -> None:
    """The T08 own-figure test (I32 iii) and I32 ii. B/E's template length
    4 -> 5, then the copies too: the project with a design figure keeps
    A1 E2 K1, its demand and its run; the project without one keeps its run
    on the template edit alone (copy semantics) and grows E only when its own
    copy changes."""

    w = await _world(db_session)
    own = await stepped_project(
        db_session, w.greece, name="B4", leader=w.lead, category=ProjectCategory.B
    )
    await _figure(db_session, own, design_effort_weeks=4)
    plain = await stepped_project(
        db_session, w.greece, name="B0", leader=w.other, category=ProjectCategory.B
    )
    effort_before = _effort(await _rows(db_session, own))
    run_before = await _run_of(db_session)
    demand_before = (await load_demand(db_session)).projects

    # 1. The template alone: nothing reaches either project.
    await _set_template(db_session, "B", "PDD-E", weeks=5)
    assert await _run_of(db_session) == run_before
    demand = (await load_demand(db_session)).projects
    assert demand[own.id] == demand_before[own.id]
    assert demand[plain.id] == demand_before[plain.id]

    # 2. Both copies take the new length (as an apply would on the plain one);
    # the own-effort project's K copy even drops to 0. Its design steps still
    # follow the figure (lead = the weight, override = the share).
    for project in (own, plain):
        (await live_step(db_session, project, "PDD-E")).plan_weeks = 5
    (await live_step(db_session, own, "PDD-K")).plan_weeks = 0
    await db_session.flush()
    run_after = await _run_of(db_session)
    assert run_after[str(own.id)] == run_before[str(own.id)]  # I32 iii
    assert _effort(await _rows(db_session, own)) == effort_before
    demand = (await load_demand(db_session)).projects
    assert demand[own.id] == demand_before[own.id]
    # I32 ii: the plain project's E is its copy.
    assert demand[plain.id].design_full_year == demand_before[plain.id].design_full_year + 1
    out = run_greedy_sgs(await build_schedule_input_from_db(db_session, current_week=TEST_WEEK))
    plain_out = next(o for o in out.project_outcomes if o.project_id == str(plain.id))
    assert next(s for s in plain_out.steps if s.step_id == "PDD-E").duration_weeks == 5

    # 3. A re-derivation (a figure edit that rounds to the same E = 4) keeps
    # the split: the weights did not move.
    await _figure(db_session, own, design_effort_weeks=4.4)
    assert _effort(await _rows(db_session, own)) == effort_before


# --- Copy rules: figure cleared, category change (OR-5, R33-10) --------------------------


async def test_figure_cleared_recopies_template_weeks_onto_not_reached_steps_only(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    p = await stepped_project(
        db_session, w.greece, name="B4", leader=w.lead, category=ProjectCategory.B
    )
    await set_progress(
        db_session, p, "PDD-A", WorkflowStepStatus.DONE, percent=100, start=20, end=20
    )
    await set_progress(db_session, p, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=10, start=30)
    await _figure(db_session, p, design_effort_weeks=4)
    # The template moves on: E (reached) 4 -> 7, K (not reached) 2 -> 3,
    # L (elapsed, not reached) 1 -> 2; copies untouched so far.
    await _set_template(db_session, "B", "PDD-E", weeks=7)
    await _set_template(db_session, "B", "PDD-K", weeks=3)
    await _set_template(db_session, "B", "PDD-L", weeks=2)
    rows = await _rows(db_session, p)
    assert (rows["PDD-E"].plan_weeks, rows["PDD-K"].plan_weeks) == (4, 2)

    await _figure(db_session, p, design_effort_weeks=None)
    rows = await _rows(db_session, p)
    assert _effort(rows) == {}
    assert rows["PDD-K"].plan_weeks == 3  # design, not reached: follows the template
    assert rows["PDD-E"].plan_weeks == 4  # reached: keeps its copy
    assert rows["PDD-L"].plan_weeks == 1  # elapsed: not the cleared kind
    assert rows["PDD-D"].plan_weeks == 1  # reached (E, its successor, started)
    audit = (
        (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == "project.update",
                    AuditLogEntry.entity_id == str(p.id),
                )
            )
        )
        .scalars()
        .all()
    )
    copy_rows = [a for a in audit if "template_copy" in (a.after_state or {})]
    assert len(copy_rows) == 1
    assert copy_rows[0].before_state is not None and copy_rows[0].after_state is not None
    assert copy_rows[0].before_state["template_copy"] == {"PDD-K": {"plan_weeks": 2}}
    assert copy_rows[0].after_state["template_copy"] == {"PDD-K": {"plan_weeks": 3}}


async def test_category_change_recopies_not_reached_steps_and_rederives_with_new_weights(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    p = await stepped_project(
        db_session, w.greece, name="B4", leader=w.lead, category=ProjectCategory.B
    )
    await set_progress(db_session, p, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=10, start=30)
    await _figure(db_session, p, design_effort_weeks=4)
    # A's K length differs from its weight (2): the copy takes the length,
    # the split the weight.
    await _set_template(db_session, "A", "PDD-K", weeks=7)
    await _figure(db_session, p, category="A")
    rows = await _rows(db_session, p)
    reached = {"PDD-A", "PDD-B", "PDD-C", "PDD-D", "PDD-E"}
    for sid, r in rows.items():
        b, a = await _template(db_session, "B", sid), await _template(db_session, "A", sid)
        want = b if sid in reached else a
        assert (r.plan_weeks, r.plan_gap_weeks) == (want.weeks, want.gap_weeks), sid
    assert rows["PDD-K"].plan_weeks == 7
    assert rows["PDD-F"].plan_weeks == 4  # B had 0: revived by the new category
    # R6 with A's weights (E started: R3).
    weights = {sid: (await _template(db_session, "A", sid)).effort_weight_weeks for sid in PDD}
    kinds = {
        "design": {"PDD-A", "PDD-B", "PDD-D", "PDD-E", "PDD-I", "PDD-J", "PDD-K", "PDD-M"},
        "lab": {"PDD-F", "PDD-H"},
    }
    derived = derive_project_effort(
        design_effort_weeks=Decimal("4"),
        lab_effort_weeks=None,
        certification_testing_required=True,
        steps=tuple(
            EffortStepInput(
                step_id=sid,
                sequence_order=i + 1,
                kind=next((k for k, ids in kinds.items() if sid in ids), "elapsed"),
                lead_weeks=weights[sid],
                started=sid == "PDD-E",
            )
            for i, sid in enumerate(PDD)
        ),
    ).effort_weeks_by_step()
    assert _effort(rows) == {k: v for k, v in derived.items() if v is not None}


async def test_a_hub_move_without_a_category_change_keeps_the_copy(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    p = await stepped_project(
        db_session, w.greece, name="B0", leader=w.lead, category=ProjectCategory.B
    )
    (await live_step(db_session, p, "PDD-E")).plan_weeks = 6
    await db_session.flush()
    await _figure(db_session, p, hub_id=str(other.id))
    assert (await _rows(db_session, p))["PDD-E"].plan_weeks == 6


# --- Readers ------------------------------------------------------------------------------


async def test_readers_use_the_copy(db_session: AsyncSession) -> None:
    """The Workspace reads `eff` from the copy: a 0-length copy is skipped
    (STAGE_SKIPPED, the one predicate) and `lead_time_weeks` is the copy."""

    w = await _world(db_session)
    p = await stepped_project(
        db_session, w.greece, name="B0", leader=w.lead, category=ProjectCategory.B
    )
    (await live_step(db_session, p, "PDD-E")).plan_weeks = 0
    (await live_step(db_session, p, "PDD-K")).plan_weeks = 5
    await db_session.flush()
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        ws = await client.get(f"/projects/{p.id}/workspace")
        assert ws.status_code == 200, ws.text
        stages = {s["step_id"]: s for s in ws.json()["stages"]}
        assert stages["PDD-E"]["skipped"] is True and stages["PDD-E"]["duration_weeks"] == 0
        assert stages["PDD-K"]["duration_weeks"] == 5 and stages["PDD-K"]["lead_time_weeks"] == 5
        resp = await client.patch(
            f"/projects/{p.id}/stages/PDD-E",
            json={"status": "In Progress", "percent_complete": 10, "actual_start_week": 30},
        )
        assert resp.status_code == 422 and resp.json()["code"] == "STAGE_SKIPPED"


# --- Pure helpers -------------------------------------------------------------------------


def test_reached_is_started_or_behind_a_started_successor() -> None:
    preds = {"A": (), "B": ("A",), "C": ("B",), "D": ("B",), "E": ("C", "D")}
    ns, ip = WorkflowStepStatus.NOT_STARTED, WorkflowStepStatus.IN_PROGRESS
    statuses = dict.fromkeys(preds, ns)
    assert reached_step_ids(statuses, preds) == frozenset()
    statuses["C"] = ip
    assert reached_step_ids(statuses, preds) == {"A", "B", "C"}
    statuses["E"] = WorkflowStepStatus.DONE
    assert reached_step_ids(statuses, preds) == {"A", "B", "C", "D", "E"}


def test_merge_copy_changes_keeps_first_before_and_last_after() -> None:
    merged = merge_copy_changes(
        {"PDD-E": {"plan_weeks": [4, 6]}},
        {"PDD-E": {"plan_weeks": [6, 4]}, "PDD-K": {"plan_gap_weeks": [0, -1]}},
    )
    assert merged == {"PDD-K": {"plan_gap_weeks": [0, -1]}}


def test_section_b_eff() -> None:
    kw: dict[str, Any] = dict(certification_testing_required=True)
    # Own effort: the share, 0 when absent; the copy never matters.
    assert live_step_effective_weeks(plan_weeks=9, kind="design", own_effort=True,
                                     effort_weeks=2, **kw) == 2  # fmt: skip
    assert live_step_effective_weeks(plan_weeks=9, kind="design", own_effort=True,
                                     effort_weeks=None, **kw) == 0  # fmt: skip
    # Otherwise the copy (0 = skipped); elapsed never own.
    assert live_step_effective_weeks(plan_weeks=3, kind="elapsed", own_effort=False,
                                     effort_weeks=None, **kw) == 3  # fmt: skip
    assert live_step_effective_weeks(plan_weeks=0, kind="design", own_effort=False,
                                     effort_weeks=None, **kw) == 0  # fmt: skip
    # Lab with certification off: 0.
    assert live_step_effective_weeks(plan_weeks=6, kind="lab", own_effort=False,
                                     effort_weeks=None,
                                     certification_testing_required=False) == 0  # fmt: skip
    # P33-T13: the T05-A2 user-override term is gone with p33c (ADR 0048).
    with pytest.raises(TypeError):
        live_step_effective_weeks(plan_weeks=4, kind="design", own_effort=False,  # type: ignore[call-arg]
                                  effort_weeks=None, certification_testing_required=True,
                                  user_override_weeks=7)  # fmt: skip
    assert own_effort_kinds([("PDD-E", 2), ("PDD-L", 1), ("PDD-H", None)],
                            {"PDD-E": "design", "PDD-L": "elapsed", "PDD-H": "lab"}
                            ) == {"design"}  # fmt: skip
