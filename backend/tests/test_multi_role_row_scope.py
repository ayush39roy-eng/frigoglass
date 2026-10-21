"""Multi-role row scoping (2026-10-21 RBAC regression fix).

DOMAIN_RULES "Project access grants and delegation" (ADR 0012): a principal's
access is the MAX over every rule that applies, so holding Engineer in
addition to a hub-scoped role (Portfolio Manager, Hub Planner, Executive
Viewer, Admin) must never narrow what that role already shows. Before the
fix, `services.hub_scope.is_engineer_self_scoped` keyed on "Engineer role and
empty `hub_ids`", which is every `hub_scope_all` account. The dev user
`alice.pm` (PM + Hub Planner + Engineer + Executive Viewer, no linked
`Engineer` row) therefore got 0 Gantt rows and an empty check-in due list,
while the Dashboard (plain hub filter) showed 253.

Exception, by decision: the Capacity engineer heatmap. ADR 0028's 2026-10-19
amendment says any caller holding Engineer sees only their own heatmap row,
even with a Capacity-reading role (GDPR, OQ #8). That stays, and is pinned
here so it is not widened by accident.

Main invariant tested here, on every project-row surface: for any role set R,
the response for R + Engineer equals the response for R. Plus the union case
(Hub Planner of one hub + Engineer assigned in another hub), and the cases
that must stay narrow (Engineer only, Engineer + Auditor, Engineer only with
stray `hub_ids`).
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, RoleName
from models.project import Project
from services.hub_scope import (
    has_hub_project_scope,
    is_engineer_self_scoped,
    needs_own_assignments,
    project_row_scope,
)
from services.notifications import _resolve_recipients
from tests.auth_helpers import clear_current_principal_override, make_principal
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import (
    act_as,
    add_outcome,
    client_for,
    link_engineer,
    plan_step,
    stepped_project,
)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


# --- Pure predicates ------------------------------------------------------------------

_BROADER = [
    RoleName.PORTFOLIO_MANAGER,
    RoleName.HUB_PLANNER,
    RoleName.EXECUTIVE_VIEWER,
    RoleName.ADMIN,
    RoleName.SUPER_ADMIN,
]


@pytest.mark.parametrize("broader", _BROADER)
@pytest.mark.parametrize("hub_scope_all", [True, False])
def test_engineer_plus_hub_scoped_role_is_not_self_scoped(broader, hub_scope_all):
    principal = make_principal(RoleName.ENGINEER, broader, hub_scope_all=hub_scope_all)
    assert has_hub_project_scope(principal)
    assert is_engineer_self_scoped(principal) is False


def test_alice_shape_is_not_self_scoped_and_needs_no_own_query():
    alice = make_principal(
        RoleName.PORTFOLIO_MANAGER,
        RoleName.HUB_PLANNER,
        RoleName.ENGINEER,
        RoleName.EXECUTIVE_VIEWER,
        hub_scope_all=True,
    )
    assert is_engineer_self_scoped(alice) is False
    assert needs_own_assignments(alice) is False
    assert project_row_scope(alice, Project.hub_id, None) is None


@pytest.mark.parametrize(
    "principal",
    [
        make_principal(RoleName.ENGINEER, hub_scope_all=False),
        make_principal(RoleName.ENGINEER, hub_scope_all=True),  # P10-F01 shape
        make_principal(RoleName.ENGINEER, RoleName.AUDITOR, hub_scope_all=True),
        make_principal(RoleName.ENGINEER, hub_scope_all=False, hub_ids=[uuid.uuid4()]),
    ],
    ids=["engineer", "engineer-hub-scope-all", "engineer-auditor", "engineer-stray-hub-ids"],
)
def test_engineer_without_hub_scoped_role_stays_self_scoped(principal):
    assert is_engineer_self_scoped(principal) is True
    assert needs_own_assignments(principal) is True
    # No linked engineer: always-false, never "no filter".
    scope = project_row_scope(principal, Project.hub_id, None)
    assert scope is not None
    assert "false" in str(scope.compile(compile_kwargs={"literal_binds": True})).lower()


def test_hub_planner_plus_engineer_scope_is_hub_or_own():
    hub = uuid.uuid4()
    principal = make_principal(
        RoleName.HUB_PLANNER, RoleName.ENGINEER, hub_scope_all=False, hub_ids=[hub]
    )
    assert needs_own_assignments(principal) is True
    own = Project.id.in_([uuid.uuid4()])
    sql = str(project_row_scope(principal, Project.hub_id, own)).upper()
    assert " OR " in sql and "HUB_ID" in sql and "PROJECTS.ID" in sql
    # Without Engineer, own is ignored.
    plain = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub])
    assert " OR " not in str(project_row_scope(plain, Project.hub_id, own)).upper()


# --- API world --------------------------------------------------------------------------


async def _world(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    eng_gr = await make_engineer(db_session, gr, name="Greek Engineer")
    eng_in = await make_engineer(db_session, india, name="Indian Engineer")
    baseline = await make_schedule_run(db_session, is_active=False)
    run = await make_schedule_run(db_session, is_active=True)

    greek = await stepped_project(db_session, gr, name="Greek project", leader=eng_gr)
    indian = await stepped_project(db_session, india, name="Indian project", leader=eng_in)
    for project, engineer in ((greek, eng_gr), (indian, eng_in)):
        await plan_step(db_session, run, project, "PDD-E", 28, 34, engineer=engineer)
        await plan_step(db_session, run, project, "PDD-F", 31, 34, engineer=engineer)
        await add_outcome(db_session, baseline, project, projected=40)
        await add_outcome(db_session, run, project, projected=44)
    return SimpleNamespace(
        gr=gr,
        india=india,
        eng_gr=eng_gr,
        eng_in=eng_in,
        run=run,
        baseline=baseline,
        greek=greek,
        indian=indian,
    )


def _paths(w) -> dict[str, str]:
    return {
        "gantt": "/gantt?limit=500",
        "engineer_utilization": "/capacity/engineer-utilization",
        "hub_load": "/capacity/hub-load",
        "workspace": f"/projects/{w.indian.id}/workspace",
        "dashboard_projects": "/dashboard/projects?limit=500",
        "planning_resource_load": "/planning/resource-load",
        "priority_board": "/priority-board",
        "matrix": "/priorities",
        "check_in_due": "/check-ins/due",
        "run_changes": f"/schedule-runs/{w.run.id}/changes?against={w.baseline.id}",
        "notifications": "/notifications",
    }


async def _snapshot(db_session, w, *roles: RoleName) -> dict[str, tuple[int, object]]:
    await act_as(db_session, *roles, hub_scope_all=True)
    out: dict[str, tuple[int, object]] = {}
    async with client_for(db_session) as client:
        for key, path in _paths(w).items():
            r = await client.get(path)
            out[key] = (r.status_code, r.json() if r.status_code == 200 else None)
    return out


def _names(body, key="project_name") -> set[str]:
    return {row[key] for row in body["rows"]}


@pytest.mark.parametrize(
    "roles",
    [
        (RoleName.PORTFOLIO_MANAGER,),
        (RoleName.PORTFOLIO_MANAGER, RoleName.HUB_PLANNER, RoleName.EXECUTIVE_VIEWER),
        (RoleName.EXECUTIVE_VIEWER,),
        (RoleName.ADMIN,),
    ],
    ids=["pm", "alice-shape", "exec-viewer", "admin"],
)
async def test_adding_engineer_without_link_never_narrows(db_session, roles):
    """The owner's dev symptom, on every project-row surface: R + Engineer
    (no linked Engineer row, `hub_scope_all=True`) answers exactly what R
    answers."""

    w = await _world(db_session)
    without = await _snapshot(db_session, w, *roles)
    with_engineer = await _snapshot(db_session, w, *roles, RoleName.ENGINEER)

    for key in _paths(w):
        assert with_engineer[key][0] == without[key][0], key
        if key == "engineer_utilization":
            continue  # ADR 0028 own-row rule, asserted below
        if key == "workspace" and without[key][1] is not None:
            # Same project and schedule; viewer-specific flags may differ only
            # if Engineer added access, which it cannot here.
            assert with_engineer[key][1]["project"] == without[key][1]["project"], key
            continue
        assert with_engineer[key][1] == without[key][1], key

    # The figures are not trivially empty: R sees both hubs.
    status, gantt = with_engineer["gantt"]
    assert status == 200 and _names(gantt) == {"Greek project", "Indian project"}
    status, changes = with_engineer["run_changes"]
    assert status == 200 and _names(changes) == {"Greek project", "Indian project"}
    if without["engineer_utilization"][0] == 200:
        names = {e["name"] for e in without["engineer_utilization"][1]["engineers"]}
        assert names == {"Greek Engineer", "Indian Engineer"}
        # ADR 0028 amendment: holding Engineer = own heatmap row only (none here).
        assert with_engineer["engineer_utilization"][1]["engineers"] == []
    if with_engineer["check_in_due"][0] == 200:
        due = {p["name"] for p in with_engineer["check_in_due"][1]["projects"]}
        assert due == {"Greek project", "Indian project"}
    assert with_engineer["workspace"][0] == 200
    assert with_engineer["dashboard_projects"][0] == 200
    assert with_engineer["dashboard_projects"][1]["total_count"] == 2


async def test_alice_shape_matches_admin_counts(db_session):
    """The exact dev account: PM + HP + Engineer + EV, `hub_scope_all`, no
    engineer link. Before the fix: Gantt 0, due list 0. The heatmap stays
    empty for her by ADR 0028 (own row only, and she has no engineer row)."""

    w = await _world(db_session)
    alice = await _snapshot(
        db_session,
        w,
        RoleName.PORTFOLIO_MANAGER,
        RoleName.HUB_PLANNER,
        RoleName.ENGINEER,
        RoleName.EXECUTIVE_VIEWER,
    )
    admin = await _snapshot(db_session, w, RoleName.ADMIN)
    assert alice["gantt"][1]["total_count"] == admin["gantt"][1]["total_count"] == 2
    assert alice["engineer_utilization"][1]["engineers"] == []
    assert len(admin["engineer_utilization"][1]["engineers"]) == 2
    assert (
        len(alice["check_in_due"][1]["projects"]) == len(admin["check_in_due"][1]["projects"]) == 2
    )
    assert len(alice["run_changes"][1]["rows"]) == 2
    assert alice["run_changes"][1]["hidden_count"] == 0


async def test_hub_planner_plus_engineer_sees_hub_union_own_assignments(db_session):
    """HP of Greece + Engineer linked to the Indian engineer: rows are the
    Greek hub OR own assignments, never only one of them (ADR 0012 MAX)."""

    w = await _world(db_session)
    user = await act_as(
        db_session, RoleName.HUB_PLANNER, RoleName.ENGINEER, hub_ids=[w.gr.id], hub_scope_all=False
    )
    await link_engineer(db_session, w.eng_in, user)
    async with client_for(db_session) as client:
        gantt = await client.get("/gantt?limit=500")
        changes = await client.get(f"/schedule-runs/{w.run.id}/changes?against={w.baseline.id}")
        due = await client.get("/check-ins/due")
        workspace = await client.get(f"/projects/{w.indian.id}/workspace")
        heatmap = await client.get("/capacity/engineer-utilization")
        dashboard = await client.get("/dashboard/projects?limit=500")

    assert _names(gantt.json()) == {"Greek project", "Indian project"}
    assert _names(changes.json()) == {"Greek project", "Indian project"}
    assert changes.json()["hidden_count"] == 0
    assert {p["name"] for p in due.json()["projects"]} == {"Greek project", "Indian project"}
    assert workspace.status_code == 200
    # ADR 0028: own heatmap row only, ANDed with the hub scope; the own row
    # is in India, outside the Greek scope, so none.
    assert heatmap.json()["engineers"] == []
    # Engineer grants no Dashboard read, so it stays hub-scoped.
    assert {r["project_name"] for r in dashboard.json()["rows"]} == {"Greek project"}


async def test_hub_planner_plus_unlinked_engineer_keeps_hub_scope(db_session):
    w = await _world(db_session)
    await act_as(
        db_session, RoleName.HUB_PLANNER, RoleName.ENGINEER, hub_ids=[w.gr.id], hub_scope_all=False
    )
    async with client_for(db_session) as client:
        gantt = await client.get("/gantt?limit=500")
        heatmap = await client.get("/capacity/engineer-utilization")
    assert _names(gantt.json()) == {"Greek project"}
    assert heatmap.json()["engineers"] == []  # ADR 0028 own-row rule, no link


@pytest.mark.parametrize(
    ("extra_roles", "hub_scope_all", "stray_hub"),
    [
        ((), False, False),
        ((), True, False),  # P10-F01 shape
        ((RoleName.AUDITOR,), True, False),
        ((), False, True),
    ],
    ids=["engineer", "engineer-hub-scope-all", "engineer-auditor", "engineer-stray-hub-ids"],
)
async def test_engineer_without_hub_scoped_role_sees_own_assignments_only(
    db_session, extra_roles, hub_scope_all, stray_hub
):
    w = await _world(db_session)
    user = await act_as(
        db_session,
        RoleName.ENGINEER,
        *extra_roles,
        hub_ids=[w.india.id] if stray_hub else None,
        hub_scope_all=hub_scope_all,
    )
    await link_engineer(db_session, w.eng_gr, user)
    async with client_for(db_session) as client:
        gantt = await client.get("/gantt?limit=500")
        changes = await client.get(f"/schedule-runs/{w.run.id}/changes?against={w.baseline.id}")
        due = await client.get("/check-ins/due")
        other = await client.get(f"/projects/{w.indian.id}/workspace")
        heatmap = await client.get("/capacity/engineer-utilization")
    assert _names(gantt.json()) == {"Greek project"}
    assert _names(changes.json()) == {"Greek project"}
    assert changes.json()["hidden_count"] == 1
    assert {p["name"] for p in due.json()["projects"]} == {"Greek project"}
    assert other.status_code == 404
    assert heatmap.status_code == 403


async def test_unlinked_engineer_only_sees_nothing(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ENGINEER, hub_scope_all=False)
    async with client_for(db_session) as client:
        gantt = await client.get("/gantt?limit=500")
        changes = await client.get(f"/schedule-runs/{w.run.id}/changes?against={w.baseline.id}")
    assert gantt.json()["rows"] == []
    assert changes.json()["rows"] == [] and changes.json()["hidden_count"] == 2


async def test_notification_recipients_keep_broader_role_scope(db_session):
    """Notifications already used the union rule (P10-F01); pinned here for
    the alice shape so the two paths cannot drift."""

    await _world(db_session)
    alice = await act_as(
        db_session,
        RoleName.PORTFOLIO_MANAGER,
        RoleName.HUB_PLANNER,
        RoleName.ENGINEER,
        RoleName.EXECUTIVE_VIEWER,
        hub_scope_all=True,
    )
    hub_all, _hub_scoped, _engineers = await _resolve_recipients(db_session)
    assert alice.id in hub_all
