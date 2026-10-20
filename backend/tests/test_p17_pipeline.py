"""P17-T01 (ADR 0030, docs/API_CONTRACT_P17.md): the Project Pipeline row
`Spillover + Newly registered + Unregistered date = Total projects`.

Every expectation is derived from the projects table independently of the
endpoint code (a Python loop over the rows), then compared with the served
counts and 2 dp shares.
"""

from __future__ import annotations

import pytest
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


def _share(part: int, whole: int) -> float:
    return round(part / whole * 100, 2) if whole else 0.0


def _bucket(p: Project) -> str:
    if p.carry_over:
        return "spillover"
    return "unregistered" if p.reg_year is None else "new"


async def _shape_data(db_session) -> dict:
    """Force every bucket and a Commercialized project into the seed, and
    return the (hub name, lab_region) of each project for expectations."""

    projects = list((await db_session.execute(select(Project).order_by(Project.id))).scalars())
    # carry_over projects with a null reg_year must still count as spillover
    # (spillover wins; the buckets are exclusive).
    projects[0].carry_over = True
    projects[0].reg_year = None
    projects[1].carry_over = False
    projects[1].reg_year = None
    projects[2].carry_over = False
    projects[2].reg_year = None
    projects[3].carry_over = False
    projects[3].reg_year = 2026
    projects[4].status = ProjectStatus.COMMERCIALIZED
    projects[4].carry_over = False
    projects[4].reg_year = None
    await db_session.flush()
    return {}


def _expected(projects, _unused=None) -> dict:
    out = {"spillover": 0, "new": 0, "unregistered": 0}
    for p in projects:
        out[_bucket(p)] += 1
    return out


async def test_totals_sum_invariant_commercialized_and_null_reg_year(db_session):
    await _seeded(db_session)
    await _shape_data(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    projects = list((await db_session.execute(select(Project))).scalars())
    exp = _expected(projects, {})
    assert exp["unregistered"] >= 3 and exp["spillover"] >= 1 and exp["new"] >= 1
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/pipeline-totals")
        overview = await _get(client, "/dashboard/status-overview")
    assert body["spillover_count"] == exp["spillover"]
    assert body["new_count"] == exp["new"]
    assert body["unregistered_count"] == exp["unregistered"]
    # Every project, Commercialized included: total == all rows == status total.
    assert body["total_count"] == len(projects)
    assert body["total_count"] == (
        body["spillover_count"] + body["new_count"] + body["unregistered_count"]
    )
    status_total = (
        overview["in_buyoff"] + overview["under_industrialization"]
        + overview["in_development"] + overview["in_queue"]
        + sum(overview["other_counts"].values())
    )
    assert body["total_count"] == status_total
    assert any(p.status == ProjectStatus.COMMERCIALIZED for p in projects)
    for key, count in (
        ("spillover_share_pct", exp["spillover"]),
        ("new_share_pct", exp["new"]),
        ("unregistered_share_pct", exp["unregistered"]),
    ):
        assert body[key] == _share(count, len(projects))


async def test_hub_and_country_filters_and_region_summary_reconcile(db_session):
    w = await _seeded(db_session)
    await _shape_data(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    projects = list((await db_session.execute(select(Project))).scalars())
    hubs = {h.id: h for h in (await db_session.execute(select(Hub))).scalars()}
    async with _client(db_session) as client:
        summary = await _get(client, "/dashboard/region-summary")
        totals = await _get(client, "/dashboard/pipeline-totals")
        regions = summary["regions"]
        assert [r["region"] for r in regions] == list(REGIONS)
        assert sum(r["unregistered_count"] for r in regions) == totals["unregistered_count"]
        assert sum(r["spillover_count"] for r in regions) == totals["spillover_count"]
        assert sum(r["newly_registered_count"] for r in regions) == totals["new_count"]
        for r in regions:
            mine = [p for p in projects if hubs[p.hub_id].lab_region.value == r["region"]]
            exp = _expected(mine, {})
            assert (r["spillover_count"], r["newly_registered_count"],
                    r["unregistered_count"]) == (exp["spillover"], exp["new"], exp["unregistered"])
            assert r["total_count"] == len(mine)
            assert r["spillover_share_pct"] == _share(r["spillover_count"],
                                                      totals["spillover_count"])
            assert r["newly_registered_share_pct"] == _share(r["newly_registered_count"],
                                                             totals["new_count"])
            assert r["unregistered_share_pct"] == _share(r["unregistered_count"],
                                                         totals["unregistered_count"])
            # Country filter: the card for the country equals its chip.
            own = await _get(client, "/dashboard/pipeline-totals", region=r["region"])
            assert (own["spillover_count"], own["new_count"], own["unregistered_count"],
                    own["total_count"]) == (
                r["spillover_count"], r["newly_registered_count"], r["unregistered_count"],
                r["total_count"],
            )
            # Filtered summary keeps shares reconciling with the filtered card.
            filtered = await _get(client, "/dashboard/region-summary", region=r["region"])
            frow = next(x for x in filtered["regions"] if x["region"] == r["region"])
            assert frow["total_count"] == own["total_count"]
            assert frow["unregistered_count"] == own["unregistered_count"]
            if own["unregistered_count"]:
                assert frow["unregistered_share_pct"] == 100.0
        # Hub filter, every hub: matches an independent count and sums to total.
        sums = {"spillover": 0, "new": 0, "unregistered": 0, "total": 0}
        for hub_id in w.hubs.values():
            mine = [p for p in projects if p.hub_id == hub_id.id]
            exp = _expected(mine, {})
            body = await _get(client, "/dashboard/pipeline-totals", hub_id=hub_id.id)
            assert (body["spillover_count"], body["new_count"], body["unregistered_count"],
                    body["total_count"]) == (
                exp["spillover"], exp["new"], exp["unregistered"], len(mine))
            for k in ("spillover", "new", "unregistered"):
                sums[k] += exp[k]
            sums["total"] += len(mine)
        assert sums["total"] == totals["total_count"]
        assert sums["unregistered"] == totals["unregistered_count"]


@pytest.mark.parametrize("path", ["/dashboard/hub-type-pipeline", "/dashboard/analytics"])
async def test_other_pipeline_tables_share_the_all_projects_basis(db_session, path):
    await _seeded(db_session)
    await _shape_data(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        totals = await _get(client, "/dashboard/pipeline-totals")
        body = await _get(client, path)
    if path.endswith("hub-type-pipeline"):
        assert sum(r["count"] for r in body) == totals["total_count"]
    else:
        assert sum(b["count"] for b in body["by_hub"]) == totals["total_count"]
        years = {b["key"]: b["count"] for b in body["by_reg_year"]}
        null_year = sum(
            1 for p in (await db_session.execute(select(Project))).scalars() if p.reg_year is None
        )
        # "Unknown" counts every null reg_year (incl. a spillover row with a
        # null year), a superset of the exclusive `unregistered` bucket.
        assert years["Unknown"] == null_year >= totals["unregistered_count"]


async def test_out_of_scope_hub_zero_denominator(db_session):
    import uuid

    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/pipeline-totals", hub_id=uuid.uuid4())
    assert body["total_count"] == 0
    assert (body["spillover_share_pct"], body["new_share_pct"],
            body["unregistered_share_pct"]) == (0.0, 0.0, 0.0)
