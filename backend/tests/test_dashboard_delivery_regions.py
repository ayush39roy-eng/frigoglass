"""Owner request 2026-11-16: `CompletingWithinYear.regions` on
`GET /dashboard/completing-within-year` — the four exclusive outcome buckets
per lab region (Greece, India, Romania, in that order, zero rows included),
counted from the same scoped, filtered outcome rows as the top-level counts.

- Σ regions == the top-level count, per bucket (also with no active run).
- OEM-HCK / OEM-Seitek count under Greece (hubs from the real seed mapping).
- Hub Planner: only own hubs; other regions zero.
- Country filter (`region=`) narrows the rows and the region list.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from models.enums import ProjectCategory, RoleName
from models.hub import Hub
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome
from seed import seed_demo_data
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_project, make_schedule_run, make_user

BUCKETS = ("within_year_count", "spillover_count", "left_out_count", "blocked_count")


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session: AsyncSession) -> AsyncClient:
    async def _override_get_db() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(
    db_session: AsyncSession, *roles: RoleName, hub_ids: list[uuid.UUID] | None = None
) -> None:
    user = await make_user(
        db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=hub_ids is None
    )
    override_current_principal(
        make_principal(
            *roles, user_id=user.id, email=user.email, hub_scope_all=hub_ids is None,
            hub_ids=hub_ids or [],
        )
    )


async def _outcome(
    db_session: AsyncSession, run: ScheduleRun, project: Any, **flags: bool
) -> None:
    values: dict[str, Any] = dict(
        id=uuid.uuid4(), schedule_run_id=run.id, project_id=project.id,
        left_out=False, cat_not_allowed=False, spillover=False, within_year=False,
        blocked=False,
    )
    values.update(flags)
    db_session.add(ScheduleRunProjectOutcome(**values))


async def _seed(db_session: AsyncSession) -> dict[str, Hub]:
    """One project per (hub, bucket) mix, from the real hub seed (so the
    lab-region mapping under test is the shipped one)."""

    hubs = await seed_demo_data.seed_hubs(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    plan: dict[str, list[dict[str, bool]]] = {
        # hub: list of outcome flag sets
        "R&D-Greece": [{"within_year": True}, {"spillover": True}],
        "OEM-HCK": [{"within_year": True}, {"left_out": True}],
        "OEM-Seitek": [{"within_year": True}, {"blocked": True, "left_out": True}],
        "R&D-India": [{"within_year": True}, {"spillover": True}],
        "PD-India": [{"blocked": True}],
        "PD-Romania": [],
    }
    for hub_name, flag_sets in plan.items():
        for i, flags in enumerate(flag_sets):
            extra: dict[str, Any] = (
                {"category": ProjectCategory.A_OEM} if hubs[hub_name].is_oem else {}
            )
            project = await make_project(
                db_session, hubs[hub_name], name=f"{hub_name} {i}", **extra
            )
            await _outcome(db_session, run, project, **flags)
    await db_session.flush()
    return hubs


async def _get(client: AsyncClient, **params: str) -> dict[str, Any]:
    resp = await client.get("/dashboard/completing-within-year", params=params)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _by_region(body: dict[str, Any]) -> dict[str, tuple[int, ...]]:
    assert [r["region"] for r in body["regions"]] == ["Greece", "India", "Romania"]
    return {r["region"]: tuple(r[b] for b in BUCKETS) for r in body["regions"]}


def _assert_reconciles(body: dict[str, Any]) -> None:
    for bucket in BUCKETS:
        assert sum(r[bucket] for r in body["regions"]) == body[bucket], bucket


async def test_regions_reconcile_and_oem_counts_under_greece(db_session: AsyncSession) -> None:
    await _seed(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client)
    _assert_reconciles(body)
    assert (body["within_year_count"], body["spillover_count"],
            body["left_out_count"], body["blocked_count"]) == (4, 2, 1, 2)
    assert _by_region(body) == {
        # R&D-Greece + OEM-HCK + OEM-Seitek; the blocked+left_out row is Blocked.
        "Greece": (3, 1, 1, 1),
        "India": (1, 1, 0, 1),
        "Romania": (0, 0, 0, 0),
    }


async def test_no_active_run_serves_three_zero_rows(db_session: AsyncSession) -> None:
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client)
    assert body["has_active_schedule_run"] is False
    _assert_reconciles(body)
    assert _by_region(body) == {r: (0, 0, 0, 0) for r in ("Greece", "India", "Romania")}


async def test_hub_planner_sees_only_own_hubs(db_session: AsyncSession) -> None:
    hubs = await _seed(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hubs["R&D-India"].id])
    async with _client(db_session) as client:
        body = await _get(client)
        # A country filter outside the scope never widens it.
        outside = await _get(client, region="Greece")
    _assert_reconciles(body)
    assert _by_region(body) == {
        "Greece": (0, 0, 0, 0),
        "India": (1, 1, 0, 0),
        "Romania": (0, 0, 0, 0),
    }
    _assert_reconciles(outside)
    assert all(v == (0, 0, 0, 0) for v in _by_region(outside).values())


async def test_country_filter_narrows_regions(db_session: AsyncSession) -> None:
    hubs = await _seed(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        greece = await _get(client, region="Greece")
        india = await _get(client, region="India")
        # ADR 0051: hub_id and region are unioned.
        union = await _get(client, region="India", hub_id=str(hubs["OEM-HCK"].id))
    for body in (greece, india, union):
        _assert_reconciles(body)
    assert _by_region(greece) == {
        "Greece": (3, 1, 1, 1), "India": (0, 0, 0, 0), "Romania": (0, 0, 0, 0),
    }
    assert _by_region(india) == {
        "Greece": (0, 0, 0, 0), "India": (1, 1, 0, 1), "Romania": (0, 0, 0, 0),
    }
    assert _by_region(union) == {
        "Greece": (1, 0, 1, 0), "India": (1, 1, 0, 1), "Romania": (0, 0, 0, 0),
    }
