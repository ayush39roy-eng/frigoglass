"""P17-R03 (docs/API_CONTRACT_P17.md): `status`, `not_started` and
`priority_delivery` on `GET /dashboard/completing-within-year`.

Expectations come from a Python loop over projects, stage rows and the active
run's outcomes, independent of the endpoint code.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select

from models.enums import ProjectPriority, ProjectStatus, RoleName, WorkflowStepStatus
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRunProjectOutcome
from models.workflow import ProjectWorkflowStep
from tests.test_p13_region_filter import (
    REGIONS,
    _act_as,
    _cleanup,  # noqa: F401  (autouse fixture)
    _client,
    _get,
    _seeded,
)

PATH = "/dashboard/completing-within-year"
BANDS = ["P1", "P2", "P3", "P4", "Q"]
OTHER = {ProjectStatus.ON_HOLD, ProjectStatus.CANCELLED, ProjectStatus.DRAFT}


def _share(part: int, whole: int) -> float:
    return round(part / whole * 100, 2) if whole else 0.0


async def _shape(db_session, run) -> tuple[list[Project], set, dict]:
    """Make the data cover every case, then return projects, progress ids, outcomes."""
    projects = list((await db_session.execute(select(Project).order_by(Project.id))).scalars())
    p1 = [p for p in projects if p.priority == ProjectPriority.P1]
    cycle = [
        ProjectStatus.COMMERCIALIZED,
        ProjectStatus.ON_HOLD,
        ProjectStatus.DRAFT,
        ProjectStatus.CANCELLED,
        ProjectStatus.IN_QUEUE,
        ProjectStatus.IN_DEVELOPMENT,
    ]
    for p, status in zip(p1, cycle, strict=False):
        p.status = status
    await db_session.flush()
    # One In Queue project with a started stage -> in flight, not "not started".
    queued_with_progress = next(
        p for p in projects if p.status == ProjectStatus.IN_QUEUE and p not in p1[:5]
    )
    step = (
        (
            await db_session.execute(
                select(ProjectWorkflowStep).where(
                    ProjectWorkflowStep.project_id == queued_with_progress.id
                )
            )
        )
        .scalars()
        .first()
    )
    step.status = WorkflowStepStatus.IN_PROGRESS
    step.actual_start_week = 1
    await db_session.flush()
    started = {
        pid
        for pid in (
            await db_session.execute(
                select(ProjectWorkflowStep.project_id).where(
                    ProjectWorkflowStep.status != WorkflowStepStatus.NOT_STARTED
                )
            )
        ).scalars()
    }
    outcomes = {
        o.project_id: o
        for o in (
            await db_session.execute(
                select(ScheduleRunProjectOutcome).where(
                    ScheduleRunProjectOutcome.schedule_run_id == run.id
                )
            )
        ).scalars()
    }
    return projects, started, outcomes


def _expected(projects, started, outcomes) -> dict[str, dict]:
    out = {
        b: dict.fromkeys(
            ("total", "within_year", "if_t", "if_w", "ns_t", "ns_w", "dl_t", "dl_w", "ot"), 0
        )
        for b in BANDS
    }
    for p in projects:
        if p.priority is None:
            continue
        a = out[p.priority.value]
        o = outcomes.get(p.id)
        wy = bool(o and o.within_year and not o.blocked)
        a["total"] += 1
        if p.status == ProjectStatus.COMMERCIALIZED:
            a["dl_t"] += 1
            a["dl_w"] += wy
        elif p.status in OTHER:
            a["ot"] += 1
        elif p.status == ProjectStatus.IN_QUEUE and p.id not in started:
            a["ns_t"] += 1
            a["ns_w"] += wy
        else:
            a["if_t"] += 1
            a["if_w"] += wy
    for a in out.values():
        a["within_year"] = a["if_w"] + a["ns_w"] + a["dl_w"]
    return out


def _check(body: dict, exp: dict[str, dict]) -> None:
    assert [b["priority"] for b in body["priority_delivery"]] == BANDS
    for band in body["priority_delivery"]:
        e = exp[band["priority"]]
        assert band["total"] == e["total"]
        assert band["total"] == (
            band["in_flight_total"]
            + band["not_started_total"]
            + band["delivered_total"]
            + band["other_total"]
        )
        assert band["within_year"] == (
            band["in_flight_within_year"]
            + band["not_started_within_year"]
            + band["delivered_within_year"]
        )
        assert (band["in_flight_total"], band["in_flight_within_year"]) == (e["if_t"], e["if_w"])
        assert (band["not_started_total"], band["not_started_within_year"]) == (
            e["ns_t"],
            e["ns_w"],
        )
        assert (band["delivered_total"], band["delivered_within_year"]) == (e["dl_t"], e["dl_w"])
        assert band["other_total"] == e["ot"] and band["within_year"] == e["within_year"]
        assert band["within_year_share_pct"] == _share(e["within_year"], e["total"])
        assert band["in_flight_within_year_share_pct"] == _share(e["if_w"], e["if_t"])
        assert band["not_started_within_year_share_pct"] == _share(e["ns_w"], e["ns_t"])
        assert band["in_flight_share_pct"] == _share(e["if_t"], e["total"])
        assert band["not_started_share_pct"] == _share(e["ns_t"], e["total"])
        assert band["delivered_share_pct"] == _share(e["dl_t"], e["total"])
        assert band["other_share_pct"] == _share(e["ot"], e["total"])


def _check_rows(body: dict, projects, started) -> None:
    by_id = {str(p.id): p for p in projects}
    assert body["rows"]
    for row in body["rows"]:
        p = by_id[row["project_id"]]
        assert row["status"] == p.status.value
        assert row["not_started"] == (p.status == ProjectStatus.IN_QUEUE and p.id not in started)
        if p.status == ProjectStatus.COMMERCIALIZED:
            assert row["not_started"] is False


async def test_bands_rows_and_filters(db_session):
    w = await _seeded(db_session)
    projects, started, outcomes = await _shape(db_session, w.run)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hubs = {h.id: h for h in (await db_session.execute(select(Hub))).scalars()}
    async with _client(db_session) as client:
        body = await _get(client, PATH)
        _check(body, _expected(projects, started, outcomes))
        _check_rows(body, projects, started)
        # The bands' within-year total is the card's count (I9), less any
        # within-year flag the (re-statused, stale) run holds on an "other" project.
        stale = sum(
            1
            for p in projects
            if p.status in OTHER and outcomes[p.id].within_year and not outcomes[p.id].blocked
        )
        assert (
            sum(b["within_year"] for b in body["priority_delivery"])
            == body["within_year_count"] - stale
        )
        # Bands cover every project that has a priority.
        assert sum(b["total"] for b in body["priority_delivery"]) == sum(
            1 for p in projects if p.priority is not None
        )
        # Commercialized never in in-flight / not-started; In Queue with progress is in flight.
        p1 = next(b for b in body["priority_delivery"] if b["priority"] == "P1")
        assert p1["delivered_total"] >= 1 and p1["other_total"] >= 3
        assert p1["not_started_total"] >= 1
        assert any(r["status"] == "In Queue" and not r["not_started"] for r in body["rows"])
        for hub in w.hubs.values():
            mine = [p for p in projects if p.hub_id == hub.id]
            filtered = await _get(client, PATH, hub_id=hub.id)
            _check(filtered, _expected(mine, started, outcomes))
        for region in REGIONS:
            mine = [p for p in projects if hubs[p.hub_id].lab_region.value == region]
            filtered = await _get(client, PATH, region=region)
            _check(filtered, _expected(mine, started, outcomes))
        # Bands of the hubs add up to the unfiltered bands (I23 spirit).
        per_hub = [await _get(client, PATH, hub_id=h.id) for h in w.hubs.values()]
        keys = (
            "total",
            "within_year",
            "in_flight_total",
            "not_started_total",
            "delivered_total",
            "other_total",
        )
        for i, band in enumerate(body["priority_delivery"]):
            for key in keys:
                assert band[key] == sum(h["priority_delivery"][i][key] for h in per_hub)


async def test_restricted_hub_planner_sees_own_hub_only(db_session):
    w = await _seeded(db_session)
    projects, started, outcomes = await _shape(db_session, w.run)
    hub = next(iter(w.hubs.values()))
    other = next(h for h in w.hubs.values() if h.id != hub.id)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub.id])
    async with _client(db_session) as client:
        body = await _get(client, PATH)
        mine = [p for p in projects if p.hub_id == hub.id]
        _check(body, _expected(mine, started, outcomes))
        assert {r["project_id"] for r in body["rows"]} <= {str(p.id) for p in mine}
        # A hub_id filter outside the scope never widens it.
        out = await _get(client, PATH, hub_id=other.id)
        _check(out, _expected([], started, outcomes))
        assert out["rows"] == []


async def test_zero_bands(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client, PATH, hub_id=uuid.uuid4())
    assert [b["priority"] for b in body["priority_delivery"]] == BANDS
    for band in body["priority_delivery"]:
        for key, value in band.items():
            if key != "priority":
                assert value == 0 or value == 0.0
