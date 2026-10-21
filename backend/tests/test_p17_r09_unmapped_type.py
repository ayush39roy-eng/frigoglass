"""P17-R09: `GET /dashboard/projects?type=Unmapped` lists the projects with NO
type (`Project.type IS NULL`), the Dashboard Hub x Type drill-down's untyped
("—") column. "Unmapped" is the same sentinel as the `/analytics` `by_type`
bucket key, so the two must agree for every scope and filter.

Expectations are derived from the projects table directly (a Python loop),
not from the endpoint code.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from models.enums import ProjectType, RoleName
from models.hub import Hub
from models.project import Project
from tests.test_p13_region_filter import (
    _act_as,
    _cleanup,  # noqa: F401  (autouse fixture)
    _client,
    _get,
    _seeded,
)


async def _untype_some(db_session) -> list[Project]:
    """Null the type of every third project so each hub has some untyped and
    some typed projects, and return every project."""

    projects = list((await db_session.execute(select(Project).order_by(Project.id))).scalars())
    for i, p in enumerate(projects):
        if i % 3 == 0:
            p.type = None
    await db_session.flush()
    assert any(p.type is None for p in projects)
    assert any(p.type is not None for p in projects)
    return projects


def _unmapped_bucket(analytics: dict) -> int:
    return next((b["count"] for b in analytics["by_type"] if b["key"] == "Unmapped"), 0)


def _ids(body: dict) -> set[str]:
    return {r["project_id"] for r in body["rows"]}


async def test_unmapped_lists_exactly_the_null_type_projects(db_session):
    await _seeded(db_session)
    projects = await _untype_some(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    untyped = {str(p.id) for p in projects if p.type is None}
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/projects", type="Unmapped")
        analytics = await _get(client, "/dashboard/analytics")
    assert _ids(body) == untyped
    assert body["total_count"] == len(untyped) == len(body["rows"])
    assert all(r["type"] is None for r in body["rows"])
    assert body["total_count"] == _unmapped_bucket(analytics)


async def test_unmapped_with_each_hub_filter_matches_the_bucket(db_session):
    w = await _seeded(db_session)
    projects = await _untype_some(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    total = 0
    async with _client(db_session) as client:
        for hub in w.hubs.values():
            body = await _get(client, "/dashboard/projects", type="Unmapped", hub_id=hub.id)
            analytics = await _get(client, "/dashboard/analytics", hub_id=hub.id)
            expected = {str(p.id) for p in projects if p.hub_id == hub.id and p.type is None}
            assert _ids(body) == expected
            assert body["total_count"] == _unmapped_bucket(analytics) == len(expected)
            total += body["total_count"]
    assert total == sum(1 for p in projects if p.type is None)


async def test_unmapped_ands_with_region_status_and_q(db_session):
    await _seeded(db_session)
    projects = await _untype_some(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hubs = {h.id: h for h in (await db_session.execute(select(Hub))).scalars()}
    async with _client(db_session) as client:
        for region in {h.lab_region for h in hubs.values()}:
            body = await _get(client, "/dashboard/projects", type="Unmapped", region=region.value)
            analytics = await _get(client, "/dashboard/analytics", region=region.value)
            expected = {
                str(p.id)
                for p in projects
                if p.type is None and hubs[p.hub_id].lab_region == region
            }
            assert _ids(body) == expected
            assert body["total_count"] == _unmapped_bucket(analytics)

        status = next(p.status for p in projects if p.type is None)
        body = await _get(client, "/dashboard/projects", type="Unmapped", status_=status.value)
        assert _ids(body) == {str(p.id) for p in projects if p.type is None and p.status == status}

        # A real type still filters to exactly that type (no null rows).
        some_type = next(p.type for p in projects if p.type is not None)
        body = await _get(client, "/dashboard/projects", type=some_type.value)
        assert _ids(body) == {str(p.id) for p in projects if p.type == some_type}
        # Sentinel + every type partitions the unfiltered register.
        everything = await _get(client, "/dashboard/projects")
        parts = (await _get(client, "/dashboard/projects", type="Unmapped"))["total_count"]
        for t in ProjectType:
            parts += (await _get(client, "/dashboard/projects", type=t.value))["total_count"]
        assert parts == everything["total_count"] == len(projects)


async def test_hub_planner_scope_holds_for_unmapped(db_session):
    w = await _seeded(db_session)
    projects = await _untype_some(db_session)
    hubs = list(w.hubs.values())
    own = next(h for h in hubs if any(p.hub_id == h.id and p.type is None for p in projects))
    other = next(
        h
        for h in hubs
        if h.id != own.id and any(p.hub_id == h.id and p.type is None for p in projects)
    )
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[own.id])
    expected = {str(p.id) for p in projects if p.hub_id == own.id and p.type is None}
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/projects", type="Unmapped")
        analytics = await _get(client, "/dashboard/analytics")
        assert _ids(body) == expected
        assert body["total_count"] == _unmapped_bucket(analytics)
        # An out-of-scope hub narrows to nothing (never widens, never 403).
        other_body = await _get(client, "/dashboard/projects", type="Unmapped", hub_id=other.id)
        assert other_body == {"total_count": 0, "rows": []}
        own_body = await _get(client, "/dashboard/projects", type="Unmapped", hub_id=own.id)
        assert _ids(own_body) == expected


@pytest.mark.parametrize(
    "bad", ["XX", "unmapped", "UNMAPPED", "Unknown", "null", "None", "", "Unmapped "]
)
async def test_other_unknown_type_values_are_422(db_session, bad):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.get("/dashboard/projects", params={"type": bad})
    assert resp.status_code == 422, (bad, resp.text)


async def test_unmapped_still_requires_the_dashboard_permission(db_session):
    await _act_as(db_session, RoleName.ENGINEER)
    async with _client(db_session) as client:
        resp = await client.get("/dashboard/projects", params={"type": "Unmapped"})
    assert resp.status_code == 403


async def test_out_of_scope_random_hub_is_empty(db_session):
    await _seeded(db_session)
    await _untype_some(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/projects", type="Unmapped", hub_id=uuid.uuid4())
    assert body == {"total_count": 0, "rows": []}


def test_sentinel_matches_the_analytics_bucket_key():
    from typing import get_args

    from api.routers.dashboard import _UNMAPPED
    from schemas.dashboard import RegisterTypeFilter

    literal = next(a for a in get_args(RegisterTypeFilter) if a is not ProjectType)
    assert get_args(literal) == (_UNMAPPED,)
    assert _UNMAPPED not in {t.value for t in ProjectType}
