"""P60-B (ADR 0068): hub rank inside a priority band.

Covered:
- `hub_rank` / `hub_band_size` served next to `band_rank` / `band_size` on
  `GET /projects`, `GET /projects/{id}`, the Workspace, `GET /dashboard/projects`
  and the Priority board cards: the position among the same hub's band
  members in `band_rank` order, and that count; null when unranked;
- a Hub Planner sees the same hub rank (not renumbered by scope);
- `POST /projects/{id}/band-rank[/preview]` with `hub_rank`: hub rank 1 moves
  the project just before its hub's first peer, other hubs' relative order is
  unchanged, the global rank is renumbered (dense); past the end lands after
  the hub's last peer; alone in its hub keeps its place; the response carries
  the new `band_rank` / `hub_rank`; the preview's token and diff equal the
  apply's; the audit row logs `requested_hub_rank`;
- errors: `to_rank` with `hub_rank` 422 `RANK_AND_HUB_RANK`, with an anchor
  422 `ANCHOR_AND_RANK`, below 1 422 `BAD_RANK`, a non-integer 422.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

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
from scheduling import band_rank as br
from services.project_steps import sync_project_steps
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_project
from tests.test_p36_band_rank_api import (
    _act_as,
    _activate_baseline,
    _assert_i37b,
    _client,
    _fresh,
    _order,
)


@pytest.fixture(autouse=True)
def _cleanup(monkeypatch):
    monkeypatch.setattr(priority_preview, "publish_progress", lambda *a, **k: None)
    projects_router.PRIORITY_PREVIEW_RATE_LIMIT.reset()
    projects_router.PRIORITY_CONFIRM_RATE_LIMIT.reset()
    yield
    projects_router.PRIORITY_PREVIEW_RATE_LIMIT.reset()
    projects_router.PRIORITY_CONFIRM_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _world(db_session, *, baseline: bool = False) -> SimpleNamespace:
    """P2 in global order A1, B1, A2, B2, A3 (hubs A = R&D-Greece, B =
    PD-India), one shared leader so the order moves dates; a lone P1 project
    in hub B; an On Hold P2 project (unranked) in hub A."""

    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    leader = await make_engineer(
        db_session, hub_a, name="Shared Leader", allowed_categories=[EngineerAllowedCategory.C]
    )

    async def project(name: str, prio: ProjectPriority, hub: Any, **kw: Any) -> Project:
        p = await make_project(
            db_session,
            hub,
            leader=leader,
            name=name,
            category=ProjectCategory.C,
            priority=prio,
            status=kw.pop("status", ProjectStatus.IN_QUEUE),
            schedule_stale=False,
            certification_testing_required=False,
            **kw,
        )
        await sync_project_steps(db_session, p, False)
        return p

    named = {
        "A1": await project("A1", ProjectPriority.P2, hub_a),
        "B1": await project("B1", ProjectPriority.P2, hub_b),
        "A2": await project("A2", ProjectPriority.P2, hub_a),
        "B2": await project("B2", ProjectPriority.P2, hub_b),
        "A3": await project("A3", ProjectPriority.P2, hub_a),
    }
    lone = await project("Lone", ProjectPriority.P1, hub_b)
    held = await project("Held", ProjectPriority.P2, hub_a, status=ProjectStatus.ON_HOLD)
    await db_session.flush()
    # The unique (priority, band_rank) constraint is deferred: set the order.
    for rank, key in enumerate(("A1", "B1", "A2", "B2", "A3"), start=1):
        named[key].band_rank = rank
    await db_session.flush()
    assert held.band_rank is None
    if baseline:
        await _activate_baseline(db_session)
    return SimpleNamespace(hub_a=hub_a, hub_b=hub_b, p=named, lone=lone, held=held)


#: name -> (band_rank, band_size, hub_rank, hub_band_size) for the world above.
EXPECTED: dict[str, tuple[int | None, int | None, int | None, int | None]] = {
    "A1": (1, 5, 1, 3),
    "B1": (2, 5, 1, 2),
    "A2": (3, 5, 2, 3),
    "B2": (4, 5, 2, 2),
    "A3": (5, 5, 3, 3),
    "Lone": (1, 1, 1, 1),
    "Held": (None, None, None, None),
}


def _quad(row: dict[str, Any]) -> tuple[Any, Any, Any, Any]:
    return row["band_rank"], row["band_size"], row["hub_rank"], row["hub_band_size"]


async def _names_in_order(db_session, w: SimpleNamespace) -> list[str]:
    by_id = {str(p.id): name for name, p in w.p.items()}
    return [by_id[pid] for pid in await _order(db_session, "P2")]


async def _hub_move(client, project_id, hub_rank: int) -> tuple[Any, Any]:
    preview = await client.post(
        f"/projects/{project_id}/band-rank/preview", json={"hub_rank": hub_rank}
    )
    assert preview.status_code == 200, preview.text
    confirm = await client.post(
        f"/projects/{project_id}/band-rank",
        json={"hub_rank": hub_rank, "preview_token": preview.json()["preview_token"] or "x" * 64},
    )
    assert confirm.status_code == 200, confirm.text
    return preview, confirm


# --- served ----------------------------------------------------------------------------------


async def test_hub_rank_served_everywhere_across_two_hubs(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        listed = (await client.get("/projects")).json()
        register = (await client.get("/dashboard/projects")).json()["rows"]
        board = (await client.get("/priority-board")).json()
        detail = (await client.get(f"/projects/{w.p['A2'].id}")).json()
        workspace = (await client.get(f"/projects/{w.p['B2'].id}/workspace")).json()

    assert {r["name"]: _quad(r) for r in listed} == EXPECTED
    assert {r["project_name"]: _quad(r) for r in register} == EXPECTED
    cards = {c["name"]: c for col in board["columns"] for c in col["cards"]}
    for name, (rank, _, hub_rank, hub_size) in EXPECTED.items():
        if name in cards:
            card = cards[name]
            assert (card["band_rank"], card["hub_rank"], card["hub_band_size"]) == (
                rank, hub_rank, hub_size,
            )  # fmt: skip
    assert _quad(detail) == EXPECTED["A2"]
    assert _quad(workspace["project"]) == EXPECTED["B2"]


async def test_hub_planner_sees_the_same_hub_rank(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub_b.id])
    async with _client(db_session) as client:
        listed = (await client.get("/projects")).json()
        register = (await client.get("/dashboard/projects")).json()["rows"]
        board = (await client.get("/priority-board")).json()
        detail = (await client.get(f"/projects/{w.p['B2'].id}")).json()

    in_b = {"B1", "B2", "Lone"}
    assert {r["name"]: _quad(r) for r in listed} == {k: EXPECTED[k] for k in in_b}
    assert {r["project_name"]: _quad(r) for r in register} == {k: EXPECTED[k] for k in in_b}
    cards = {c["name"]: c for col in board["columns"] for c in col["cards"]}
    assert set(cards) == in_b
    assert {n: (c["hub_rank"], c["hub_band_size"]) for n, c in cards.items()} == {
        n: EXPECTED[n][2:] for n in in_b
    }
    assert _quad(detail) == EXPECTED["B2"]


# --- editing by hub rank ---------------------------------------------------------------------


async def test_hub_rank_1_moves_before_the_hubs_first_peer(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    before = await _names_in_order(db_session, w)
    async with _client(db_session) as client:
        preview, confirm = await _hub_move(client, w.p["A3"].id, 1)
        listed = {r["name"]: r for r in (await client.get("/projects")).json()}

    assert preview.json()["result"] == "preview"
    body = confirm.json()
    assert body["recalc_status"] == "applied"
    assert (body["band_rank"], body["hub_rank"]) == (1, 1)
    after = await _names_in_order(db_session, w)
    assert after == ["A3", "A1", "B1", "A2", "B2"]
    # Other hubs' relative order is unchanged; only A3 moved (I37c).
    assert [n for n in after if n.startswith("B")] == [n for n in before if n.startswith("B")]
    assert br.remove(after, "A3") == br.remove(before, "A3")
    # Global renumbered dense; hub ranks follow.
    assert [(await _fresh(db_session, w.p[n].id)).band_rank for n in after] == [1, 2, 3, 4, 5]
    await _assert_i37b(db_session)
    assert {n: (listed[n]["band_rank"], listed[n]["hub_rank"]) for n in after} == {
        "A3": (1, 1), "A1": (2, 2), "B1": (3, 1), "A2": (4, 3), "B2": (5, 2),
    }  # fmt: skip

    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "project.band_rank_move",
                AuditLogEntry.entity_id == str(w.p["A3"].id),
            )
        )
    ).scalar_one()
    assert audit.after_state["requested_hub_rank"] == 1
    assert audit.after_state["from_rank"] == 5 and audit.after_state["to_rank"] == 1
    assert "requested_rank" not in audit.after_state


async def test_hub_rank_past_the_end_lands_after_the_hubs_last_peer(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        _, confirm = await _hub_move(client, w.p["B1"].id, 99)
    assert (confirm.json()["band_rank"], confirm.json()["hub_rank"]) == (4, 2)
    assert await _names_in_order(db_session, w) == ["A1", "A2", "B2", "B1", "A3"]
    await _assert_i37b(db_session)


async def test_hub_rank_middle_and_current_is_unchanged(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        same = await client.post(
            f"/projects/{w.p['A2'].id}/band-rank/preview", json={"hub_rank": 2}
        )
        last = await client.post(
            f"/projects/{w.p['A3'].id}/band-rank/preview", json={"hub_rank": 9}
        )
        _, confirm = await _hub_move(client, w.p["A1"].id, 2)
    # Its own hub rank (or past the end when already last) keeps the place.
    assert same.json()["result"] == "unchanged"
    assert last.json()["result"] == "unchanged"
    # A1 to hub rank 2: just before A3 (hub peers without A1: A2, A3).
    assert await _names_in_order(db_session, w) == ["B1", "A2", "B2", "A1", "A3"]
    assert (confirm.json()["band_rank"], confirm.json()["hub_rank"]) == (4, 2)


async def test_alone_in_its_hub_keeps_its_place(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        preview = await client.post(
            f"/projects/{w.lone.id}/band-rank/preview", json={"hub_rank": 3}
        )
        confirm = await client.post(
            f"/projects/{w.lone.id}/band-rank", json={"hub_rank": 3, "preview_token": "x" * 64}
        )
    assert preview.json()["result"] == "unchanged"
    assert confirm.status_code == 200, confirm.text
    assert confirm.json()["recalc_status"] == "unchanged"
    assert (confirm.json()["band_rank"], confirm.json()["hub_rank"]) == (1, 1)


async def test_hub_rank_preview_equals_apply(db_session):
    w = await _world(db_session, baseline=True)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        preview, confirm = await _hub_move(client, w.p["A3"].id, 1)
    p, c = preview.json(), confirm.json()
    assert c["recalc_status"] == "applied"
    assert p["summary"] == c["summary"]
    assert p["moved"] == c["moved"]
    assert [x["project_id"] for x in p["changes"]] == [x["project_id"] for x in c["changes"]]
    assert p["summary"]["affected"] > 0  # the shared leader: the order moves dates


async def test_hub_rank_token_differs_from_the_same_placement_by_to_rank(db_session):
    """The token binds the requested hub rank: a hub-rank preview's token does
    not confirm a `to_rank` request (and vice versa)."""

    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    pid = w.p["A3"].id
    async with _client(db_session) as client:
        preview = await client.post(f"/projects/{pid}/band-rank/preview", json={"hub_rank": 1})
        crossed = await client.post(
            f"/projects/{pid}/band-rank",
            json={"to_rank": 1, "preview_token": preview.json()["preview_token"]},
        )
    assert crossed.status_code == 409 and crossed.json()["code"] == "PREVIEW_STALE"
    assert (await _fresh(db_session, pid)).band_rank == 5


async def test_hub_rank_errors(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    pid = w.p["A2"].id
    url = f"/projects/{pid}/band-rank/preview"
    async with _client(db_session) as client:
        both = await client.post(url, json={"hub_rank": 1, "to_rank": 1})
        anchor = await client.post(
            url, json={"hub_rank": 1, "before_project_id": str(w.p["A1"].id)}
        )
        zero = await client.post(url, json={"hub_rank": 0})
        as_string = await client.post(url, json={"hub_rank": "1"})
        held = await client.post(f"/projects/{w.held.id}/band-rank/preview", json={"hub_rank": 1})
        confirm_both = await client.post(
            f"/projects/{pid}/band-rank",
            json={"hub_rank": 1, "to_rank": 1, "preview_token": "x" * 64},
        )
    assert (both.status_code, both.json()["code"]) == (422, "RANK_AND_HUB_RANK")
    assert (anchor.status_code, anchor.json()["code"]) == (422, "ANCHOR_AND_RANK")
    assert (zero.status_code, zero.json()["code"]) == (422, "BAD_RANK")
    assert as_string.status_code == 422
    assert (held.status_code, held.json()["code"]) == (409, "NOT_RANKABLE")
    assert (confirm_both.status_code, confirm_both.json()["code"]) == (422, "RANK_AND_HUB_RANK")
    assert await _names_in_order(db_session, w) == ["A1", "B1", "A2", "B2", "A3"]


async def test_hub_planner_moves_by_hub_rank_past_a_hidden_project(db_session):
    """A Hub Planner of hub B moves B2 to hub rank 1: it lands just before B1,
    i.e. past A2 (hub A, not visible to them); nothing of hub A is named."""

    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub_b.id])
    async with _client(db_session) as client:
        preview, confirm = await _hub_move(client, w.p["B2"].id, 1)
    assert (confirm.json()["band_rank"], confirm.json()["hub_rank"]) == (2, 1)
    assert await _names_in_order(db_session, w) == ["A1", "B2", "B1", "A2", "A3"]
    for hidden in ("A1", "A2", "A3"):
        assert str(w.p[hidden].id) not in preview.text
        assert str(w.p[hidden].id) not in confirm.text
