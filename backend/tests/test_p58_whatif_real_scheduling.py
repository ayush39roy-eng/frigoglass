"""P58-A (owner 2026-11-23: "what if should use correct logic and do the real
future scheduling"; docs/API_CONTRACT_P58.md).

1. A step made `lab` while no chamber lists it in `allowed_stages` is 409
   `LAB_STEP_HAS_NO_CHAMBER` on `PUT /workflow-settings/steps/{wf}`, unless
   the body says which chambers take it (`add_to_chambers` /
   `add_to_chambers_like`), which is written and audited in the same
   transaction.
2. What-if results serve `left_out_reason`, `left_out_reason_label` and
   `no_chamber_step_id` per project (I58).
3. `outcome_counts_before` equals the live Dashboard's counts for the same
   plan (I9 / I58): a Commercialized project delivered this year counts
   within the year on both.
4. What-if is the real future scheduling: the live input builder and greedy
   engine at the plan clock's week, added projects placed from that week.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select, update

from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.enums import (
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    SolverType,
    WorkflowStepKind,
)
from models.workflow import WorkflowStepTemplate
from scheduling import run_greedy_sgs
from scheduling.weeks import PLAN_YEAR_WEEKS
from services.delivery_serving import left_out_reason_label
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.whatif import served_outcome
from tests._plan_week import TEST_WEEK
from tests.factories import make_chamber, make_project
from tests.test_p18_whatif_api import act_as, client_for, make_world
from tests.test_workflow_settings_api import _chain_steps

PUT_PDD = "/workflow-settings/steps/PDD"
ADD_FIVE = {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 5}]}


def _with_j_lab() -> list[dict[str, Any]]:
    steps = _chain_steps()
    for s in steps:
        if s["step_id"] == "PDD-J":
            s["kind"] = "lab"
    return steps


async def _kind(db_session: Any, step_id: str) -> WorkflowStepKind:
    return (
        await db_session.execute(
            select(WorkflowStepTemplate.kind)
            .where(WorkflowStepTemplate.id == step_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


# --- 1. the steps save ----------------------------------------------------------------


async def test_step_made_lab_without_a_chamber_is_409_and_nothing_written(db_session):
    await act_as(db_session, RoleName.SUPER_ADMIN)
    await make_chamber(db_session, code="GR-T1", allowed_stages=["PDD-F", "PDD-H"])
    async with client_for(db_session) as client:
        resp = await client.put(PUT_PDD, json={"steps": _with_j_lab()})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "LAB_STEP_HAS_NO_CHAMBER"
    assert body["steps"] == ["PDD-J"]
    assert "PDD-J" in body["detail"]
    # 2026-11-23: plain words, never a Python list repr ("['PDD-J']").
    assert "[" not in body["detail"] and "lab step(s) PDD-J." in body["detail"]
    assert await _kind(db_session, "PDD-J") == WorkflowStepKind.DESIGN


async def test_add_to_chambers_like_appends_the_step_and_audits(db_session):
    await act_as(db_session, RoleName.SUPER_ADMIN)
    a = await make_chamber(db_session, code="GR-T1", allowed_stages=["PDD-F", "PDD-H"])
    b = await make_chamber(db_session, code="GR-T2", allowed_stages=["PDD-H"])
    c = await make_chamber(db_session, code="GR-T3", allowed_stages=["PDD-F"])
    async with client_for(db_session) as client:
        resp = await client.put(
            PUT_PDD, json={"steps": _with_j_lab(), "add_to_chambers_like": "PDD-H"}
        )
    assert resp.status_code == 200, resp.text
    assert await _kind(db_session, "PDD-J") == WorkflowStepKind.LAB
    for ch in (a, b, c):
        await db_session.refresh(ch)
    assert a.allowed_stages == ["PDD-F", "PDD-H", "PDD-J"]
    assert b.allowed_stages == ["PDD-H", "PDD-J"]
    assert c.allowed_stages == ["PDD-F"]
    rows = (
        (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == "workflow_settings.chamber_allowed_stages_add"
                )
            )
        )
        .scalars()
        .all()
    )
    assert {r.entity_id for r in rows} == {str(a.id), str(b.id)}
    for r in rows:
        assert r.after_state["added_stages"] == ["PDD-J"]
        assert "PDD-J" not in r.before_state["allowed_stages"]
    steps_row = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "workflow_settings.steps_update")
        )
    ).scalar_one()
    assert steps_row.after_state["chamber_stages_added"] == {
        "GR-T1": ["PDD-J"],
        "GR-T2": ["PDD-J"],
    }


async def test_add_to_chambers_by_id(db_session):
    await act_as(db_session, RoleName.SUPER_ADMIN)
    a = await make_chamber(db_session, code="GR-T1", allowed_stages=["PDD-F", "PDD-H"])
    b = await make_chamber(db_session, code="GR-T2", allowed_stages=["PDD-H"])
    async with client_for(db_session) as client:
        resp = await client.put(
            PUT_PDD, json={"steps": _with_j_lab(), "add_to_chambers": [str(b.id)]}
        )
    assert resp.status_code == 200, resp.text
    await db_session.refresh(a)
    await db_session.refresh(b)
    assert a.allowed_stages == ["PDD-F", "PDD-H"]
    assert b.allowed_stages == ["PDD-H", "PDD-J"]


async def test_add_to_chambers_errors(db_session):
    await act_as(db_session, RoleName.SUPER_ADMIN)
    a = await make_chamber(db_session, code="GR-T1", allowed_stages=["PDD-F", "PDD-H"])
    async with client_for(db_session) as client:
        both = await client.put(
            PUT_PDD,
            json={
                "steps": _with_j_lab(),
                "add_to_chambers": [str(a.id)],
                "add_to_chambers_like": "PDD-H",
            },
        )
        unknown = await client.put(
            PUT_PDD,
            json={
                "steps": _with_j_lab(),
                "add_to_chambers": ["00000000-0000-0000-0000-000000000000"],
            },
        )
        like_none = await client.put(
            PUT_PDD, json={"steps": _with_j_lab(), "add_to_chambers_like": "OEM-E"}
        )
    assert both.status_code == 422
    assert unknown.status_code == 422 and unknown.json()["code"] == "UNKNOWN_CHAMBER"
    assert like_none.status_code == 422 and like_none.json()["code"] == "UNKNOWN_LIKE_STEP"
    assert await _kind(db_session, "PDD-J") == WorkflowStepKind.DESIGN


async def test_existing_uncovered_lab_step_does_not_block_other_edits(db_session):
    """The hosted state (PDD-J already `lab`, no chamber) predates the rule: a
    save that makes no step newly `lab` still goes through, and the same save
    with `add_to_chambers_like` repairs it."""

    await act_as(db_session, RoleName.SUPER_ADMIN)
    a = await make_chamber(db_session, code="GR-T1", allowed_stages=["PDD-F", "PDD-H"])
    await db_session.execute(
        update(WorkflowStepTemplate)
        .where(WorkflowStepTemplate.id == "PDD-J")
        .values(kind=WorkflowStepKind.LAB)
    )
    await db_session.flush()
    async with client_for(db_session) as client:
        plain = await client.put(PUT_PDD, json={"steps": _with_j_lab()})
        repair = await client.put(
            PUT_PDD, json={"steps": _with_j_lab(), "add_to_chambers_like": "PDD-F"}
        )
    assert plain.status_code == 200, plain.text
    assert repair.status_code == 200, repair.text
    await db_session.refresh(a)
    assert a.allowed_stages == ["PDD-F", "PDD-H", "PDD-J"]


# --- 2. What-if: real scheduling and the served reason --------------------------------


async def test_whatif_places_five_added_projects_from_the_current_week(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.post("/whatif/simulate", json={"scenario": ADD_FIVE})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    new = [p for p in body["projects"] if p["is_new"]]
    assert len(new) == 5
    for p in new:
        assert p["outcome"] in ("within_year", "spillover"), p
        assert p["finish_week"] is not None and p["finish_week"] > TEST_WEEK
        assert p["left_out_reason"] is None
        assert p["left_out_reason_label"] is None
        assert p["no_chamber_step_id"] is None
    delivery = body["delivery_by_year"]
    assert delivery["run_week"] == TEST_WEEK
    # P53 (R53-2): the search limit is the live run's, cw + N x 52.
    assert (delivery["horizon_weeks"] - TEST_WEEK) % PLAN_YEAR_WEEKS == 0
    not_placed = next(r for r in delivery["rows"] if r["kind"] == "not_placed")
    assert not_placed["total"] == 0


async def test_whatif_same_engine_and_input_as_the_live_run(db_session):
    """An empty scenario's results equal a live greedy run on the same data:
    same input builder, same engine, same week (no re-implementation)."""

    await make_world(db_session)
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    live = {o.project_id: o for o in run_greedy_sgs(si).project_outcomes}
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = (await client.post("/whatif/simulate", json={"scenario": {}})).json()
    assert {p["project_id"] for p in body["projects"]} == set(live)
    for p in body["projects"]:
        assert p["finish_week"] == live[p["project_id"]].projected_end_week


async def test_lab_step_with_no_chamber_serves_no_chamber_reason_and_label(db_session):
    await make_world(db_session)
    # The hosted 2026-11-22 state: PDD-J made `lab`, no chamber lists it.
    await db_session.execute(
        update(WorkflowStepTemplate)
        .where(WorkflowStepTemplate.id == "PDD-J")
        .values(kind=WorkflowStepKind.LAB)
    )
    await db_session.flush()
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.post("/whatif/simulate", json={"scenario": ADD_FIVE})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    new = [p for p in body["projects"] if p["is_new"]]
    assert len(new) == 5
    for p in new:
        assert p["outcome"] == "left_out"
        assert p["left_out_reason"] == "no_chamber"
        assert p["no_chamber_step_id"] == "PDD-J"
        assert p["left_out_reason_label"] == "No lab chamber accepts step PDD-J"
    not_placed = next(r for r in body["delivery_by_year"]["rows"] if r["kind"] == "not_placed")
    assert not_placed["left_out_reasons"]["no_chamber"] >= 5

    # Adding PDD-J to the chamber (what the 409's options do) places them all.
    for ch in (await db_session.execute(select(Chamber))).scalars().all():
        ch.allowed_stages = [*ch.allowed_stages, "PDD-J"]
    await db_session.flush()
    async with client_for(db_session) as client:
        again = (await client.post("/whatif/simulate", json={"scenario": ADD_FIVE})).json()
    for p in (p for p in again["projects"] if p["is_new"]):
        assert p["finish_week"] is not None and p["left_out_reason"] is None


# --- 3. before-counts equal the live Dashboard ----------------------------------------


async def test_before_counts_equal_the_live_dashboard(db_session):
    world = await make_world(db_session)
    gr = world.gr
    # A Commercialized project with no actual end week counts within 2026
    # (R53-2b); the engine classes it `excluded`, the Dashboard within year.
    await make_project(
        db_session, gr, name="Shipped", category=ProjectCategory.C,
        priority=ProjectPriority.P4, status=ProjectStatus.COMMERCIALIZED,
    )  # fmt: skip
    await make_project(
        db_session, gr, name="Cancelled one", category=ProjectCategory.C,
        priority=ProjectPriority.P3, status=ProjectStatus.CANCELLED,
    )  # fmt: skip
    await db_session.flush()
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    await persist_schedule_output(
        db_session,
        si,
        run_greedy_sgs(si),
        solver_type=SolverType.GREEDY,
        trigger_reason="test",
        activate=True,
    )
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        dash = (await client.get("/dashboard/completing-within-year")).json()
        empty = (await client.post("/whatif/simulate", json={"scenario": {}})).json()
        five = (await client.post("/whatif/simulate", json={"scenario": ADD_FIVE})).json()
    for sim in (empty, five):
        before = sim["outcome_counts_before"]
        assert before["within_year"] == dash["within_year_count"]
        assert before["spillover"] == dash["spillover_count"]
        assert before["left_out"] == dash["left_out_count"]
        assert before["blocked"] == dash["blocked_count"]
        assert before["queued"] == dash["queued_count"]
        assert before["not_scheduled_priority"] == dash["not_scheduled_priority_count"]
        assert before["excluded"] + before["data_error"] == dash["excluded_count"]
        assert sim["diff"]["within_year_before"] == dash["within_year_count"]
    # The delivered project is within the year, in the list and the count.
    shipped = next(p for p in empty["projects"] if p["name"] == "Shipped")
    assert shipped["outcome"] == "within_year" and shipped["priority_applicable"] is False
    assert empty["outcome_counts_after"] == empty["outcome_counts_before"]
    assert empty["delivery_by_year"] == dash["delivery_by_year"]


def test_served_outcome_matches_dashboard_precedence():
    # Commercialized delivered in the plan year.
    assert served_outcome("excluded", blocked=False, within_year=True) == "within_year"
    assert served_outcome("excluded", blocked=False, within_year=False) == "excluded"
    # Blocked outranks left out (Dashboard R42-6), never the two non-counting.
    assert served_outcome("left_out", blocked=True, within_year=False) == "blocked"
    assert served_outcome("queued", blocked=True, within_year=False) == "queued"
    assert served_outcome("data_error", blocked=False, within_year=False) == "data_error"
    assert served_outcome("spillover", blocked=False, within_year=False) == "spillover"


def test_left_out_reason_labels():
    assert left_out_reason_label(None, no_chamber_step_id=None, horizon_years=5) is None
    assert (
        left_out_reason_label("no_chamber", no_chamber_step_id="PDD-L", horizon_years=5)
        == "No lab chamber accepts step PDD-L"
    )
    assert (
        left_out_reason_label("beyond_horizon", no_chamber_step_id=None, horizon_years=5)
        == "Cannot be scheduled within 5 years — check resources"
    )
    assert (
        left_out_reason_label("beyond_horizon", no_chamber_step_id=None, horizon_years=1)
        == "Cannot be scheduled within 1 year — check resources"
    )
    assert left_out_reason_label("no_leader", no_chamber_step_id=None, horizon_years=5) == (
        "No leader assigned"
    )
