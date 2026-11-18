"""P47-R01: the P47-T04 security gate follow-ups.

- M-1: every authorisation and scope check runs before the `base`
  comparison. A stale `base` never turns a 403 into a 409 carrying values:
  user PATCH on an Admin / Super Admin account, a D1 role removal, a
  Cancelled status, a hub move out of scope, an unfreeze without the Admin
  role, a chamber moved out of the caller's lab region.
- M-2: a caller without Project Registration READ (an Engineer with an Admin
  project grant) gets the four financial fields as `null` from
  `PATCH /projects/{id}`, and may not send them in the edit or in `base`
  (422 `FINANCIAL_FIELDS_HIDDEN`, nothing written).
- L-1: VIP link conflicts name only a link change to a project the caller
  can see, and never fall back to the item's newest row.
- I-1: the VIP pin re-checks scope on the row it locked.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import func, insert, select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    HubName,
    LabRegion,
    ProjectAccessRole,
    ProjectCategory,
    ProjectStatus,
    RoleName,
)
from models.project import Project
from models.project_access import ProjectAccessGrant
from models.user import User
from models.vip import vip_item_projects
from services import priority_move
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_chamber, make_hub, make_user
from tests.p12_helpers import client_for, stepped_project
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[Any] = []
    monkeypatch.setattr(
        run_greedy_schedule,
        "delay",
        lambda *a, **k: calls.append(a) or SimpleNamespace(id=f"t-{len(calls)}"),
    )
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return calls


def _as(
    user: User, *roles: RoleName, hub_ids: list[uuid.UUID] | None = None
) -> None:
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=hub_ids is None,
            hub_ids=hub_ids or [],
        )
    )


def _no_conflict(resp: Response, status: int, code: str | None = None) -> None:
    assert resp.status_code == status, resp.text
    assert "conflicts" not in resp.json()
    if code is not None:
        assert resp.json().get("code") == code


async def _audits(db) -> int:
    return int((await db.execute(select(func.count()).select_from(AuditLogEntry))).scalar_one())


# --------------------------------------------------------------------------
# M-1: authorise before the comparison
# --------------------------------------------------------------------------


async def test_admin_with_stale_base_on_super_admin_account_gets_403(db_session):
    target = await make_user(db_session, RoleName.SUPER_ADMIN, full_name="Sam Super")
    admin = await make_user(db_session, RoleName.ADMIN, full_name="Ada Admin")
    _as(admin, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/users/{target.id}",
            json={"full_name": "Hacked", "base": {"full_name": "Not the stored name"}},
        )
    _no_conflict(resp, 403, "ADMIN_ACCOUNT_REQUIRES_SUPER_ADMIN")
    assert "Sam Super" not in resp.text


async def test_admin_role_removal_with_stale_base_gets_super_admin_only(db_session):
    target = await make_user(
        db_session, RoleName.HUB_PLANNER, RoleName.PORTFOLIO_MANAGER, full_name="Pat"
    )
    admin = await make_user(db_session, RoleName.ADMIN)
    _as(admin, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/users/{target.id}",
            json={"roles": ["Hub Planner"], "base": {"roles": ["Executive Viewer"]}},
        )
    _no_conflict(resp, 403, "SUPER_ADMIN_ONLY")


async def test_project_cancel_and_hub_move_403_before_conflict(db_session, dispatch):
    greece = await make_hub(db_session)
    india = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    project = await stepped_project(db_session, greece, name="Guarded", actual_start_week=20)
    admin = await make_user(db_session, RoleName.ADMIN)
    planner = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False,
                              hub_ids=[greece.id])
    stale = {"status": "On Hold", "hub_id": str(india.id), "actual_start_week": 1}
    async with client_for(db_session) as client:
        _as(admin, RoleName.ADMIN)
        resp = await client.patch(
            f"/projects/{project.id}", json={"status": "Cancelled", "base": stale}
        )
        _no_conflict(resp, 403, "SUPER_ADMIN_ONLY")
        _as(planner, RoleName.HUB_PLANNER, hub_ids=[greece.id])
        resp = await client.patch(
            f"/projects/{project.id}", json={"hub_id": str(india.id), "base": stale}
        )
        _no_conflict(resp, 403)


async def test_unfreeze_without_admin_role_is_403_before_conflict(db_session, dispatch):
    hub = await make_hub(db_session)
    project = await stepped_project(db_session, hub, name="Frozen", actual_start_week=20,
                                    frozen=True)
    planner = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False,
                              hub_ids=[hub.id])
    _as(planner, RoleName.HUB_PLANNER, hub_ids=[hub.id])
    async with client_for(db_session) as client:
        resp = await client.post(
            f"/gantt/projects/{project.id}/freeze",
            json={"frozen": False, "base": {"frozen": False}},
        )
    _no_conflict(resp, 403, "UNFREEZE_REQUIRES_ADMIN")


async def test_chamber_moved_out_of_scope_is_403_before_conflict(db_session):
    greece = await make_hub(db_session)
    chamber = await make_chamber(db_session, code="CH-R01", lab_region=LabRegion.GREECE)
    planner = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False,
                              hub_ids=[greece.id])
    _as(planner, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/chambers/{chamber.id}",
            json={"lab_region": "India", "base": {"lab_region": "Romania"}},
        )
    _no_conflict(resp, 403)


# --------------------------------------------------------------------------
# M-2: financial fields for a caller without Project Registration READ
# --------------------------------------------------------------------------


async def _granted_engineer(db) -> SimpleNamespace:
    hub = await make_hub(db)
    project = await stepped_project(
        db, hub, name="Secret money", tcogs_eur=1234.5, selling_price_eur=2000.0,
        gross_margin_pct=33.0, customer_name="Acme Hidden",
    )
    granter = await make_user(db, RoleName.ADMIN)
    eng = await make_user(db, RoleName.ENGINEER, hub_scope_all=False, hub_ids=[hub.id])
    db.add(ProjectAccessGrant(project_id=project.id, user_id=eng.id,
                              project_role=ProjectAccessRole.ADMIN,
                              granted_by_user_id=granter.id))
    await db.flush()
    return SimpleNamespace(hub=hub, project=project, pid=project.id, eng=eng, granter=granter)


async def test_patch_masks_financials_for_caller_without_registration_read(
    db_session, dispatch
):
    w = await _granted_engineer(db_session)
    _as(w.eng, RoleName.ENGINEER, hub_ids=[w.hub.id])
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{w.pid}", json={"name": "Renamed"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["name"] == "Renamed"
        for name in ("tcogs_eur", "selling_price_eur", "gross_margin_pct", "customer_name"):
            assert body[name] is None
        assert "Acme Hidden" not in resp.text and "1234.5" not in resp.text
        # An Admin still gets the values.
        _as(w.granter, RoleName.ADMIN)
        resp = await client.patch(f"/projects/{w.pid}", json={"name": "Renamed again"})
        assert resp.json()["customer_name"] == "Acme Hidden"
        assert resp.json()["tcogs_eur"] == 1234.5


@pytest.mark.parametrize(
    "body",
    [
        {"tcogs_eur": 1.0},
        {"customer_name": "Guess"},
        {"name": "X", "base": {"gross_margin_pct": 33.0}},
        {"name": "X", "base": {"selling_price_eur": 1}},
    ],
)
async def test_hidden_financials_refused_in_edit_and_base(db_session, dispatch, body):
    w = await _granted_engineer(db_session)
    before = await _audits(db_session)
    _as(w.eng, RoleName.ENGINEER, hub_ids=[w.hub.id])
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{w.pid}", json=body)
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "FINANCIAL_FIELDS_HIDDEN"
    assert "conflicts" not in resp.json()
    assert await _audits(db_session) == before
    stored = (
        await db_session.execute(select(Project.name).where(Project.id == w.pid))
    ).scalar_one()
    assert stored == "Secret money"


# --------------------------------------------------------------------------
# L-1: VIP link conflicts within the caller's scope
# --------------------------------------------------------------------------


async def test_vip_link_changed_by_only_from_visible_rows(db_session, dispatch):
    greece = await make_hub(db_session)
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.GREECE,
                         is_oem=True)
    mine = await stepped_project(db_session, greece, name="Visible one")
    mine2 = await stepped_project(db_session, greece, name="Visible two")
    hidden = await stepped_project(db_session, oem, name="Out of scope",
                                   category=ProjectCategory.A_OEM)
    alice = await make_user(db_session, RoleName.ADMIN, full_name="Alice Writer")
    carol = await make_user(db_session, RoleName.ADMIN, full_name="Carol Hidden")
    scoped = await make_user(db_session, RoleName.ADMIN, full_name="Scoped Admin",
                             hub_scope_all=False, hub_ids=[greece.id])
    async with client_for(db_session) as client:
        _as(alice, RoleName.ADMIN)
        item = (await client.post("/vip-items", json={
            "area": "Greece", "pillar": "INNOVATION", "title": "Board"})).json()
        item = item.get("item", item)
        url = f"/vip-items/{item['id']}/projects"
        assert (await client.put(url, json={"project_ids": [str(mine.id)]})).status_code == 200
        _as(carol, RoleName.ADMIN)
        assert (await client.put(url, json={
            "project_ids": [str(mine.id), str(hidden.id)]})).status_code == 200
        # The scoped caller saw no links; Alice's visible link is the change.
        _as(scoped, RoleName.ADMIN, hub_ids=[greece.id])
        resp = await client.put(url, json={"project_ids": [str(mine2.id)],
                                           "base": {"project_ids": []}})
    assert resp.status_code == 409, resp.text
    (c,) = resp.json()["conflicts"]
    assert c["current_value"] == [str(mine.id)]
    assert c["changed_by"] == "Alice Writer"
    assert "Carol" not in resp.text


async def test_vip_link_without_visible_row_has_no_changed_by(db_session, dispatch):
    greece = await make_hub(db_session)
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.GREECE,
                         is_oem=True)
    mine = await stepped_project(db_session, greece, name="Visible one")
    mine2 = await stepped_project(db_session, greece, name="Visible two")
    hidden = await stepped_project(db_session, oem, name="Out of scope",
                                   category=ProjectCategory.A_OEM)
    carol = await make_user(db_session, RoleName.ADMIN, full_name="Carol Hidden")
    scoped = await make_user(db_session, RoleName.ADMIN, hub_scope_all=False,
                             hub_ids=[greece.id])
    async with client_for(db_session) as client:
        _as(carol, RoleName.ADMIN)
        item = (await client.post("/vip-items", json={
            "area": "Greece", "pillar": "INNOVATION", "title": "Board"})).json()
        item = item.get("item", item)
        url = f"/vip-items/{item['id']}/projects"
        # A visible link with no audit row (e.g. a data load), then Carol's
        # audited link to a project the scoped caller cannot see.
        await db_session.execute(insert(vip_item_projects).values(
            item_id=uuid.UUID(item["id"]), project_id=mine.id))
        assert (await client.put(url, json={
            "project_ids": [str(mine.id), str(hidden.id)]})).status_code == 200
        _as(scoped, RoleName.ADMIN, hub_ids=[greece.id])
        resp = await client.put(url, json={"project_ids": [str(mine2.id)],
                                           "base": {"project_ids": []}})
    assert resp.status_code == 409, resp.text
    (c,) = resp.json()["conflicts"]
    assert c["changed_by"] is None and c["changed_at"] is None
    assert "Carol" not in resp.text


# --------------------------------------------------------------------------
# I-1: VIP pin re-checks scope on the locked row
# --------------------------------------------------------------------------


async def test_vip_pin_with_base_still_scoped(db_session, dispatch):
    greece = await make_hub(db_session)
    india = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    far = await stepped_project(db_session, india, name="Far", status=ProjectStatus.IN_QUEUE)
    planner = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False,
                              hub_ids=[greece.id])
    _as(planner, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with client_for(db_session) as client:
        resp = await client.put(f"/projects/{far.id}/vip",
                                json={"is_vip": True, "base": {"is_vip": True}})
    _no_conflict(resp, 404)
