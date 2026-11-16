"""P40-R02 (backend half): `GanttStepRow.pin_lapsed` and `pin_clearable`
(docs/API_CONTRACT_P40.md §2).

- `pin_lapsed` is per step and exact: the active run's row is `pinned` and
  its window differs from the pin recorded for that step in the run's
  `workflow_snapshot.step_pins`. It replaces the browser's derivation
  (`project.pin_lapsed && ms < planned_start`), which misfired on a sibling
  whose live pin was saved earlier than its run window.
- `pin_clearable` agrees with `PUT /gantt/step-pins`'s Clear rules.

`run_greedy_schedule.delay` and `publish_progress` are patched.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import api.routers.gantt as gantt_router
import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, RoleName, WorkflowStepStatus
from services.step_pins import run_pin_windows, step_pin_lapsed
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import (
    act_as,
    add_outcome,
    client_for,
    live_step,
    plan_step,
    set_progress,
    stepped_project,
)
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    gantt_router.STEP_PINS_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)
    gantt_router.STEP_PINS_RATE_LIMIT.reset()


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return SimpleNamespace(calls=calls)


def _snapshot_pin(project, step_id, start, end):
    return {
        "project_id": str(project.id),
        "step_id": step_id,
        "start_week": start,
        "end_week": end,
    }


async def _world(db_session):
    """Run week 31. Project Alpha:

    - PDD-E: pin (20, 23) recorded in the run; it had lapsed, so the run
      placed it from the run week, 31–34, `pinned`. The live pin is still
      (20, 23). -> lapsed.
    - PDD-G (the sibling): pin (40, 41) recorded and placed exactly there,
      `pinned`. Since the run, its live pin was moved earlier to (36, 37)
      ("applies on the next run"). The old browser rule
      (`project.pin_lapsed && 36 < 40`) called it lapsed. -> not lapsed.
    - PDD-H: unpinned run row, no pin. -> not lapsed.
    - PDD-I: a `pinned` run row whose pin is missing from the snapshot (not
      a real state; guards the lookup). -> not lapsed.
    """

    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    leader = await make_engineer(db_session, gr, name="Pin Leader", fte=1.0)
    a = await stepped_project(db_session, gr, name="Alpha", leader=leader)
    run = await make_schedule_run(
        db_session,
        is_active=True,
        workflow_snapshot={
            "workflows": [],
            "step_pins": [
                _snapshot_pin(a, "PDD-E", 20, 23),
                _snapshot_pin(a, "PDD-G", 40, 41),
            ],
        },
    )
    e = await plan_step(db_session, run, a, "PDD-E", 31, 34, engineer=leader)
    g = await plan_step(db_session, run, a, "PDD-G", 40, 41, engineer=leader)
    await plan_step(db_session, run, a, "PDD-H", 42, 44, engineer=leader)
    i = await plan_step(db_session, run, a, "PDD-I", 45, 46, engineer=leader)
    e.pinned = g.pinned = i.pinned = True
    outcome = await add_outcome(db_session, run, a)
    outcome.pin_lapsed = True
    for step_id, (ms, me) in {"PDD-E": (20, 23), "PDD-G": (36, 37)}.items():
        row = await live_step(db_session, a, step_id)
        row.manual_start_week, row.manual_end_week = ms, me
    await db_session.flush()
    return SimpleNamespace(gr=gr, india=india, leader=leader, run=run, a=a)


async def _steps(db_session, project, **params):
    async with client_for(db_session) as client:
        resp = await client.get("/gantt", params={"project_id": str(project.id), **params})
    assert resp.status_code == 200, resp.text
    (row,) = resp.json()["rows"]
    return row, {s["step_id"]: s for s in row["steps"]}


# --- pin_lapsed ----------------------------------------------------------------------


async def test_lapsed_step_and_not_lapsed_sibling(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    row, steps = await _steps(db_session, w.a)
    assert row["pin_lapsed"] is True  # the outcome, unchanged
    assert steps["PDD-E"]["pin_lapsed"] is True
    # The sibling: live pin earlier than its run window, but its run row sits
    # exactly on the pin the run was solved with.
    g = steps["PDD-G"]
    assert (g["manual_start_week"], g["planned_start_week"]) == (36, 40)
    assert g["pinned"] is True and g["pin_lapsed"] is False
    assert steps["PDD-H"]["pin_lapsed"] is False
    assert steps["PDD-I"]["pin_lapsed"] is False


async def test_pin_lapsed_served_to_every_reader(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.gr.id])
    _, steps = await _steps(db_session, w.a)
    assert {k: s["pin_lapsed"] for k, s in steps.items()} == {
        "PDD-E": True,
        "PDD-G": False,
        "PDD-H": False,
        "PDD-I": False,
    }


async def test_unplaced_steps_are_never_lapsed(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    _, steps = await _steps(db_session, w.a, include_unplaced="true")
    assert len(steps) == 14
    lapsed = {k for k, s in steps.items() if s["pin_lapsed"]}
    assert lapsed == {"PDD-E"}


def test_helpers_compare_stored_values_only():
    windows = run_pin_windows(
        {
            "step_pins": [
                {"project_id": "p", "step_id": "PDD-E", "start_week": 20, "end_week": 23},
                {"project_id": "p", "step_id": "PDD-F"},  # malformed: skipped
            ]
        }
    )
    assert windows == {("p", "PDD-E"): (20, 23)}
    assert run_pin_windows(None) == {}
    assert run_pin_windows({"workflows": []}) == {}

    row = SimpleNamespace(pinned=True, start_week=31, end_week=34)
    assert step_pin_lapsed(row, (20, 23)) is True
    assert step_pin_lapsed(row, (31, 34)) is False
    assert step_pin_lapsed(row, None) is False
    assert step_pin_lapsed(None, (20, 23)) is False
    unpinned = SimpleNamespace(pinned=False, start_week=31, end_week=34)
    assert step_pin_lapsed(unpinned, (20, 23)) is False


# --- pin_clearable -------------------------------------------------------------------


@pytest.mark.parametrize("role", [RoleName.ADMIN, RoleName.SUPER_ADMIN])
async def test_admin_roles_may_clear_any_live_step_of_a_non_frozen_project(
    db_session, dispatch, role
):
    w = await _world(db_session)
    # A started step may be cleared too (set is refused there).
    await set_progress(
        db_session, w.a, "PDD-A", WorkflowStepStatus.DONE, percent=100, start=10, end=12
    )
    await act_as(db_session, role)
    _, steps = await _steps(db_session, w.a, include_unplaced="true")
    assert all(s["pin_clearable"] is True for s in steps.values())
    assert steps["PDD-A"]["pin_editable"] is False
    assert steps["PDD-A"]["pin_block_reason"] == "STEP_STARTED"


@pytest.mark.parametrize(
    "role",
    [r for r in RoleName if r not in {RoleName.ADMIN, RoleName.SUPER_ADMIN}],
    ids=lambda r: r.value,
)
async def test_other_roles_may_not_clear(db_session, dispatch, role):
    w = await _world(db_session)
    await act_as(db_session, role)
    async with client_for(db_session) as client:
        resp = await client.get("/gantt", params={"project_id": str(w.a.id)})
    if resp.status_code == 403:  # roles without Gantt read
        return
    assert resp.status_code == 200, resp.text
    for row in resp.json()["rows"]:
        assert all(s["pin_clearable"] is False for s in row["steps"])


async def test_clearable_agrees_with_the_save(db_session, dispatch):
    """For every pinned step: `pin_clearable` true ⟺ a Clear PUT succeeds."""

    w = await _world(db_session)
    frozen = await stepped_project(
        db_session, w.gr, name="Frozen", frozen=True, actual_start_week=20
    )
    await plan_step(db_session, w.run, frozen, "PDD-E", 33, 36, engineer=w.leader)
    await add_outcome(db_session, w.run, frozen)
    row = await live_step(db_session, frozen, "PDD-E")
    row.manual_start_week, row.manual_end_week = 33, 36
    await db_session.flush()
    await act_as(db_session, RoleName.ADMIN)

    _, frozen_steps = await _steps(db_session, frozen)
    assert frozen_steps["PDD-E"]["pin_clearable"] is False
    _, alpha_steps = await _steps(db_session, w.a)
    assert alpha_steps["PDD-E"]["pin_clearable"] is True

    async with client_for(db_session) as client:
        refused = await client.put(
            "/gantt/step-pins",
            json={
                "items": [
                    {
                        "project_id": str(frozen.id),
                        "step_template_id": "PDD-E",
                        "manual_start_week": None,
                        "manual_end_week": None,
                    }
                ]
            },
        )
        assert refused.status_code == 409
        assert refused.json()["code"] == "PROJECT_FROZEN"
        accepted = await client.put(
            "/gantt/step-pins",
            json={
                "items": [
                    {
                        "project_id": str(w.a.id),
                        "step_template_id": step_id,
                        "manual_start_week": None,
                        "manual_end_week": None,
                    }
                    for step_id in ("PDD-E", "PDD-G")
                ]
            },
        )
        assert accepted.status_code == 200, accepted.text
    assert {c["action"] for c in accepted.json()["changes"]} == {"cleared"}


async def test_scoped_admin_clearable_only_in_scope(db_session, dispatch):
    w = await _world(db_session)
    far = await stepped_project(db_session, w.india, name="India project")
    await plan_step(db_session, w.run, far, "PDD-E", 33, 36)
    await add_outcome(db_session, w.run, far)
    await act_as(db_session, RoleName.ADMIN, hub_ids=[w.gr.id], hub_scope_all=False)
    async with client_for(db_session) as client:
        resp = await client.get("/gantt")
    assert resp.status_code == 200, resp.text
    rows = {r["project_id"]: r for r in resp.json()["rows"]}
    assert str(far.id) not in rows  # out of scope: not served at all
    assert all(s["pin_clearable"] for s in rows[str(w.a.id)]["steps"])
