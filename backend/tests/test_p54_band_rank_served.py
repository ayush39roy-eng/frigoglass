"""P54-T02 (ADR 0064 R1): the read-only `band_rank` / `band_size` served on the
project read (`GET /projects/{id}`, and so the registration form), the
Projects register rows (`GET /projects`), the write responses and the
Workspace project.

Covered:
- the served `band_rank` equals the Priority board card's, and `band_size`
  equals the full band's member count (the board column count for an
  all-hubs caller, the `n` of the dense 1..n numbering);
- a project with no rank (not a band member: On Hold, or no priority) gets
  `band_rank` and `band_size` null;
- hub scope still applies to the rows; a scoped caller's `band_size` is the
  FULL band (it pairs with the full-band `band_rank`, W36-1 / API_CONTRACT_P36
  §6), not a scoped count;
- `band_size` is one grouped count per request, not per row;
- `band_rank` / `band_size` are rejected on create, PATCH and register edits
  (422, `extra="forbid"`), and nothing is written.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, func, select

import api.routers.projects as projects_router
import services.priority_preview as priority_preview
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
)
from models.project import Project
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_engineer,
    make_hub,
    make_project,
    make_user,
    registration_body,
)


@pytest.fixture(autouse=True)
def _cleanup(monkeypatch):
    monkeypatch.setattr(priority_preview, "publish_progress", lambda *a, **k: None)
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    yield
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles: RoleName, hub_ids=None):
    scope_all = hub_ids is None
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=scope_all)
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=scope_all,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def _world(db_session) -> SimpleNamespace:
    """Two hubs. P1: 2 members (one per hub). P2: 4 members, the second in
    hub B. Unranked: an On Hold P2 project and a no-priority project (both
    hub A)."""

    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    leader_a = await make_engineer(
        db_session, hub_a, name="Leader A", allowed_categories=[EngineerAllowedCategory.C]
    )
    leader_b = await make_engineer(
        db_session, hub_b, name="Leader B", allowed_categories=[EngineerAllowedCategory.C]
    )

    async def project(name: str, prio: ProjectPriority | None, hub=hub_a, **kw: Any) -> Project:
        return await make_project(
            db_session,
            hub,
            leader=leader_a if hub is hub_a else leader_b,
            name=name,
            category=ProjectCategory.C,
            priority=prio,
            status=kw.pop("status", ProjectStatus.IN_QUEUE),
            certification_testing_required=False,
            **kw,
        )

    p1 = [
        await project("P1 A", ProjectPriority.P1),
        await project("P1 B", ProjectPriority.P1, hub=hub_b),
    ]
    p2 = [
        await project(f"P2 {i}", ProjectPriority.P2, hub=hub_b if i == 1 else hub_a)
        for i in range(4)
    ]
    on_hold = await project("Held", ProjectPriority.P2, status=ProjectStatus.ON_HOLD)
    no_priority = await project("No priority", None)
    await db_session.flush()
    assert on_hold.band_rank is None and no_priority.band_rank is None
    return SimpleNamespace(
        hub_a=hub_a,
        hub_b=hub_b,
        leader_a=leader_a,
        p1=p1,
        p2=p2,
        on_hold=on_hold,
        no_priority=no_priority,
    )


def _board_cards(board: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["project_id"]: c for col in board["columns"] for c in col["cards"]}


async def test_served_rank_and_size_match_the_priority_board(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        board = (await client.get("/priority-board")).json()
        rows = await client.get("/projects", params={"limit": 500})
        assert rows.status_code == 200, rows.text
        details = {
            str(p.id): (await client.get(f"/projects/{p.id}")).json() for p in [*w.p1, *w.p2]
        }

    counts = {col["priority"]: col["count"] for col in board["columns"]}
    cards = _board_cards(board)
    by_id = {r["id"]: r for r in rows.json()}
    assert counts["P1"] == 2 and counts["P2"] == 4
    for pid, card in cards.items():
        for served in (by_id[pid], details[pid]):
            assert served["band_rank"] == card["band_rank"] is not None
            assert served["band_size"] == counts[served["priority"]]
            assert 1 <= served["band_rank"] <= served["band_size"]
    # Sorting the register by priority then rank gives the board's order.
    for col in board["columns"]:
        ranked = sorted(
            (r for r in by_id.values() if r["priority"] == col["priority"] and r["band_rank"]),
            key=lambda r: r["band_rank"],
        )
        assert [r["id"] for r in ranked] == [c["project_id"] for c in col["cards"]]


async def test_project_with_no_rank_gets_nulls(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        rows = {r["id"]: r for r in (await client.get("/projects")).json()}
        held = (await client.get(f"/projects/{w.on_hold.id}")).json()
        workspace = await client.get(f"/projects/{w.no_priority.id}/workspace")
    for served in (rows[str(w.on_hold.id)], rows[str(w.no_priority.id)], held):
        assert served["band_rank"] is None
        assert served["band_size"] is None
    assert workspace.status_code == 200, workspace.text
    assert workspace.json()["project"]["band_rank"] is None
    assert workspace.json()["project"]["band_size"] is None


async def test_workspace_serves_the_same_rank_and_size(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    target = w.p2[2]
    async with _client(db_session) as client:
        detail = (await client.get(f"/projects/{target.id}")).json()
        workspace = await client.get(f"/projects/{target.id}/workspace")
    assert workspace.status_code == 200, workspace.text
    project = workspace.json()["project"]
    assert (project["band_rank"], project["band_size"]) == (detail["band_rank"], 4)


async def test_hub_scope_still_applies_and_size_is_the_full_band(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub_a.id])
    async with _client(db_session) as client:
        rows = (await client.get("/projects")).json()
        board = (await client.get("/priority-board")).json()
        out_of_scope = await client.get(f"/projects/{w.p2[1].id}")
        in_scope = (await client.get(f"/projects/{w.p2[3].id}")).json()

    assert {r["hub_id"] for r in rows} == {str(w.hub_a.id)}
    assert str(w.p2[1].id) not in {r["id"] for r in rows}
    assert out_of_scope.status_code in (403, 404)
    cards = _board_cards(board)
    for row in rows:
        if row["band_rank"] is None:
            continue
        # Same full-band numbering as the (scoped) board's cards ...
        assert row["band_rank"] == cards[row["id"]]["band_rank"]
        # ... and the full band's size, not the scoped column count.
        assert row["band_size"] == {"P1": 2, "P2": 4}[row["priority"]]
    p2_column = next(c for c in board["columns"] if c["priority"] == "P2")
    assert p2_column["count"] == 3  # scoped: hub B's member is not shown
    assert in_scope["band_size"] == 4
    assert in_scope["band_rank"] == cards[str(w.p2[3].id)]["band_rank"]


async def test_band_size_is_one_grouped_count_per_request(db_session):
    await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    statements: list[str] = []

    def _record(conn, cursor, statement, *args):
        if "count(" in statement.lower() and "band_rank" in statement.lower():
            statements.append(statement)

    sync_engine = db_session.bind.sync_engine
    event.listen(sync_engine, "before_cursor_execute", _record)
    try:
        async with _client(db_session) as client:
            resp = await client.get("/projects")
    finally:
        event.remove(sync_engine, "before_cursor_execute", _record)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()) == 8
    assert len(statements) == 1, statements
    # P60 (ADR 0068): the one query is windowed (band sizes and hub ranks).
    assert "partition by" in statements[0].lower()


async def test_write_responses_serve_band_rank_and_size(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    body = registration_body(w.hub_a, w.leader_a, priority="P2", category="C")
    async with _client(db_session) as client:
        created = await client.post("/projects", json=body)
        patched = await client.patch(f"/projects/{w.p2[0].id}", json={"comments": "note"})
    assert created.status_code == 201, created.text
    # Registration enters the band last (ADR 0050 §5).
    assert (created.json()["band_rank"], created.json()["band_size"]) == (5, 5)
    assert patched.status_code == 200, patched.text
    assert (patched.json()["band_rank"], patched.json()["band_size"]) == (
        w.p2[0].band_rank,
        5,
    )


@pytest.mark.parametrize("field", ["band_rank", "band_size"])
async def test_create_rejects_band_fields(db_session, field):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    before = await _count_projects(db_session)
    body = registration_body(w.hub_a, w.leader_a, priority="P2", category="C", **{field: 1})
    async with _client(db_session) as client:
        resp = await client.post("/projects", json=body)
    assert resp.status_code == 422, resp.text
    assert await _count_projects(db_session) == before
    assert await _audit_count(db_session) == 0


@pytest.mark.parametrize("field", ["band_rank", "band_size"])
async def test_patch_rejects_band_fields(db_session, field):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    target = w.p2[3]
    rank_before = target.band_rank
    async with _client(db_session) as client:
        alone = await client.patch(f"/projects/{target.id}", json={field: 1})
        mixed = await client.patch(f"/projects/{target.id}", json={"comments": "x", field: 1})
    assert alone.status_code == 422, alone.text
    assert mixed.status_code == 422, mixed.text
    fresh = await _fresh(db_session, target.id)
    assert fresh.band_rank == rank_before and fresh.comments != "x"
    assert await _audit_count(db_session) == 0


@pytest.mark.parametrize("field", ["band_rank", "band_size"])
async def test_register_edits_reject_band_fields(db_session, field):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    target = w.p2[3]
    rank_before = target.band_rank
    edit = {"project_id": str(target.id), "status": "In Development", field: 1}
    async with _client(db_session) as client:
        resp = await client.post("/projects/register-edits", json={"edits": [edit]})
    assert resp.status_code == 422, resp.text
    fresh = await _fresh(db_session, target.id)
    assert fresh.band_rank == rank_before and fresh.status == ProjectStatus.IN_QUEUE
    assert await _audit_count(db_session) == 0


async def _fresh(db_session, project_id: uuid.UUID) -> Project:
    return (
        await db_session.execute(
            select(Project)
            .where(Project.id == project_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _count_projects(db_session) -> int:
    return (await db_session.execute(select(func.count()).select_from(Project))).scalar_one()


async def _audit_count(db_session) -> int:
    return (await db_session.execute(select(func.count()).select_from(AuditLogEntry))).scalar_one()


# --- The Projects register rows (`GET /dashboard/projects`, `ProjectFilterRow`) ---------


async def test_register_rows_match_the_priority_board(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        board = (await client.get("/priority-board")).json()
        resp = await client.get("/dashboard/projects")
    assert resp.status_code == 200, resp.text
    rows = {r["project_id"]: r for r in resp.json()["rows"]}
    counts = {col["priority"]: col["count"] for col in board["columns"]}
    cards = _board_cards(board)
    assert set(cards) <= set(rows)
    for pid, card in cards.items():
        assert rows[pid]["band_rank"] == card["band_rank"] is not None
        assert rows[pid]["band_size"] == counts[rows[pid]["priority"]]
    for unranked in (w.on_hold, w.no_priority):
        row = rows[str(unranked.id)]
        assert row["band_rank"] is None and row["band_size"] is None
    # Sorting by priority then rank gives the board's order.
    for col in board["columns"]:
        ranked = sorted(
            (r for r in rows.values() if r["priority"] == col["priority"] and r["band_rank"]),
            key=lambda r: r["band_rank"],
        )
        assert [r["project_id"] for r in ranked] == [c["project_id"] for c in col["cards"]]


async def test_register_rows_hub_scoped_with_full_band_size(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub_a.id])
    async with _client(db_session) as client:
        board = (await client.get("/priority-board")).json()
        resp = await client.get("/dashboard/projects")
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert str(w.p2[1].id) not in {r["project_id"] for r in rows}
    cards = _board_cards(board)
    ranked = [r for r in rows if r["band_rank"] is not None]
    assert ranked
    for row in ranked:
        assert row["band_rank"] == cards[row["project_id"]]["band_rank"]
        assert row["band_size"] == {"P1": 2, "P2": 4}[row["priority"]]


async def test_register_rows_band_size_is_one_grouped_count(db_session):
    await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    statements: list[str] = []

    def _record(conn, cursor, statement, *args):
        lowered = statement.lower()
        if "count(" in lowered and "band_rank is not null" in lowered:
            statements.append(statement)

    sync_engine = db_session.bind.sync_engine
    event.listen(sync_engine, "before_cursor_execute", _record)
    try:
        async with _client(db_session) as client:
            resp = await client.get("/dashboard/projects")
    finally:
        event.remove(sync_engine, "before_cursor_execute", _record)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["rows"]) == 8
    assert len(statements) == 1, statements
    # P60 (ADR 0068): the one query is windowed (band sizes and hub ranks).
    assert "partition by" in statements[0].lower()
