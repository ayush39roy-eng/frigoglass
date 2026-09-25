"""P3-T03 — hub-scoped row-level filtering, enforced in the data access
layer (`services/hub_scope.py`) and composed into every `api/routers/*.py`
file touching project-scoped data.

Two layers of tests:
1. Pure unit tests of `services/hub_scope.py`'s predicate-building
   functions (no DB needed for most; `scoped_lab_regions` needs a `Hub`
   row).
2. End-to-end router tests, same pattern as `tests/test_rbac_enforcement.py`
   (a real DB-backed `User` + an overridden `Principal` via
   `tests.auth_helpers`), confirming: a Hub Planner scoped to one hub sees
   only that hub's rows on list endpoints, gets 404 (not 200) on a
   direct-by-ID out-of-scope row, and gets 403 on a create/move targeting an
   out-of-scope hub; an Engineer sees only their own assignments on Gantt
   (narrower than hub); Portfolio Manager/Executive Viewer/Admin
   (`hub_scope_all=True`) remain unrestricted.
"""

from __future__ import annotations

import uuid

from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, RoleName
from models.schedule import ScheduleRunProjectStep
from services.hub_scope import (
    hub_scope_filter,
    is_engineer_self_scoped,
    is_hub_in_scope,
    is_lab_region_in_scope,
    scoped_lab_regions,
)
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_chamber,
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
    make_workflow_step_template,
)

# --------------------------------------------------------------------------
# Pure unit tests — services/hub_scope.py
# --------------------------------------------------------------------------


def test_hub_scope_filter_returns_none_when_hub_scope_all():
    from models.project import Project

    principal = make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)
    assert hub_scope_filter(principal, Project.hub_id) is None


def test_hub_scope_filter_builds_in_predicate_when_scoped():
    from models.project import Project

    hub_id = uuid.uuid4()
    principal = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub_id])
    predicate = hub_scope_filter(principal, Project.hub_id)
    assert predicate is not None
    # Compiled SQL should reference an IN clause against Project.hub_id.
    compiled = str(predicate)
    assert "hub_id" in compiled
    assert "IN" in compiled.upper()


def test_is_hub_in_scope_true_when_hub_scope_all():
    principal = make_principal(RoleName.ADMIN, hub_scope_all=True)
    assert is_hub_in_scope(principal, uuid.uuid4()) is True


def test_is_hub_in_scope_true_for_matching_hub():
    hub_id = uuid.uuid4()
    principal = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub_id])
    assert is_hub_in_scope(principal, hub_id) is True


def test_is_hub_in_scope_false_for_other_hub():
    hub_id, other_hub_id = uuid.uuid4(), uuid.uuid4()
    principal = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub_id])
    assert is_hub_in_scope(principal, other_hub_id) is False


def test_is_hub_in_scope_false_for_none_when_restricted():
    principal = make_principal(
        RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[uuid.uuid4()]
    )
    assert is_hub_in_scope(principal, None) is False


def test_is_lab_region_in_scope_none_regions_means_unrestricted():
    assert is_lab_region_in_scope(None, LabRegion.INDIA) is True


def test_is_lab_region_in_scope_checks_membership():
    assert is_lab_region_in_scope({LabRegion.INDIA}, LabRegion.INDIA) is True
    assert is_lab_region_in_scope({LabRegion.INDIA}, LabRegion.GREECE) is False
    assert is_lab_region_in_scope(set(), LabRegion.INDIA) is False


def test_is_engineer_self_scoped_true_for_pure_engineer():
    principal = make_principal(RoleName.ENGINEER, hub_scope_all=False, hub_ids=[])
    assert is_engineer_self_scoped(principal) is True


def test_is_engineer_self_scoped_false_when_hub_scope_all():
    principal = make_principal(RoleName.ENGINEER, hub_scope_all=True)
    assert is_engineer_self_scoped(principal) is False


def test_is_engineer_self_scoped_false_when_also_hub_planner_with_hub_ids():
    """A multi-role account (Engineer + Hub Planner) is scoped by the
    broader hub-based rule instead — see `is_engineer_self_scoped`'s
    docstring for the documented rationale."""

    principal = make_principal(
        RoleName.ENGINEER,
        RoleName.HUB_PLANNER,
        hub_scope_all=False,
        hub_ids=[uuid.uuid4()],
    )
    assert is_engineer_self_scoped(principal) is False


def test_is_engineer_self_scoped_false_for_non_engineer_role():
    principal = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[])
    assert is_engineer_self_scoped(principal) is False


async def test_scoped_lab_regions_none_when_hub_scope_all(db_session):
    principal = make_principal(RoleName.ADMIN, hub_scope_all=True)
    assert await scoped_lab_regions(db_session, principal) is None


async def test_scoped_lab_regions_empty_set_when_no_hub_ids(db_session):
    principal = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[])
    assert await scoped_lab_regions(db_session, principal) == set()


async def test_scoped_lab_regions_maps_hub_ids_to_regions(db_session):
    hub = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    principal = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub.id])
    regions = await scoped_lab_regions(db_session, principal)
    assert regions == {LabRegion.INDIA}


# --------------------------------------------------------------------------
# End-to-end router tests
# --------------------------------------------------------------------------


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


async def _as_scoped_hub_planner(db_session, hub_ids: list[uuid.UUID]) -> AsyncClient:
    user = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=hub_ids)
    client = _client(db_session)
    override_current_principal(
        make_principal(
            RoleName.HUB_PLANNER, user_id=user.id, hub_scope_all=False, hub_ids=hub_ids
        )
    )
    return client


async def _as_engineer(db_session, *, user_id: uuid.UUID | None = None) -> AsyncClient:
    if user_id is None:
        new_user = await make_user(
            db_session, RoleName.ENGINEER, hub_scope_all=False, hub_ids=[]
        )
        user_id = new_user.id
    client = _client(db_session)
    override_current_principal(
        make_principal(RoleName.ENGINEER, user_id=user_id, hub_scope_all=False, hub_ids=[])
    )
    return client


async def _as_unrestricted(db_session, *roles: RoleName) -> AsyncClient:
    user = await make_user(db_session, *roles, hub_scope_all=True)
    client = _client(db_session)
    override_current_principal(make_principal(*roles, user_id=user.id, hub_scope_all=True))
    return client


# ---- Project Registration -------------------------------------------------


async def test_projects_list_hub_scoped_hides_other_hub_projects(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project_a = await make_project(db_session, hub_a, name="Hub A Project")
    await make_project(db_session, hub_b, name="Hub B Project")

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.get("/projects")
        assert resp.status_code == 200
        names = {row["name"] for row in resp.json()}
        assert names == {"Hub A Project"}
        assert str(project_a.id) in {row["id"] for row in resp.json()}
    finally:
        _teardown()


async def test_projects_list_unrestricted_for_portfolio_manager(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    await make_project(db_session, hub_a, name="Hub A Project 2")
    await make_project(db_session, hub_b, name="Hub B Project 2")

    try:
        async with await _as_unrestricted(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.get("/projects")
        names = {row["name"] for row in resp.json()}
        assert {"Hub A Project 2", "Hub B Project 2"}.issubset(names)
    finally:
        _teardown()


async def test_projects_get_out_of_scope_returns_404_not_200(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    other_hub_project = await make_project(db_session, hub_b)

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.get(f"/projects/{other_hub_project.id}")
        assert resp.status_code == 404
    finally:
        _teardown()


async def test_projects_create_out_of_scope_hub_forbidden(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.post("/projects", json={"name": "X", "hub_id": str(hub_b.id)})
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_projects_create_in_scope_hub_allowed(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.post("/projects", json={"name": "X", "hub_id": str(hub_a.id)})
        assert resp.status_code == 201
    finally:
        _teardown()


async def test_projects_update_move_to_out_of_scope_hub_forbidden(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project = await make_project(db_session, hub_a)

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.patch(f"/projects/{project.id}", json={"hub_id": str(hub_b.id)})
        assert resp.status_code == 403
    finally:
        _teardown()


# ---- Capacity Planning — Engineers -----------------------------------------


async def test_engineers_list_hub_scoped(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    await make_engineer(db_session, hub_a, name="Eng A")
    await make_engineer(db_session, hub_b, name="Eng B")

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.get("/engineers")
        names = {row["name"] for row in resp.json()}
        assert names == {"Eng A"}
    finally:
        _teardown()


async def test_engineers_get_out_of_scope_404(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    other_eng = await make_engineer(db_session, hub_b)

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.get(f"/engineers/{other_eng.id}")
        assert resp.status_code == 404
    finally:
        _teardown()


async def test_engineers_create_out_of_scope_hub_forbidden(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.post(
                "/engineers", json={"name": "Eng X", "hub_id": str(hub_b.id)}
            )
        assert resp.status_code == 403
    finally:
        _teardown()


# ---- Capacity Planning — Chambers (lab-region scoping) --------------------


async def test_chambers_list_scoped_by_lab_region_not_hub_id(db_session):
    """A chamber has no `hub_id` — a Hub Planner scoped to an India hub must
    see India-region chambers (shared infrastructure), and none from Greece.
    """

    india_hub = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    await make_chamber(db_session, code="IN-CH1", lab_region=LabRegion.INDIA)
    await make_chamber(db_session, code="GR-CH1", lab_region=LabRegion.GREECE)

    try:
        async with await _as_scoped_hub_planner(db_session, [india_hub.id]) as client:
            resp = await client.get("/chambers")
        codes = {row["code"] for row in resp.json()}
        assert codes == {"IN-CH1"}
    finally:
        _teardown()


async def test_chambers_create_out_of_scope_lab_region_forbidden(db_session):
    india_hub = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)

    try:
        async with await _as_scoped_hub_planner(db_session, [india_hub.id]) as client:
            resp = await client.post(
                "/chambers",
                json={"code": "GR-CHX", "lab_region": LabRegion.GREECE.value, "max_concurrent": 2},
            )
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_chambers_create_in_scope_lab_region_allowed(db_session):
    india_hub = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)

    try:
        async with await _as_scoped_hub_planner(db_session, [india_hub.id]) as client:
            resp = await client.post(
                "/chambers",
                json={"code": "IN-CHX", "lab_region": LabRegion.INDIA.value, "max_concurrent": 2},
            )
        assert resp.status_code == 201
    finally:
        _teardown()


# ---- Prioritization Matrix --------------------------------------------------


async def test_priorities_list_hub_scoped(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    await make_project(db_session, hub_a, name="Priority A")
    await make_project(db_session, hub_b, name="Priority B")

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.get("/priorities")
        names = {row["project_name"] for row in resp.json()}
        assert names == {"Priority A"}
    finally:
        _teardown()


# ---- Global RPD Dashboard ----------------------------------------------------


async def test_dashboard_pipeline_totals_hub_scoped(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    await make_project(db_session, hub_a, name="Dash A")
    await make_project(db_session, hub_b, name="Dash B")
    await make_project(db_session, hub_b, name="Dash B2")

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.get("/dashboard/pipeline-totals")
        assert resp.status_code == 200
        assert resp.json()["total_count"] == 1
    finally:
        _teardown()


async def test_dashboard_pipeline_totals_unrestricted_for_executive_viewer(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    await make_project(db_session, hub_a, name="Dash C")
    await make_project(db_session, hub_b, name="Dash D")

    try:
        async with await _as_unrestricted(db_session, RoleName.EXECUTIVE_VIEWER) as client:
            resp = await client.get("/dashboard/pipeline-totals")
        assert resp.status_code == 200
        assert resp.json()["total_count"] >= 2
    finally:
        _teardown()


# ---- RPD Capacity ------------------------------------------------------------


async def test_capacity_hub_load_hub_scoped_to_caller_hub_only(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    # A second, out-of-scope hub must exist in the DB so this test actually
    # proves filtering happened (rather than there being nothing to filter).
    await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.get("/capacity/hub-load")
        assert resp.status_code == 200
        hubs_seen = {row["hub"] for row in resp.json()["rows"]}
        assert hubs_seen == {HubName.RD_GREECE.value}
        assert HubName.PD_ROMANIA.value not in hubs_seen
    finally:
        _teardown()


# ---- Gantt -------------------------------------------------------------------


async def test_gantt_hub_planner_sees_only_own_hub_projects(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    await make_project(db_session, hub_a, name="Gantt A")
    await make_project(db_session, hub_b, name="Gantt B")
    # No active ScheduleRun needed to prove hub filtering would apply once
    # one exists, but the endpoint's own "no active run" short-circuit means
    # we need a real active run + snapshot rows to see any project rows at
    # all — build one via a schedule run + explicit outcome-free snapshot.
    run = await make_schedule_run(db_session, is_active=True)

    try:
        async with await _as_scoped_hub_planner(db_session, [hub_a.id]) as client:
            resp = await client.get("/gantt")
        assert resp.status_code == 200
        assert resp.json()["has_active_schedule_run"] is True
        names = {row["project_name"] for row in resp.json()["rows"]}
        assert names == {"Gantt A"}
    finally:
        _teardown()
    assert run.is_active is True  # sanity: the run this test built is the active one


async def test_gantt_engineer_sees_only_own_assignments(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    template = await make_workflow_step_template(db_session)
    engineer = await make_engineer(db_session, hub, name="Own Engineer")
    other_engineer = await make_engineer(db_session, hub, name="Other Engineer")

    project_mine = await make_project(db_session, hub, name="Mine", leader=engineer)
    project_other = await make_project(db_session, hub, name="Not Mine", leader=other_engineer)

    run = await make_schedule_run(db_session, is_active=True)

    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id,
            project_id=project_mine.id,
            step_template_id=template.id,
            sequence_order=1,
            duration_weeks=2,
            start_week=31,
            end_week=32,
            assigned_engineer_id=engineer.id,
        )
    )
    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id,
            project_id=project_other.id,
            step_template_id=template.id,
            sequence_order=1,
            duration_weeks=2,
            start_week=31,
            end_week=32,
            assigned_engineer_id=other_engineer.id,
        )
    )
    await db_session.flush()

    # Link the Engineer-role user to their own Engineer row so
    # `Engineer.user_id == principal.user_id` resolves.
    user = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=False, hub_ids=[])
    engineer.user_id = user.id
    await db_session.flush()

    try:
        async with await _as_engineer(db_session, user_id=user.id) as client:
            resp = await client.get("/gantt")
        assert resp.status_code == 200
        names = {row["project_name"] for row in resp.json()["rows"]}
        assert names == {"Mine"}
    finally:
        _teardown()


async def test_gantt_engineer_with_no_linked_engineer_row_sees_nothing(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    template = await make_workflow_step_template(db_session)
    engineer = await make_engineer(db_session, hub, name="Someone Else")
    project = await make_project(db_session, hub, name="Not Yours", leader=engineer)
    run = await make_schedule_run(db_session, is_active=True)
    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id,
            project_id=project.id,
            step_template_id=template.id,
            sequence_order=1,
            duration_weeks=2,
            start_week=31,
            end_week=32,
            assigned_engineer_id=engineer.id,
        )
    )
    await db_session.flush()

    try:
        async with await _as_engineer(db_session) as client:
            resp = await client.get("/gantt")
        assert resp.status_code == 200
        assert resp.json()["rows"] == []
    finally:
        _teardown()
