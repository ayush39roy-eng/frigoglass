"""P14-T02: the curated VIP board (ADR 0027; docs/API_CONTRACT_P14.md §2)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, ProjectCategory, ProjectPriority, RoleName
from models.hub import Hub
from models.project import Project
from models.vip import VipArea, VipItem, VipPillar, vip_item_projects
from seed.seed_vip_board import seed_item_count, seed_vip_board
from services.vip_board import vip_area_for_hub
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_hub, make_schedule_run
from tests.p12_helpers import act_as, add_outcome, client_for, stepped_project


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


_HUBS = (
    (HubName.OEM_HCK, LabRegion.GREECE, True),
    (HubName.OEM_SELTEK, LabRegion.GREECE, True),
    (HubName.RD_GREECE, LabRegion.GREECE, False),
    (HubName.PD_ROMANIA, LabRegion.ROMANIA, False),
    (HubName.RD_INDIA, LabRegion.INDIA, False),
    (HubName.PD_INDIA, LabRegion.INDIA, False),
)


async def _hubs(db) -> dict[HubName, Hub]:
    return {
        name: await make_hub(db, name=name, lab_region=region, is_oem=oem)
        for name, region, oem in _HUBS
    }


async def _project(db, hub: Hub, name: str, **kw) -> Project:
    if hub.is_oem:
        kw.setdefault("category", ProjectCategory.A_OEM)
    return await stepped_project(db, hub, name=name, **kw)


async def _vip_count(db, action: str) -> int:
    return await db.scalar(
        select(func.count()).select_from(AuditLogEntry).where(AuditLogEntry.action == action)
    ) or 0


async def _item(db, area: VipArea, title: str) -> VipItem:
    return (
        await db.execute(select(VipItem).where(VipItem.area == area, VipItem.title == title))
    ).scalar_one()


# --- area derivation ----------------------------------------------------------------


def test_area_is_lab_region_with_oem_hubs_as_greece():
    def hub(region: LabRegion, oem: bool) -> Hub:
        return Hub(name=HubName.RD_GREECE, lab_region=region, is_oem=oem)

    # ADR 0027 amendment (OQ #39): area = lab region; OEM hubs count as
    # Greece, even on a DB that predates p13a (OEM lab region India).
    assert vip_area_for_hub(hub(LabRegion.GREECE, True)) == VipArea.GREECE
    assert vip_area_for_hub(hub(LabRegion.INDIA, True)) == VipArea.GREECE
    assert vip_area_for_hub(hub(LabRegion.GREECE, False)) == VipArea.GREECE
    assert vip_area_for_hub(hub(LabRegion.ROMANIA, False)) == VipArea.ROMANIA
    assert vip_area_for_hub(hub(LabRegion.INDIA, False)) == VipArea.INDIA


# --- seed ---------------------------------------------------------------------------


async def test_seed_is_idempotent_and_links_by_exact_name(db_session):
    hubs = await _hubs(db_session)
    s8 = await _project(db_session, hubs[HubName.OEM_SELTEK], "S8 for Kazakhstan")
    bee1 = await _project(db_session, hubs[HubName.RD_INDIA], "BEE star labelling - S-300")
    bee2 = await _project(db_session, hubs[HubName.RD_INDIA], "BEE star labelling CT 50")
    # Same prefix on another hub: never linked (prefix match is R&D-India only).
    bee_pd = await _project(db_session, hubs[HubName.PD_INDIA], "BEE star labelling PD")
    # Near miss: not an exact name, never linked.
    near = await _project(db_session, hubs[HubName.RD_GREECE], "IC3-450 B rating (v2)")
    # The exact name, but in a hub outside the item's area: not linked.
    wrong_area = await _project(db_session, hubs[HubName.RD_INDIA], "Shekel 750")
    # Europe slide → Romania: an R&D-Greece project is now outside the area.
    greek = await _project(db_session, hubs[HubName.RD_GREECE], "Beatbox Max 450 3D logo")
    # Linked to a plain (not highlighted) item: linked, but not VIP.
    drawer = await _project(db_session, hubs[HubName.OEM_HCK], "DRAWER MODELS IMPROVEMENTS")
    pinned = await _project(db_session, hubs[HubName.PD_INDIA], "Old pin", is_vip=True)

    first = await seed_vip_board(db_session)
    assert first["items_created"] == seed_item_count() == 49
    assert first["links_added"] == 4
    # ADR 0040: links never set is_vip; only the one manual pin exists.
    assert "is_vip_set" not in first and "is_vip_cleared" not in first
    assert first["is_vip_pins"] == 1
    reasons = {u["link"]: u["reason"] for u in first["unresolved"]}
    assert reasons["Shekel 750"] == "outside area"
    assert reasons["IC3-450 B rating"] == "absent"
    assert reasons["Beatbox Max 450 3D logo"] == "outside area"
    # ADR 0040: linked to a highlighted item, still not VIP.
    for p in (s8, bee1, bee2, bee_pd, near, wrong_area, greek, drawer):
        await db_session.refresh(p)
        assert p.is_vip is False
    await db_session.refresh(pinned)
    assert pinned.is_vip is True  # a manual pin is left as it is

    bee = await _item(
        db_session, VipArea.INDIA, "BEE 5-star labelling, report submission by 01st Jan 2027"
    )
    assert bee.highlighted and bee.status_tag.value == "HIGH_RISK"
    coffee = await _item(db_session, VipArea.ROMANIA, "Coffee Combo (OMS 750 + Coffee m/c)")
    assert coffee.status_note == "to meet Brau timelines"
    monster = await _item(db_session, VipArea.GREECE, "Monster Range:")
    children = (
        await db_session.execute(select(VipItem).where(VipItem.parent_id == monster.id))
    ).scalars().all()
    assert sorted(c.title for c in children) == [
        "Mini Cube R600a with GMC", "Slim Counter Top R600a with GMC", "Twin Reach R600a",
    ]

    # An in-app edit survives a re-run, and nothing is duplicated. ADR 0040:
    # a manual pin on a linked project is never cleared by the seed either.
    coffee.status_note = "edited"
    drawer.is_vip = True
    await db_session.flush()
    second = await seed_vip_board(db_session)
    assert second["items_created"] == 0 and second["links_added"] == 0
    assert second["is_vip_pins"] == 2
    await db_session.refresh(drawer)
    assert drawer.is_vip is True
    assert await db_session.scalar(select(func.count()).select_from(VipItem)) == 49
    assert await db_session.scalar(select(func.count()).select_from(vip_item_projects)) == 4
    await db_session.refresh(coffee)
    assert coffee.status_note == "edited"
    # Seeds write no audit rows (convention since P9-T01).
    assert await _vip_count(db_session, "project.vip_pin") == 0


# --- GET /vip-board -----------------------------------------------------------------


async def _seeded_board(db):
    hubs = await _hubs(db)
    run = await make_schedule_run(db, is_active=True)
    s8 = await _project(
        db, hubs[HubName.OEM_SELTEK], "S8 for Kazakhstan", priority=ProjectPriority.P1
    )
    flex = await _project(db, hubs[HubName.OEM_HCK], "BEATBOX 3D LOGO FLEX60")
    bee = await _project(db, hubs[HubName.RD_INDIA], "BEE star labelling A")
    shekel = await _project(db, hubs[HubName.PD_ROMANIA], "Shekel 750")
    await add_outcome(db, run, s8, projected=40, within_year=True)
    await seed_vip_board(db)
    return hubs, run, {"s8": s8, "flex": flex, "bee": bee, "shekel": shekel}


def _items_by_title(area: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for item in area["items"]:
        out[item["title"]] = item
        for child in item["children"]:
            out[child["title"]] = child
    return out


async def test_board_shape_order_counts_and_live_facts(db_session):
    hubs, run, p = await _seeded_board(db_session)
    await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with client_for(db_session) as client:
        r = await client.get("/vip-board")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["run_id"] == str(run.id)
    assert [x["key"] for x in body["pillars"]] == [
        "INNOVATION", "MARKET_EXPANSION", "PERFORMANCE",
    ]
    assert body["pillars"][0]["number"] == "01"
    assert body["pillars"][2]["impact"] == ["Savings", "compliance", "reliable delivery"]
    assert [a["area"] for a in body["areas"]] == ["Greece", "India", "Romania"]

    oem, india, romania = body["areas"]
    assert oem["label"] == "Greece"
    assert oem["hubs"] == ["OEM-HCK", "OEM-Seltek", "R&D-Greece"]
    assert india["hubs"] == ["PD-India", "R&D-India"]
    assert romania["hubs"] == ["PD-Romania"]
    # Yellow highlight = VIP: the tile lists the highlighted items in order.
    assert [v["title"] for v in oem["vip_items"]] == [
        "Family Fridge for Commercial Appliances",
        "Super-8 CC Kazakhstan TCCC EC 26 (Coke)",
        "Super-16 for Kazakhstan",
        "IC2-40 Coke Certification",
        "FLEX-290 @ K1 & K2 EEI<20",
        "FLEX-400 B rating K2 & K1 (EEI<20)",
    ]
    assert len(india["vip_items"]) == india["highlighted_count"] == 8
    assert (oem["item_count"], oem["highlighted_count"], oem["high_risk_count"]) == (14, 6, 0)
    assert oem["linked_project_count"] == 2
    assert india["high_risk_count"] == 3
    # Items ordered by pillar, then sort_order; children nested one level.
    assert [i["pillar"] for i in oem["items"]] == sorted(
        (i["pillar"] for i in oem["items"]),
        key=["INNOVATION", "MARKET_EXPANSION", "PERFORMANCE"].index,
    )
    titles = [i["title"] for i in oem["items"] if i["pillar"] == "MARKET_EXPANSION"]
    assert titles[:2] == ["Super-8 CC Kazakhstan TCCC EC 26 (Coke)", "Super-16 for Kazakhstan"]
    monster = next(i for i in oem["items"] if i["title"] == "Monster Range:")
    assert len(monster["children"]) == 3
    assert all(c["children"] == [] for c in monster["children"])

    super8 = _items_by_title(oem)["Super-8 CC Kazakhstan TCCC EC 26 (Coke)"]
    assert super8["highlighted"] is True and super8["sort_order"] == 1
    [proj] = super8["projects"]
    assert proj == {
        "id": str(p["s8"].id), "name": "S8 for Kazakhstan", "hub": "OEM-Seltek",
        "priority": "P1", "status": "In Development", "projected_end_week": 40,
        "within_year": True, "health": "on_track",
    }
    assert super8["hidden_project_count"] == 0
    # No financial fields anywhere in the payload.
    for banned in ("tcogs", "gross_margin", "selling_price", "customer_name"):
        assert f'"{banned}"' not in r.text


async def test_board_hub_scope_hides_areas_and_counts_hidden_projects(db_session):
    hubs, _run, p = await _seeded_board(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hubs[HubName.PD_INDIA].id])
    async with client_for(db_session) as client:
        r = await client.get("/vip-board")
    body = r.json()
    assert [a["area"] for a in body["areas"]] == ["India"]
    [india] = body["areas"]
    bee = _items_by_title(india)["BEE 5-star labelling, report submission by 01st Jan 2027"]
    # The R&D-India project is out of a PD-India planner's scope.
    assert bee["projects"] == [] and bee["hidden_project_count"] == 1
    assert india["linked_project_count"] == 0
    # Items themselves are never hidden.
    assert india["item_count"] == 16


async def test_board_hub_and_region_filters_narrow(db_session):
    hubs, _run, p = await _seeded_board(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        by_region = (await client.get("/vip-board", params={"region": "Romania"})).json()
        by_hub = (
            await client.get("/vip-board", params={"hub_id": str(hubs[HubName.OEM_HCK].id)})
        ).json()
        greece = (await client.get("/vip-board", params={"region": "Greece"})).json()
        bad = await client.get("/vip-board", params={"region": "Mars"})
    assert [a["area"] for a in by_region["areas"]] == ["Romania"]
    shekel = _items_by_title(by_region["areas"][0])["Shekel – 750 (Shekel)"]
    assert [x["name"] for x in shekel["projects"]] == ["Shekel 750"]

    assert [a["area"] for a in by_hub["areas"]] == ["Greece"]
    items = _items_by_title(by_hub["areas"][0])
    # OEM-Seltek's S8 is filtered out (counted hidden); OEM-HCK's Beatbox shown.
    assert items["Super-8 CC Kazakhstan TCCC EC 26 (Coke)"]["hidden_project_count"] == 1
    assert [x["name"] for x in items["Beat Box 3D Logo"]["projects"]] == [
        "BEATBOX 3D LOGO FLEX60"
    ]
    # Region filtering is area == region.
    assert [a["area"] for a in greece["areas"]] == ["Greece"]
    assert bad.status_code == 422


async def test_board_out_of_scope_hub_filter_gives_no_areas(db_session):
    hubs, _run, _p = await _seeded_board(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hubs[HubName.PD_INDIA].id])
    async with client_for(db_session) as client:
        r = await client.get("/vip-board", params={"hub_id": str(hubs[HubName.OEM_HCK].id)})
    assert r.status_code == 200 and r.json()["areas"] == []


async def test_board_read_requires_dashboard_read(db_session):
    await _hubs(db_session)
    await act_as(db_session, RoleName.AUDITOR)
    async with client_for(db_session) as client:
        r = await client.get("/vip-board")
    assert r.status_code == 403


# --- writes -------------------------------------------------------------------------


@pytest.mark.parametrize("role", [RoleName.HUB_PLANNER, RoleName.EXECUTIVE_VIEWER])
async def test_writes_need_matrix_write(db_session, role):
    hubs = await _hubs(db_session)
    item = VipItem(area=VipArea.INDIA, pillar=VipPillar.INNOVATION, title="X")
    db_session.add(item)
    await db_session.flush()
    kw = {"hub_ids": [hubs[HubName.PD_INDIA].id]} if role == RoleName.HUB_PLANNER else {}
    await act_as(db_session, role, **kw)
    async with client_for(db_session) as client:
        responses = [
            await client.post(
                "/vip-items", json={"area": "India", "pillar": "INNOVATION", "title": "Y"}
            ),
            await client.patch(f"/vip-items/{item.id}", json={"title": "Z"}),
            await client.put(f"/vip-items/{item.id}/projects", json={"project_ids": []}),
            await client.delete(f"/vip-items/{item.id}"),
        ]
    assert [r.status_code for r in responses] == [403, 403, 403, 403]


async def test_create_update_delete_with_audit(db_session):
    await _hubs(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.post(
            "/vip-items",
            json={"area": "Romania", "pillar": "PERFORMANCE", "title": "  New item  ",
                  "status_tag": "HIGH_RISK", "status_note": "", "highlighted": True},
        )
        assert r.status_code == 201, r.text
        created = r.json()
        assert created["title"] == "New item" and created["status_note"] is None
        assert created["sort_order"] == 0 and created["project_ids"] == []
        r2 = await client.post(
            "/vip-items",
            json={"area": "Romania", "pillar": "PERFORMANCE", "title": "Child",
                  "parent_id": created["id"]},
        )
        assert r2.status_code == 201
        child = r2.json()
        assert child["parent_id"] == created["id"]

        r = await client.patch(
            f"/vip-items/{created['id']}",
            json={"status_tag": None, "status_note": "late", "sort_order": 5},
        )
        assert r.status_code == 200, r.text
        assert (r.json()["status_tag"], r.json()["status_note"]) == (None, "late")
        # No-op patch: no audit row.
        r = await client.patch(f"/vip-items/{created['id']}", json={"sort_order": 5})
        assert r.status_code == 200
        # Moving the parent to another pillar takes its child with it.
        r = await client.patch(f"/vip-items/{created['id']}", json={"pillar": "INNOVATION"})
        assert r.json()["pillar"] == "INNOVATION"
        moved_child = await db_session.get(VipItem, uuid.UUID(child["id"]))
        await db_session.refresh(moved_child)
        assert moved_child.pillar.value == "INNOVATION"

        r = await client.delete(f"/vip-items/{created['id']}")
        assert r.status_code == 200, r.text
        assert r.json()["deleted_item_count"] == 2
        assert (await client.delete(f"/vip-items/{created['id']}")).status_code == 404

    assert await db_session.scalar(select(func.count()).select_from(VipItem)) == 0
    assert await _vip_count(db_session, "vip_item.create") == 2
    assert await _vip_count(db_session, "vip_item.update") == 2
    assert await _vip_count(db_session, "vip_item.delete") == 1
    row = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "vip_item.delete")
        )
    ).scalar_one()
    assert row.entity_type == "VipItem" and row.after_state is None
    assert [c["title"] for c in row.before_state["children"]] == ["Child"]


async def test_links_never_change_is_vip_and_audit(db_session):
    """ADR 0040: linking, unlinking, deleting and highlighting never set or
    clear `projects.is_vip`; the link writes are still audited."""

    hubs = await _hubs(db_session)
    a = await _project(db_session, hubs[HubName.RD_INDIA], "Alpha")
    b = await _project(db_session, hubs[HubName.PD_INDIA], "Beta", is_vip=True)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        one = (await client.post(
            "/vip-items", json={"area": "India", "pillar": "INNOVATION", "title": "One",
                                "highlighted": True}
        )).json()
        two = (await client.post(
            "/vip-items", json={"area": "India", "pillar": "INNOVATION", "title": "Two"}
        )).json()
        r = await client.put(
            f"/vip-items/{one['id']}/projects",
            json={"project_ids": [str(a.id), str(b.id), str(a.id)]},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert sorted(body["item"]["project_ids"]) == sorted([str(a.id), str(b.id)])
        assert body["pinned_project_ids"] == [] and body["unpinned_project_ids"] == []
        await db_session.refresh(a)
        await db_session.refresh(b)
        assert (a.is_vip, b.is_vip) == (False, True)

        await client.put(f"/vip-items/{two['id']}/projects", json={"project_ids": [str(a.id)]})
        # Highlight toggles on a linked item: no recompute.
        assert (await client.patch(
            f"/vip-items/{two['id']}", json={"highlighted": True}
        )).status_code == 200
        await client.patch(f"/vip-items/{one['id']}", json={"highlighted": False})
        await db_session.refresh(a)
        await db_session.refresh(b)
        assert (a.is_vip, b.is_vip) == (False, True)

        # Unlink both from "one": the manual pin on Beta stays.
        r = await client.put(f"/vip-items/{one['id']}/projects", json={"project_ids": []})
        assert r.json()["removed_project_ids"] == sorted([str(a.id), str(b.id)])
        assert r.json()["unpinned_project_ids"] == []

        # Same set again: nothing written.
        before = await _vip_count(db_session, "vip_item.link")
        r = await client.put(f"/vip-items/{two['id']}/projects", json={"project_ids": [str(a.id)]})
        assert r.json()["added_project_ids"] == []
        assert await _vip_count(db_session, "vip_item.link") == before

        r = await client.delete(f"/vip-items/{two['id']}")
        assert r.json()["unpinned_project_ids"] == []
        r = await client.delete(f"/vip-items/{one['id']}")
        assert r.json()["unpinned_project_ids"] == []
    await db_session.refresh(a)
    await db_session.refresh(b)
    assert (a.is_vip, b.is_vip) == (False, True)
    assert await _vip_count(db_session, "vip_item.link") == 2
    assert await _vip_count(db_session, "vip_item.unlink") == 1
    assert await _vip_count(db_session, "project.vip_pin") == 0
    assert await _vip_count(db_session, "project.vip_unpin") == 0


async def test_highlighted_board_still_lists_vip_items(db_session):
    """The board still lists highlighted items (`vip_items`); a highlight
    no longer makes linked projects VIP (ADR 0040)."""

    hubs = await _hubs(db_session)
    a = await _project(db_session, hubs[HubName.PD_ROMANIA], "Alpha")
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        plain = (await client.post(
            "/vip-items", json={"area": "Romania", "pillar": "PERFORMANCE", "title": "Plain"}
        )).json()
        await client.put(f"/vip-items/{plain['id']}/projects", json={"project_ids": [str(a.id)]})
        r = await client.patch(f"/vip-items/{plain['id']}", json={"highlighted": True})
        assert r.status_code == 200, r.text
        await db_session.refresh(a)
        assert a.is_vip is False

        board = (await client.get("/vip-board", params={"region": "Romania"})).json()
        [romania] = board["areas"]
        assert romania["vip_items"] == [{"id": plain["id"], "title": "Plain"}]
    assert await _vip_count(db_session, "project.vip_pin") == 0
    assert await _vip_count(db_session, "vip_item.update") == 1


async def test_link_area_mismatch_and_unknown_project_422(db_session):
    hubs = await _hubs(db_session)
    oem = await _project(db_session, hubs[HubName.OEM_HCK], "OEM thing")
    india = await _project(db_session, hubs[HubName.RD_INDIA], "India thing")
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        item = (await client.post(
            "/vip-items", json={"area": "Romania", "pillar": "INNOVATION", "title": "Eu"}
        )).json()
        r = await client.put(
            f"/vip-items/{item['id']}/projects", json={"project_ids": [str(oem.id)]}
        )
        assert r.status_code == 422 and r.json()["code"] == "VIP_PROJECT_AREA_MISMATCH"
        r = await client.put(
            f"/vip-items/{item['id']}/projects", json={"project_ids": [str(uuid.uuid4())]}
        )
        assert r.status_code == 422 and r.json()["code"] == "VIP_PROJECT_NOT_FOUND"

        # Changing an item's area is refused while its links would not fit.
        ind = (await client.post(
            "/vip-items", json={"area": "India", "pillar": "INNOVATION", "title": "In"}
        )).json()
        await client.put(f"/vip-items/{ind['id']}/projects", json={"project_ids": [str(india.id)]})
        r = await client.patch(f"/vip-items/{ind['id']}", json={"area": "Greece"})
        assert r.status_code == 422 and r.json()["code"] == "VIP_PROJECT_AREA_MISMATCH"
    assert await db_session.scalar(
        select(func.count()).select_from(vip_item_projects)
    ) == 1


async def test_scoped_writer_keeps_out_of_scope_links(db_session):
    hubs = await _hubs(db_session)
    pd = await _project(db_session, hubs[HubName.PD_INDIA], "PD one")
    rd = await _project(db_session, hubs[HubName.RD_INDIA], "RD one")
    item = VipItem(area=VipArea.INDIA, pillar=VipPillar.INNOVATION, title="Shared")
    db_session.add(item)
    await db_session.flush()
    await db_session.execute(
        vip_item_projects.insert(),
        [{"item_id": item.id, "project_id": pd.id}, {"item_id": item.id, "project_id": rd.id}],
    )
    await act_as(
        db_session, RoleName.PORTFOLIO_MANAGER, hub_ids=[hubs[HubName.PD_INDIA].id]
    )
    async with client_for(db_session) as client:
        r = await client.put(f"/vip-items/{item.id}/projects", json={"project_ids": []})
        assert r.status_code == 200, r.text
        assert r.json()["removed_project_ids"] == [str(pd.id)]
        # The kept out-of-scope link is not disclosed (P14-R01 S2) but stays.
        assert r.json()["item"]["project_ids"] == []
        kept = await db_session.execute(
            vip_item_projects.select().where(vip_item_projects.c.item_id == item.id)
        )
        assert [row.project_id for row in kept.all()] == [rd.id]
        # Out-of-scope project: indistinguishable from an unknown one.
        r = await client.put(
            f"/vip-items/{item.id}/projects", json={"project_ids": [str(rd.id)]}
        )
        assert r.json()["code"] == "VIP_PROJECT_NOT_FOUND"
        # An area with none of the caller's hubs: 403 on create, 404 on items.
        r = await client.post(
            "/vip-items", json={"area": "Greece", "pillar": "INNOVATION", "title": "No"}
        )
        assert r.status_code == 403
        oem_item = VipItem(area=VipArea.GREECE, pillar=VipPillar.INNOVATION, title="Theirs")
        db_session.add(oem_item)
        await db_session.flush()
        assert (await client.delete(f"/vip-items/{oem_item.id}")).status_code == 404


async def test_writer_responses_hide_out_of_scope_project_ids(db_session):
    """P14-R01 S2: responses return only in-scope ids. ADR 0040: no write
    touches is_vip on any linked project, visible or not."""

    hubs = await _hubs(db_session)
    pd = await _project(db_session, hubs[HubName.PD_INDIA], "PD two")
    rd = await _project(db_session, hubs[HubName.RD_INDIA], "RD two")
    item = VipItem(
        area=VipArea.INDIA, pillar=VipPillar.INNOVATION, title="Shared 2", highlighted=False
    )
    db_session.add(item)
    await db_session.flush()
    await db_session.execute(
        vip_item_projects.insert(),
        [{"item_id": item.id, "project_id": pd.id}, {"item_id": item.id, "project_id": rd.id}],
    )
    await act_as(
        db_session, RoleName.PORTFOLIO_MANAGER, hub_ids=[hubs[HubName.PD_INDIA].id]
    )
    async with client_for(db_session) as client:
        r = await client.patch(f"/vip-items/{item.id}", json={"highlighted": True})
        assert r.status_code == 200, r.text
        assert r.json()["project_ids"] == [str(pd.id)]
        await db_session.refresh(rd)
        await db_session.refresh(pd)
        assert rd.is_vip is False and pd.is_vip is False
        r = await client.delete(f"/vip-items/{item.id}")
        assert r.status_code == 200, r.text
        assert r.json()["unpinned_project_ids"] == []
        await db_session.refresh(rd)
        assert rd.is_vip is False


async def test_parent_rules_422(db_session):
    await _hubs(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        top = (await client.post(
            "/vip-items", json={"area": "Greece", "pillar": "INNOVATION", "title": "Top"}
        )).json()
        child = (await client.post(
            "/vip-items",
            json={"area": "Greece", "pillar": "INNOVATION", "title": "C", "parent_id": top["id"]},
        )).json()
        cases = [
            {"area": "Greece", "pillar": "INNOVATION", "title": "G", "parent_id": child["id"]},
            {"area": "Greece", "pillar": "PERFORMANCE", "title": "P", "parent_id": top["id"]},
            {"area": "Greece", "pillar": "INNOVATION", "title": "U",
             "parent_id": str(uuid.uuid4())},
        ]
        for body in cases:
            r = await client.post("/vip-items", json=body)
            assert r.status_code == 422 and r.json()["code"] == "VIP_PARENT_INVALID", body
        r = await client.patch(f"/vip-items/{top['id']}", json={"parent_id": top["id"]})
        assert r.json()["code"] == "VIP_PARENT_INVALID"
        other = (await client.post(
            "/vip-items", json={"area": "Greece", "pillar": "INNOVATION", "title": "Other"}
        )).json()
        # An item with children cannot become a child.
        r = await client.patch(f"/vip-items/{top['id']}", json={"parent_id": other["id"]})
        assert r.json()["code"] == "VIP_PARENT_INVALID"


@pytest.mark.parametrize(
    "body",
    [
        {"area": "Asia", "pillar": "INNOVATION", "title": "x"},
        {"area": "Greece", "pillar": "GROWTH", "title": "x"},
        {"area": "Greece", "pillar": "INNOVATION", "title": "x", "status_tag": "LATE"},
        {"area": "Greece", "pillar": "INNOVATION", "title": "   "},
        {"area": "Greece", "pillar": "INNOVATION", "title": "x" * 201},
        {"area": "Greece", "pillar": "INNOVATION", "title": "x", "status_note": "n" * 201},
        {"area": "Greece", "pillar": "INNOVATION", "title": "x", "sort_order": -1},
        {"area": "Greece", "pillar": "INNOVATION", "title": "x", "extra": 1},
        {"area": "Greece", "pillar": "INNOVATION"},
    ],
)
async def test_create_rejects_bad_input_422(db_session, body):
    await _hubs(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.post("/vip-items", json=body)
    assert r.status_code == 422, r.text


async def test_patch_rejects_null_required_and_bad_enum(db_session):
    await _hubs(db_session)
    item = VipItem(area=VipArea.GREECE, pillar=VipPillar.INNOVATION, title="T")
    db_session.add(item)
    await db_session.flush()
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        for body in ({"title": None}, {"area": None}, {"status_tag": "NOPE"},
                     {"highlighted": "yes"}):
            r = await client.patch(f"/vip-items/{item.id}", json=body)
            assert r.status_code == 422, body
        r = await client.put(f"/vip-items/{item.id}/projects", json={"project_ids": ["nope"]})
        assert r.status_code == 422
    assert await _vip_count(db_session, "vip_item.update") == 0
