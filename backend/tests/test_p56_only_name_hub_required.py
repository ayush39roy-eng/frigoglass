"""P56 (owner 2026-11-19, "remove all the mandatory fields except project
title"; Hub kept): registration needs only `name` and `hub_id`.

Covered:
- `POST /projects` with only name + hub is 201 `In Queue`, unranked, every
  former gate field null; a missing / empty name or a missing hub is still a
  422; an unknown leader is still 422 `UNKNOWN_LEADER`.
- A legacy Draft row with nothing set leaves Draft (`/submit` 200).
- Scheduling: a schedulable project with no priority, or no category (and
  not a non-frozen P4/Q), is left out of the scheduler input
  (`services.schedule_readiness`), so a recalc on the seeded portfolio
  succeeds; every other project's outcome is exactly what it was without
  them. A P4 without a category stays in (the engine excludes it itself);
  missing leader / type / financials never leave a project out (a leaderless
  one is the engine's own LEFT_OUT `no_leader`).
- Serving: no outcome row; Workspace / Gantt `outcome_label` =
  "Not scheduled — missing priority and category" (or one field); the stale
  flag is cleared by the activating run; filling the field brings the
  project back into the input.
- Priority-move preview of a priority-less project, band-rank preview of a
  category-less P1, and an empty What-if all succeed with such projects
  present.
- No GET endpoint answers 500 with such projects in the portfolio.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import api.routers.projects as projects_router
import api.routers.whatif as whatif_router
from api.db import get_db
from api.main import app
from models.engineer import Engineer
from models.enums import HubName, ProjectStatus, RoleName
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome
from scheduling import run_greedy_sgs
from scheduling.types import ScheduleInput
from seed import seed_demo_data
from services.schedule_persistence import build_schedule_input_from_db
from services.schedule_readiness import (
    drop_unschedulable_inputs,
    missing_fields_label,
    missing_schedule_fields,
)
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_hub, make_project
from tests.p12_helpers import act_as, client_for

LABEL_BOTH = "Not scheduled — missing priority and category"
LABEL_PRIORITY = "Not scheduled — missing priority"
LABEL_CATEGORY = "Not scheduled — missing category"


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    limiters = (
        whatif_router.WHATIF_RATE_LIMIT,
        whatif_router.WHATIF_SOLVE_RATE_LIMIT,
        projects_router.PRIORITY_PREVIEW_RATE_LIMIT,
    )
    for lim in limiters:
        lim.reset()
    yield
    for lim in limiters:
        lim.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


# --- the predicate ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status,priority,category,frozen,expected",
    [
        ("In Queue", None, None, False, ("priority", "category")),
        ("In Queue", None, "C", False, ("priority",)),
        ("In Development", "P1", None, False, ("category",)),
        ("In Buyoff", "P2", "A", False, ()),
        # R42-3: a non-frozen P4 / Q is excluded by the engine before validation.
        ("In Queue", "P4", None, False, ()),
        ("In Queue", "Q", None, False, ()),
        # A frozen P4 is validated (it books its locked capacity).
        ("In Queue", "P4", None, True, ("category",)),
        # Status-excluded projects are never validated.
        ("On Hold", None, None, False, ()),
        ("Commercialized", None, None, False, ()),
        ("Draft", None, None, False, ()),
    ],
)
def test_missing_schedule_fields(status, priority, category, frozen, expected):
    assert (
        missing_schedule_fields(status=status, priority=priority, category=category, frozen=frozen)
        == expected
    )


def test_label_text():
    assert missing_fields_label(("priority", "category")) == LABEL_BOTH
    assert missing_fields_label(("priority",)) == LABEL_PRIORITY
    assert missing_fields_label(("category",)) == LABEL_CATEGORY
    assert missing_fields_label(()) is None


# --- registration -------------------------------------------------------------------------


async def test_create_with_only_name_and_hub_is_201_in_queue(db_session: AsyncSession):
    hub = await make_hub(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER)
    async with client_for(db_session) as client:
        resp = await client.post("/projects", json={"name": "Only a title", "hub_id": str(hub.id)})
    assert resp.status_code == 201, resp.text
    served = resp.json()
    assert served["status"] == ProjectStatus.IN_QUEUE.value
    for field in (
        "leader_engineer_id",
        "category",
        "type",
        "priority",
        "tcogs_eur",
        "selling_price_eur",
        "gross_margin_pct",
        "actual_start_week",
        "band_rank",
        "band_size",
    ):
        assert served[field] is None, field
    stored = await db_session.get(Project, uuid.UUID(served["id"]))
    assert stored is not None and stored.status == ProjectStatus.IN_QUEUE


@pytest.mark.parametrize("body_kind", ["no_name", "empty_name", "no_hub", "null_hub", "null_name"])
async def test_name_and_hub_are_still_required(db_session: AsyncSession, body_kind):
    hub = await make_hub(db_session)
    await act_as(db_session, RoleName.ADMIN)
    body: dict[str, object] = {"name": "X", "hub_id": str(hub.id)}
    if body_kind == "no_name":
        del body["name"]
    elif body_kind == "empty_name":
        body["name"] = ""
    elif body_kind == "null_name":
        body["name"] = None
    elif body_kind == "no_hub":
        del body["hub_id"]
    else:
        body["hub_id"] = None
    async with client_for(db_session) as client:
        resp = await client.post("/projects", json=body)
    assert resp.status_code == 422, resp.text
    count = (await db_session.execute(select(Project.id))).all()
    assert count == []


async def test_unknown_leader_is_still_422(db_session: AsyncSession):
    hub = await make_hub(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects",
            json={"name": "X", "hub_id": str(hub.id), "leader_engineer_id": str(uuid.uuid4())},
        )
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "UNKNOWN_LEADER"


async def test_legacy_draft_submit_with_nothing_set(db_session: AsyncSession):
    hub = await make_hub(db_session)
    legacy = await make_project(
        db_session, hub, status=ProjectStatus.DRAFT, category=None, priority=None
    )
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        gate = await client.get(f"/projects/{legacy.id}/hard-gate-status")
        resp = await client.post(f"/projects/{legacy.id}/submit", json={})
    assert gate.status_code == 200
    assert gate.json() == {"can_leave_draft": True, "missing_fields": []}
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "In Queue"
    assert resp.json()["band_rank"] is None


# --- scheduling ---------------------------------------------------------------------------


def _outcomes(schedule_input: ScheduleInput) -> dict[str, object]:
    return {o.project_id: o for o in run_greedy_sgs(schedule_input).project_outcomes}


async def _seed_portfolio(db_session: AsyncSession) -> tuple[Hub, Engineer]:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    hub = (await db_session.execute(select(Hub).where(Hub.name == HubName.RD_GREECE))).scalar_one()
    leader = (
        await db_session.execute(
            select(Engineer)
            .where(Engineer.hub_id == hub.id, Engineer.active.is_(True))
            .order_by(Engineer.name)
            .limit(1)
        )
    ).scalar_one()
    return hub, leader


async def _create(client, **body) -> str:
    resp = await client.post("/projects", json=body)
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def test_recalc_leaves_incomplete_projects_out_and_serves_the_reason(
    db_session: AsyncSession,
):
    hub, leader = await _seed_portfolio(db_session)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    before = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    before_outcomes = _outcomes(before)

    async with client_for(db_session) as client:
        h = str(hub.id)
        bare = await _create(client, name="P56 bare", hub_id=h)
        no_cat = await _create(
            client, name="P56 P1 no category", hub_id=h, priority="P1",
            leader_engineer_id=str(leader.id),
        )  # fmt: skip
        no_prio = await _create(client, name="P56 no priority", hub_id=h, category="C")
        p4_no_cat = await _create(client, name="P56 P4 no category", hub_id=h, priority="P4")

        full = await build_schedule_input_from_db(
            db_session, current_week=TEST_WEEK, include_unschedulable=True
        )
        filtered = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
        filtered_ids = {p.project_id for p in filtered.projects}
        assert {bare, no_cat, no_prio, p4_no_cat} <= {p.project_id for p in full.projects}
        assert not {bare, no_cat, no_prio} & filtered_ids
        # R42-3: a P4 needs no category; the engine excludes it itself.
        assert p4_no_cat in filtered_ids
        assert drop_unschedulable_inputs(full) == filtered
        # Unchanged input when nothing is missing: the same object back.
        assert drop_unschedulable_inputs(before) is before

        # The engine would fail the whole run on the full input (the reason
        # for P56's filter), and succeeds on the served one.
        with pytest.raises(ValueError):
            run_greedy_sgs(full)
        after_outcomes = _outcomes(filtered)
        # Every pre-existing project's outcome is unchanged (the only new
        # input project is a non-scheduled P4, which books nothing).
        for pid, outcome in before_outcomes.items():
            assert after_outcomes[pid] == outcome, pid
        assert after_outcomes[p4_no_cat].not_scheduled_priority  # type: ignore[attr-defined]

        recalc = await client.post("/schedule-runs/greedy-recalc")
        assert recalc.status_code == 201, recalc.text

        expected = {bare: LABEL_BOTH, no_cat: LABEL_CATEGORY, no_prio: LABEL_PRIORITY}
        for pid, label in expected.items():
            ws = await client.get(f"/projects/{pid}/workspace")
            assert ws.status_code == 200, ws.text
            schedule = ws.json()["schedule"]
            assert schedule["outcome_label"] == label
            assert schedule["outcome"] is None
            assert schedule["projected_end_week"] is None
            # Cleared by the activating run: nothing to recalculate for it.
            assert schedule["schedule_stale"] is False
        gantt = await client.get("/gantt", params={"q": "P56", "limit": 50})
        assert gantt.status_code == 200, gantt.text
        rows = {r["project_id"]: r for r in gantt.json()["rows"]}
        for pid, label in expected.items():
            if pid in rows:
                assert rows[pid]["outcome_label"] == label
        assert rows[p4_no_cat]["outcome_label"] == "Not scheduled (P4)"

    active_id = (
        await db_session.execute(select(ScheduleRun.id).where(ScheduleRun.is_active.is_(True)))
    ).scalar_one()
    outcome_ids = {
        str(pid)
        for pid in (
            await db_session.execute(
                select(ScheduleRunProjectOutcome.project_id).where(
                    ScheduleRunProjectOutcome.schedule_run_id == active_id
                )
            )
        ).scalars()
    }
    assert not {bare, no_cat, no_prio} & outcome_ids
    assert p4_no_cat in outcome_ids

    # Filling the missing field brings the project back into the input.
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        patch = await client.patch(f"/projects/{no_cat}", json={"category": "C"})
    assert patch.status_code == 200, patch.text
    assert patch.json()["schedule_stale"] is True
    refilled = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    assert no_cat in {p.project_id for p in refilled.projects}
    run_greedy_sgs(refilled)  # no ValueError


async def test_missing_leader_type_financials_never_leave_a_project_out(
    db_session: AsyncSession,
):
    hub, _leader = await _seed_portfolio(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        pid = await _create(
            client, name="P56 no leader", hub_id=str(hub.id), priority="P2", category="C"
        )
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    assert pid in {p.project_id for p in si.projects}
    outcome = _outcomes(si)[pid]
    # DOMAIN_RULES "Booking rules": an unassigned leader is LEFT_OUT no_leader.
    assert outcome.left_out and outcome.no_leader  # type: ignore[attr-defined]


async def test_previews_and_whatif_tolerate_incomplete_projects(db_session: AsyncSession):
    hub, leader = await _seed_portfolio(db_session)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        h = str(hub.id)
        await _create(client, name="P56 bare", hub_id=h)
        no_prio = await _create(
            client, name="P56 no priority", hub_id=h, category="C",
            leader_engineer_id=str(leader.id),
        )  # fmt: skip
        no_cat = await _create(client, name="P56 P1 no category", hub_id=h, priority="P1")
        assert (await client.post("/schedule-runs/greedy-recalc")).status_code == 201

        # A priority-less project gets a priority: it joins the plan.
        prev = await client.post(f"/projects/{no_prio}/priority/preview", json={"priority": "P1"})
        assert prev.status_code == 200, prev.text
        assert prev.json()["result"] == "preview"
        moved = prev.json()["moved"]
        # Not in the active run before; in the previewed run after.
        assert moved["end_week_before"] is None and moved["left_out_before"] is None
        assert moved["end_week_after"] is not None or moved["left_out_after"] is True

        # A category-less project still moves bands (it stays out of the run).
        prev2 = await client.post(f"/projects/{no_cat}/priority/preview", json={"priority": "P2"})
        assert prev2.status_code == 200, prev2.text

        # Band-rank preview of a ranked project with no category.
        rank = await client.post(f"/projects/{no_cat}/band-rank/preview", json={"to_rank": 1})
        assert rank.status_code == 200, rank.text

        sim = await client.post("/whatif/simulate", json={"scenario": {}})
        assert sim.status_code == 200, sim.text


async def test_no_get_endpoint_500s_with_incomplete_projects(db_session: AsyncSession):
    hub, _leader = await _seed_portfolio(db_session)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        h = str(hub.id)
        bare = await _create(client, name="P56 bare", hub_id=h)
        await _create(client, name="P56 P1 no category", hub_id=h, priority="P1")
        await _create(client, name="P56 no priority", hub_id=h, category="B")
        assert (await client.post("/schedule-runs/greedy-recalc")).status_code == 201

        paths = app.openapi()["paths"]
        skip = ("/metrics", "/healthz", "/me/dev-users")
        checked = 0
        for path, ops in sorted(paths.items()):
            if "get" not in ops or path in skip or "progress" in path:
                continue
            params = {seg for seg in path.split("/") if seg.startswith("{")}
            if params - {"{project_id}"}:
                continue
            url = path.replace("{project_id}", bare)
            resp = await client.get(url)
            assert resp.status_code != 500, f"{url}: {resp.text[:300]}"
            checked += 1
        assert checked > 50
