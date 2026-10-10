"""P12-R01 (security-auditor H-1): a Hub Planner's role-level WRITE only counts
on projects inside their own hub scope.

The project lookups (`api.routers.projects._get_project_or_404`,
`services.workspace.get_scoped_project_or_404`) admit an out-of-hub project
on ANY grant role, Viewer included. Before the fix `authorize_project_action`
then passed on the role matrix alone, so a Hub Planner scoped to hub A with a
Viewer grant on a hub-B project could write it. Now an out-of-hub project is
authorized by the grant's level only (ADR 0012): Viewer writes nothing,
Editor writes stage progress, files and comments, Admin writes everything
project-scoped.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import select

import api.routers.workspace as workspace_router
import services.priority_move as priority_move
import services.run_dispatch as run_dispatch
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, ProjectPriority, ProjectStatus, RoleName
from models.project import Project
from models.project_access import ProjectAccessGrant
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_hub, make_user
from tests.p12_helpers import act_as, client_for, stepped_project
from workers.schedule_tasks import run_greedy_schedule

PDF = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture(autouse=True)
def _no_side_effects(monkeypatch):
    """No Celery, no Redis SSE, no MinIO: an allowed write runs to completion
    against fakes, so its status code is the real handler's answer."""

    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    for module in (run_dispatch, priority_move, workspace_router):
        monkeypatch.setattr(module, "publish_progress", lambda *a, **k: None)

    class _FakeMinio:
        def put_object(self, *args, **kwargs):
            return None

        def remove_object(self, *args, **kwargs):
            return None

    monkeypatch.setattr(workspace_router, "get_minio_client", lambda: _FakeMinio())
    monkeypatch.setattr(workspace_router, "ensure_bucket", lambda *a, **k: None)
    monkeypatch.setattr(
        workspace_router,
        "get_minio_settings",
        lambda: SimpleNamespace(attachments_bucket="rpd-test-attachments"),
    )
    return calls


async def _world(db_session, grant_role: str | None, *, status=ProjectStatus.IN_DEVELOPMENT):
    """Hub A (the planner's) and hub B (the project's), both PDD R&D hubs so a
    hub move A <- B is category-valid. The planner holds `grant_role` on the
    hub-B project (or nothing)."""

    hub_a = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    hub_b = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await stepped_project(
        db_session, hub_b, name="Hub B Project", status=status, priority=ProjectPriority.P2
    )
    granter = await make_user(db_session, RoleName.SUPER_ADMIN, hub_scope_all=True)
    planner = await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub_a.id])
    if grant_role is not None:
        db_session.add(
            ProjectAccessGrant(
                project_id=project.id,
                user_id=planner.id,
                project_role=grant_role,
                granted_by_user_id=granter.id,
            )
        )
        await db_session.flush()
    return SimpleNamespace(hub_a=hub_a, hub_b=hub_b, project=project, planner=planner)


def _upload_kwargs():
    return {
        "files": {"file": ("evidence.pdf", PDF, "application/octet-stream")},
        "data": {"display_name": "Evidence", "category": "Certification"},
    }


#: Every project-scoped write, by name -> (method, path suffix, request kwargs).
WRITES = {
    "patch_rename": ("PATCH", "", lambda w: {"json": {"name": "Renamed via grant"}}),
    "patch_hub_move": ("PATCH", "", lambda w: {"json": {"hub_id": str(w.hub_a.id)}}),
    "priority": ("POST", "/priority", lambda w: {"json": {"priority": "P1"}}),
    "vip": ("PUT", "/vip", lambda w: {"json": {"is_vip": True}}),
    "stage_patch": ("PATCH", "/stages/PDD-A", lambda w: {"json": {"percent_complete": 0}}),
    "file_upload": ("POST", "/files", lambda w: _upload_kwargs()),
    "comment": ("POST", "/comments", lambda w: {"json": {"body_md": "grant comment"}}),
    "recalc": ("POST", "/recalculate", lambda w: {}),
}

#: ADR 0012 §1: the Editor grant's whole write set.
EDITOR_WRITES = {"stage_patch", "file_upload", "comment"}

SUCCESS = {
    "patch_rename": 200,
    "patch_hub_move": 200,
    "priority": 200,
    "vip": 200,
    "stage_patch": 200,
    "file_upload": 201,
    "comment": 201,
    "recalc": 202,
}


async def _call(client, w, name):
    method, suffix, kwargs = WRITES[name]
    return await client.request(method, f"/projects/{w.project.id}{suffix}", **kwargs(w))


async def _audit_count(db_session, w) -> int:
    rows = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.actor_user_id == w.planner.id)
        )
    ).scalars().all()
    return len(rows)


def _expected(grant_role: str, name: str) -> int:
    if grant_role == "admin":
        return SUCCESS[name]
    if grant_role == "editor" and name in EDITOR_WRITES:
        return SUCCESS[name]
    return 403


@pytest.mark.parametrize("name", sorted(WRITES))
@pytest.mark.parametrize("grant_role", ["viewer", "editor", "admin"])
async def test_out_of_hub_planner_write_is_decided_by_the_grant(db_session, grant_role, name):
    w = await _world(db_session, grant_role)

    async with client_for(db_session) as client:
        resp = await _call(client, w, name)

    expected = _expected(grant_role, name)
    assert resp.status_code == expected, resp.text

    project = (
        await db_session.execute(
            select(Project)
            .where(Project.id == w.project.id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    if expected == 403:
        # Nothing was written: no audit row by the caller, the charter intact.
        assert await _audit_count(db_session, w) == 0
        assert project.name == "Hub B Project"
        assert project.hub_id == w.hub_b.id
        assert project.priority == ProjectPriority.P2
        assert project.is_vip is False
    else:
        assert await _audit_count(db_session, w) >= 1


async def test_viewer_grant_cannot_move_project_into_own_hub(db_session):
    """The live-verified escalation: Viewer grant + PATCH hub_id = own hub."""

    w = await _world(db_session, "viewer")
    async with client_for(db_session) as client:
        resp = await _call(client, w, "patch_hub_move")
        # After the denied move the project is still out of scope: a
        # subsequent write is still denied, not newly in scope.
        again = await _call(client, w, "patch_rename")
    assert resp.status_code == 403
    assert again.status_code == 403


async def test_viewer_grant_still_reads(db_session):
    """The fix touches writes only; the grant still surfaces the project."""

    w = await _world(db_session, "viewer")
    async with client_for(db_session) as client:
        detail = await client.get(f"/projects/{w.project.id}")
        workspace = await client.get(f"/projects/{w.project.id}/workspace")
    assert detail.status_code == 200
    assert workspace.status_code == 200


@pytest.mark.parametrize("name", sorted(WRITES))
async def test_out_of_hub_planner_without_grant_gets_404(db_session, name):
    w = await _world(db_session, None)
    async with client_for(db_session) as client:
        resp = await _call(client, w, name)
    assert resp.status_code == 404


@pytest.mark.parametrize("name", sorted(WRITES))
async def test_in_hub_planner_role_write_unchanged(db_session, name):
    """No grant needed in the planner's own hub (ADR 0012 rule 3). The hub
    move targets the planner's second scoped hub."""

    w = await _world(db_session, None)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub_a.id, w.hub_b.id])
    async with client_for(db_session) as client:
        resp = await _call(client, w, name)
    assert resp.status_code == SUCCESS[name], resp.text


@pytest.mark.parametrize("name", sorted(WRITES))
async def test_hub_scope_all_role_write_unchanged(db_session, name):
    w = await _world(db_session, None)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await _call(client, w, name)
    assert resp.status_code == SUCCESS[name], resp.text


@pytest.mark.parametrize(
    ("grant_role", "denied"), [("viewer", True), ("editor", True), ("admin", False)]
)
async def test_submit_from_draft_needs_admin_grant_out_of_hub(db_session, grant_role, denied):
    """`POST /projects/{id}/submit` had the same shape (role `_write` plus a
    grant-admitting lookup) and is closed the same way."""

    w = await _world(db_session, grant_role, status=ProjectStatus.DRAFT)
    async with client_for(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/submit", json={})
    if denied:
        assert resp.status_code == 403
    else:
        # Authorized: the handler's own answer (200, or 422 for missing
        # hard-gate fields), never a permission error.
        assert resp.status_code in (200, 422), resp.text
