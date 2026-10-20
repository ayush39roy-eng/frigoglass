"""P17-T03 (ADR 0030, docs/API_CONTRACT_P17.md): five-card status overview.

Expectations come from a Python loop over the projects table, independent of
the endpoint code.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select

from models.enums import ProjectStatus, RoleName
from models.hub import Hub
from models.project import Project
from tests.test_p13_region_filter import (
    REGIONS,
    _act_as,
    _cleanup,  # noqa: F401  (autouse fixture)
    _client,
    _get,
    _seeded,
)

CARDS = {
    "in_development": ProjectStatus.IN_DEVELOPMENT,
    "under_industrialization": ProjectStatus.UNDER_INDUSTRIALIZATION,
    "in_queue": ProjectStatus.IN_QUEUE,
    "commercialized": ProjectStatus.COMMERCIALIZED,
    "on_hold": ProjectStatus.ON_HOLD,
}
REMAINDER = {ProjectStatus.IN_BUYOFF, ProjectStatus.DRAFT, ProjectStatus.CANCELLED}


def _share(part: int, whole: int) -> float:
    return round(part / whole * 100, 2) if whole else 0.0


async def _shape(db_session) -> list[Project]:
    projects = list((await db_session.execute(select(Project).order_by(Project.id))).scalars())
    cycle = [
        ProjectStatus.COMMERCIALIZED, ProjectStatus.ON_HOLD, ProjectStatus.DRAFT,
        ProjectStatus.CANCELLED, ProjectStatus.IN_BUYOFF,
    ]
    for i, status in enumerate(cycle):
        projects[i].status = status
    await db_session.flush()
    return projects


def _check(body: dict, projects: list[Project]) -> None:
    total = len(projects)
    by = {s: sum(1 for p in projects if p.status == s) for s in ProjectStatus}
    assert body["total_count"] == total
    for key, status in CARDS.items():
        count = body[f"{key}_count"] if key in ("commercialized", "on_hold") else body[key]
        assert count == by[status]
        assert body[f"{key}_share_pct"] == _share(by[status], total)
    rem = sum(by[s] for s in REMAINDER)
    assert body["other_statuses_count"] == rem
    assert body["other_statuses_share_pct"] == _share(rem, total)
    assert body["other_statuses_counts"] == {s.value: by[s] for s in REMAINDER if by[s]}
    assert body["in_buyoff"] == by[ProjectStatus.IN_BUYOFF]
    # Five cards + remainder reconcile with the total exactly.
    cards = sum(by[s] for s in CARDS.values())
    assert cards + body["other_statuses_count"] == body["total_count"]


async def test_five_cards_reconcile_unfiltered_and_hub_and_country(db_session):
    w = await _seeded(db_session)
    projects = await _shape(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hubs = {h.id: h for h in (await db_session.execute(select(Hub))).scalars()}
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/status-overview")
        _check(body, projects)
        assert body["commercialized_count"] >= 1 and body["on_hold_count"] >= 1
        pipeline = await _get(client, "/dashboard/pipeline-totals")
        assert body["total_count"] == pipeline["total_count"]
        summary = await _get(client, "/dashboard/region-summary")
        for hub in w.hubs.values():
            mine = [p for p in projects if p.hub_id == hub.id]
            _check(await _get(client, "/dashboard/status-overview", hub_id=hub.id), mine)
        for region in REGIONS:
            mine = [p for p in projects if hubs[p.hub_id].lab_region.value == region]
            own = await _get(client, "/dashboard/status-overview", region=region)
            _check(own, mine)
            # Per-country chips already served by region-summary.
            row = next(r for r in summary["regions"] if r["region"] == region)
            for status in (ProjectStatus.COMMERCIALIZED, ProjectStatus.ON_HOLD,
                           ProjectStatus.IN_DEVELOPMENT):
                assert row["status_counts"][status.value] == sum(
                    1 for p in mine if p.status == status
                )
        # Chip counts across regions equal the unfiltered card counts.
        for key, status in CARDS.items():
            card = body[f"{key}_count"] if key in ("commercialized", "on_hold") else body[key]
            assert sum(r["status_counts"][status.value] for r in summary["regions"]) == card
            assert sum(r["status_share_pct"][status.value] for r in summary["regions"]) in (
                0.0, *[x / 100 for x in range(9990, 10011)]
            ) or card == 0
        # Filtered region-summary still carries the chip for the filtered country.
        filtered = await _get(client, "/dashboard/region-summary", region="India")
        row = next(r for r in filtered["regions"] if r["region"] == "India")
        assert row["status_counts"]["On Hold"] == sum(
            1 for p in projects
            if hubs[p.hub_id].lab_region.value == "India" and p.status == ProjectStatus.ON_HOLD
        )


async def test_zero_denominator_and_out_of_scope_hub(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/status-overview", hub_id=uuid.uuid4())
    assert body["total_count"] == 0
    assert body["other_statuses_count"] == 0 and body["other_statuses_counts"] == {}
    for key in ("in_development", "under_industrialization", "in_queue", "commercialized",
                "on_hold", "other_statuses"):
        assert body[f"{key}_share_pct"] == 0.0


async def test_hub_planner_sees_only_own_hub_on_p17_endpoints(db_session):
    """P17-R01 (security S2): a hub-restricted Hub Planner gets only own-hub counts."""
    w = await _seeded(db_session)
    projects = await _shape(db_session)
    own = w.hubs["PD-India"]
    mine = [p for p in projects if p.hub_id == own.id]
    assert 0 < len(mine) < len(projects)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[own.id])
    async with _client(db_session) as client:
        status = await _get(client, "/dashboard/status-overview")
        _check(status, mine)
        pipeline = await _get(client, "/dashboard/pipeline-totals")
        assert pipeline["total_count"] == len(mine) == status["total_count"]
        assert (
            pipeline["spillover_count"] + pipeline["new_count"] + pipeline["unregistered_count"]
            == pipeline["total_count"]
        )
        summary = await _get(client, "/dashboard/region-summary")
        assert summary["total_count"] == len(mine)
        assert sum(r["total_count"] for r in summary["regions"]) == len(mine)
        for key in ("spillover_count", "newly_registered_count", "unregistered_count"):
            assert sum(r[key] for r in summary["regions"]) == pipeline[
                key.replace("newly_registered", "new")
            ]
        for st in ProjectStatus:
            assert sum(r["status_counts"][st.value] for r in summary["regions"]) == sum(
                1 for p in mine if p.status == st
            )
        # Out-of-scope hub: zeros, not 403, and never widened.
        other = next(h for h in w.hubs.values() if h.id != own.id)
        zero_status = await _get(client, "/dashboard/status-overview", hub_id=other.id)
        assert zero_status["total_count"] == 0 and zero_status["other_statuses_share_pct"] == 0.0
        zero_pipe = await _get(client, "/dashboard/pipeline-totals", hub_id=other.id)
        assert zero_pipe["total_count"] == 0 and zero_pipe["new_share_pct"] == 0.0
        zero_sum = await _get(client, "/dashboard/region-summary", hub_id=other.id)
        assert zero_sum["total_count"] == 0
        assert all(r["total_count"] == 0 for r in zero_sum["regions"])
