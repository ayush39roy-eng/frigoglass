"""P25-T01 (ADR 0036, docs/API_CONTRACT_P25.md): the P1 capacity fill.

Part 1 is the pure walk (`services.priority_scoring.fill_p1_capacity`) on
hand-worked numbers. Part 2 runs the served endpoints on a small world whose
remaining design capacity is exactly 10 weeks:

    calendar weeks_in_year = 41, no leave days, CURRENT_WEEK = 31 (tests),
    one engineer at FTE 1.0  ->  (41 - 31 - 0) x 1.0 = 10.00 weeks.

Every design load is one Not Started PDD-A row in the active run starting at
week 31 (remaining effort = its duration).
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, func, select

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, ProjectPriority, ProjectStatus, RoleName
from models.hub import HubWorkCalendar
from models.priority import PriorityScore
from models.project import Project
from models.schedule import ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from services.priority_capacity_fill import compute_capacity_fill
from services.priority_scoring import (
    P1_SCORE_THRESHOLD,
    FillProject,
    fill_p1_capacity,
)
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_engineer,
    make_hub,
    make_priority_score,
    make_project,
    make_schedule_run,
    make_user,
)

# --------------------------------------------------------------------------
# Part 1: the pure walk
# --------------------------------------------------------------------------


def _fp(pct: int | None, weeks: float, *, schedulable: bool = True, pid: uuid.UUID | None = None):
    return FillProject(
        project_id=pid or uuid.uuid4(),
        normalized_pct=pct,
        schedulable=schedulable,
        remaining_design_weeks=Decimal(str(weeks)),
    )


def test_threshold_is_the_band_rule():
    assert P1_SCORE_THRESHOLD == 70
    assert dc.PRIORITY_BAND_THRESHOLDS[0] == (70, "P1")


def test_hand_worked_first_promoted_then_stop():
    """C 10, base 6; candidates 3 (score 65) and 2 (score 60): 6 + 3 = 9 <= 10
    promoted; 9 + 2 = 11 > 10 stopped. A later candidate of 1 (score 50) would
    fit (9 + 1 = 10) but the walk has stopped, so it is not considered."""

    base = _fp(80, 6)
    first, second, later = _fp(65, 3), _fp(60, 2), _fp(50, 1)
    fill = fill_p1_capacity(Decimal("10"), [later, second, base, first])
    assert (fill.capacity_weeks, fill.base_load_weeks, fill.filled_load_weeks) == (
        Decimal("10.00"),
        Decimal("6.00"),
        Decimal("9.00"),
    )
    assert fill.promoted_ids == {first.project_id}
    assert fill.decisions[first.project_id].outcome == "promoted"
    assert fill.decisions[first.project_id].load_after_weeks == Decimal("9.00")
    assert fill.decisions[second.project_id].outcome == "stopped"
    assert fill.decisions[second.project_id].load_after_weeks == Decimal("11.00")
    assert later.project_id not in fill.decisions
    assert base.project_id not in fill.decisions


def test_exact_fill_is_allowed():
    """`L + load <= C`: reaching exactly 100 % promotes."""

    a = _fp(60, 4)
    fill = fill_p1_capacity(Decimal("10"), [_fp(75, 6), a])
    assert fill.promoted_ids == {a.project_id}
    assert fill.filled_load_weeks == Decimal("10.00")


def test_tie_break_by_project_id_is_deterministic():
    low = uuid.UUID("00000000-0000-0000-0000-000000000001")
    high = uuid.UUID("ffffffff-0000-0000-0000-000000000001")
    projects = [_fp(80, 6), _fp(65, 3, pid=high), _fp(65, 3, pid=low)]
    results = {
        frozenset(fill_p1_capacity(Decimal("10"), order).promoted_ids)
        for order in (projects, list(reversed(projects)), projects[1:] + projects[:1])
    }
    assert results == {frozenset({low})}


def test_overfull_and_exactly_full_hub_promote_nothing():
    cand = _fp(65, 1)
    over = fill_p1_capacity(Decimal("10"), [_fp(90, 12), cand])
    assert over.promoted_ids == frozenset() and over.decisions == {}
    assert (over.base_load_weeks, over.filled_load_weeks) == (Decimal("12.00"), Decimal("12.00"))
    full = fill_p1_capacity(Decimal("10"), [_fp(90, 10), cand])
    assert full.promoted_ids == frozenset()


def test_zero_capacity_promotes_nothing():
    assert fill_p1_capacity(Decimal("0"), [_fp(65, 0), _fp(60, 1)]).decisions == {}


def test_zero_load_candidate_is_skipped_and_the_walk_continues():
    zero, next_one = _fp(68, 0), _fp(64, 2)
    fill = fill_p1_capacity(Decimal("10"), [_fp(70, 6), zero, next_one])
    assert fill.decisions[zero.project_id].outcome == "skipped_no_load"
    assert fill.promoted_ids == {next_one.project_id}
    assert fill.filled_load_weeks == Decimal("8.00")


def test_excluded_statuses_and_unscored_are_never_candidates():
    excluded = _fp(69, 1, schedulable=False)
    unscored = _fp(None, 1)
    fill = fill_p1_capacity(Decimal("10"), [_fp(80, 2), excluded, unscored])
    assert fill.decisions == {}
    assert fill.filled_load_weeks == Decimal("2.00")


def test_base_set_counts_any_status_and_score_70_is_base_not_candidate():
    at_70 = _fp(70, 3, schedulable=False)
    fill = fill_p1_capacity(Decimal("10"), [at_70, _fp(69, 7)])
    assert fill.base_load_weeks == Decimal("3.00")
    assert at_70.project_id not in fill.decisions
    assert len(fill.promoted_ids) == 1


def test_fractional_effort_is_exact():
    """0.1 + 0.2 must not exceed 0.3 through float error."""

    a, b = _fp(60, 0.1), _fp(59, 0.2)
    fill = fill_p1_capacity(Decimal("0.3"), [a, b])
    assert fill.promoted_ids == {a.project_id, b.project_id}


# --------------------------------------------------------------------------
# Part 2: served fields
# --------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles: RoleName, hub_ids: list[uuid.UUID] | None = None):
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=hub_ids is None)
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=hub_ids is None,
            hub_ids=hub_ids or [],
        )
    )


def _band(pct: int) -> ProjectPriority:
    return ProjectPriority(next(lbl for t, lbl in dc.PRIORITY_BAND_THRESHOLDS if pct >= t))


async def _hub10(db_session, name=HubName.RD_GREECE, region=LabRegion.GREECE):
    """A hub whose remaining design capacity is exactly 10.00 weeks."""

    hub = await make_hub(db_session, name=name, lab_region=region)
    db_session.add(
        HubWorkCalendar(
            hub_id=hub.id,
            weekdays_per_week=5,
            national_holiday_days=0,
            medical_leave_days=0,
            casual_leave_days=0,
            annual_leave_days=0,
            weeks_in_year=dc.CURRENT_WEEK + 10,
        )
    )
    await make_engineer(db_session, hub, fte=1.0)
    await db_session.flush()
    return hub


async def _project(db_session, hub, run, name, pct, weeks, *, pid=None, **overrides):
    """A scored project (stored pct and band) with `weeks` of remaining design
    work in `run` (none when `weeks` is 0 or `run` is None)."""

    if pid is not None:
        overrides["id"] = pid
    project = await make_project(
        db_session, hub, name=name, priority=ProjectPriority.P3, **overrides
    )
    await make_priority_score(
        db_session,
        project,
        dims=[3] * 13,
        weighted_score=float(pct),
        normalized_pct=pct,
        suggested_band=_band(pct),
    )
    if run is not None and weeks:
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id,
                project_id=project.id,
                step_template_id="PDD-A",
                sequence_order=1,
                duration_weeks=weeks,
                start_week=dc.CURRENT_WEEK,
                end_week=dc.CURRENT_WEEK + weeks - 1,
            )
        )
        # ADR 0041 R12 (P30): the fill's load is the REMAINING DEMAND of the
        # live rows; mirror the run figure as a Not Started PDD-A row whose
        # user override is `weeks`.
        db_session.add(
            ProjectWorkflowStep(
                project_id=project.id, step_template_id="PDD-A", sequence_order=1,
                duration_weeks=1, duration_override_weeks=weeks,
            )
        )
        await db_session.flush()
    return project


async def _hand_worked_world(db_session, *, active: bool = True):
    hub = await _hub10(db_session)
    run = await make_schedule_run(db_session, is_active=active)
    p = {
        "base": await _project(db_session, hub, run, "Base", 80, 6),
        "first": await _project(db_session, hub, run, "First", 65, 3),
        "zero": await _project(db_session, hub, run, "Zero", 62, 0),
        "second": await _project(db_session, hub, run, "Second", 60, 2),
        "low": await _project(db_session, hub, run, "Low", 30, 1),
    }
    return hub, run, p


async def test_rows_hand_worked(db_session):
    hub, _run, p = await _hand_worked_world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        rows = {r["project_name"]: r for r in (await client.get("/priorities")).json()}
        fill = (await client.get("/priorities/capacity-fill")).json()
        hub_load = (await client.get("/capacity/hub-load")).json()

    first = rows["First"]
    assert (first["suggested_band"], first["score_band"], first["capacity_fill"]) == (
        "P1",
        "P2",
        True,
    )
    assert first["capacity_fill_reason"] == (
        "P1 (capacity fill): hub P1 design load 9.00 of 10.00 weeks with this project"
    )
    zero = rows["Zero"]
    assert (zero["suggested_band"], zero["capacity_fill"]) == ("P2", False)
    assert (
        zero["capacity_fill_reason"] == "Not promoted: no remaining design work in the active run"
    )
    second = rows["Second"]
    assert (second["suggested_band"], second["score_band"], second["capacity_fill"]) == (
        "P2",
        "P2",
        False,
    )
    assert (
        second["capacity_fill_reason"]
        == "Not promoted: hub P1 design load would be 11.00 of 10.00 weeks"
    )
    for name in ("Base", "Low"):
        assert rows[name]["capacity_fill"] is False and rows[name]["capacity_fill_reason"] is None
        assert rows[name]["suggested_band"] == rows[name]["score_band"]
    assert rows["Base"]["suggested_band"] == "P1"

    assert fill["has_active_schedule_run"] is True
    assert fill["hubs"] == [
        {
            "hub": "R&D-Greece",
            "capacity_weeks": 10.0,
            "base_load_weeks": 6.0,
            "filled_load_weeks": 9.0,
            "promoted_count": 1,
            "members": [],  # P29: no member hub in this world
            "selected_member": None,
        }
    ]
    # Same capacity definition as the Capacity page.
    (cap_row,) = [r for r in hub_load["rows"] if r["hub"] == "R&D-Greece"]
    assert cap_row["design_capacity_remaining"] == fill["hubs"][0]["capacity_weeks"]


async def test_single_row_and_compare_carry_the_fill(db_session):
    _hub, _run, p = await _hand_worked_world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        one = (await client.get(f"/priorities/{p['first'].id}")).json()
        cmp_ = (
            await client.get(
                "/priorities/compare",
                params=[("project_id", str(p["first"].id)), ("project_id", str(p["second"].id))],
            )
        ).json()
    assert (one["suggested_band"], one["score_band"], one["capacity_fill"]) == ("P1", "P2", True)
    first, second = cmp_["projects"]
    assert (first["suggested_band"], first["capacity_fill"]) == ("P1", True)
    assert (second["suggested_band"], second["capacity_fill"]) == ("P2", False)


async def test_fill_ignores_row_filters(db_session):
    """The per-hub walk uses every project of the hub: a search that returns
    only 'First' still shows it promoted."""

    await _hand_worked_world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        rows = (await client.get("/priorities", params={"q": "First"})).json()
    assert [(r["project_name"], r["capacity_fill"]) for r in rows] == [("First", True)]


async def test_distribution_and_summary_reconcile_with_rows(db_session):
    await _hand_worked_world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for params in ({}, {"q": "First"}, {"q": "Second"}, {"status_": "In Queue"}):
            rows = (await client.get("/priorities", params=params)).json()
            dist = (await client.get("/priorities/distribution", params=params)).json()
            by_band = {b["band"]: b["count"] for b in dist["band_distribution"]}
            for band in ("P1", "P2", "P3", "P4"):
                assert by_band[band] == sum(1 for r in rows if r["suggested_band"] == band), params
            assert dist["capacity_fill_count"] == sum(1 for r in rows if r["capacity_fill"])
        summary = (await client.get("/priorities/summary")).json()
    assert by_band  # last loop iteration ran
    assert summary["suggested_band_counts"] == {"P1": 2, "P2": 2, "P4": 1}
    assert summary["score_band_counts"] == {"P1": 1, "P2": 3, "P4": 1}
    assert summary["capacity_fill_count"] == 1


async def test_no_active_run_means_no_fill(db_session):
    await _hand_worked_world(db_session, active=False)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        rows = (await client.get("/priorities")).json()
        fill = (await client.get("/priorities/capacity-fill")).json()
    assert all(r["capacity_fill"] is False and r["capacity_fill_reason"] is None for r in rows)
    assert all(r["suggested_band"] == r["score_band"] for r in rows)
    assert fill["has_active_schedule_run"] is False and fill["schedule_run_version"] is None
    assert fill["hubs"] == [
        {
            "hub": "R&D-Greece",
            "capacity_weeks": 10.0,
            "base_load_weeks": 0.0,
            "filled_load_weeks": 0.0,
            "promoted_count": 0,
            "members": [],  # P29: no member hub in this world
            "selected_member": None,
        }
    ]


async def test_overfull_hub_promotes_none(db_session):
    hub = await _hub10(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    await _project(db_session, hub, run, "Big P1", 90, 12)
    await _project(db_session, hub, run, "Small", 65, 1)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        rows = (await client.get("/priorities")).json()
        fill = (await client.get("/priorities/capacity-fill")).json()
    assert not any(r["capacity_fill"] for r in rows)
    assert all(r["capacity_fill_reason"] is None for r in rows)
    assert fill["hubs"][0]["base_load_weeks"] == 12.0
    assert fill["hubs"][0]["filled_load_weeks"] == 12.0
    assert fill["hubs"][0]["promoted_count"] == 0


async def test_tie_break_on_project_id(db_session):
    hub = await _hub10(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    low = uuid.UUID("00000000-0000-4000-8000-000000000001")
    high = uuid.UUID("ffffffff-0000-4000-8000-000000000001")
    await _project(db_session, hub, run, "Base", 80, 6)
    # Created high first and named so the name order is the opposite of the id order.
    await _project(db_session, hub, run, "A tie", 65, 3, pid=high)
    await _project(db_session, hub, run, "Z tie", 65, 3, pid=low)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for _ in range(3):
            rows = {r["project_id"]: r for r in (await client.get("/priorities")).json()}
            assert rows[str(low)]["capacity_fill"] is True
            assert rows[str(high)]["capacity_fill"] is False
            assert "would be 12.00 of 10.00" in rows[str(high)]["capacity_fill_reason"]


async def test_scheduler_excluded_statuses_are_never_promoted(db_session):
    hub = await _hub10(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    await _project(db_session, hub, run, "Base", 80, 2)
    excluded = [
        ProjectStatus.COMMERCIALIZED,
        ProjectStatus.CANCELLED,
        ProjectStatus.ON_HOLD,
        ProjectStatus.DRAFT,
    ]
    for i, status in enumerate(excluded):
        # Stale run rows on purpose: a fitting load must still not promote them.
        await _project(db_session, hub, run, f"X{i}", 69 - i, 1, status=status)
    ok = await _project(db_session, hub, run, "Schedulable", 50, 1)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        rows = {r["project_name"]: r for r in (await client.get("/priorities")).json()}
    for i in range(len(excluded)):
        assert rows[f"X{i}"]["capacity_fill"] is False
        assert rows[f"X{i}"]["capacity_fill_reason"] is None
    assert rows["Schedulable"]["capacity_fill"] is True
    assert ok.status == ProjectStatus.IN_QUEUE


async def test_hub_planner_sees_only_own_hub_fill(db_session):
    greece, _run, _p = await _hand_worked_world(db_session)
    romania = await _hub10(db_session, HubName.PD_ROMANIA, LabRegion.ROMANIA)
    await _project(db_session, romania, _run, "RO cand", 60, 4)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        admin_fill = (await client.get("/priorities/capacity-fill")).json()["hubs"]
    assert {h["hub"] for h in admin_fill} == {"PD-Romania", "R&D-Greece"}

    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with _client(db_session) as client:
        mine = (await client.get("/priorities/capacity-fill")).json()["hubs"]
        other = (
            await client.get("/priorities/capacity-fill", params={"hub_id": str(romania.id)})
        ).json()["hubs"]
        rows = (await client.get("/priorities")).json()
    assert mine == [h for h in admin_fill if h["hub"] == "R&D-Greece"]
    assert other == []
    assert {r["hub"] for r in rows} == {"R&D-Greece"}
    assert [r["project_name"] for r in rows if r["capacity_fill"]] == ["First"]


async def test_reads_never_change_committed_priority_or_scores(db_session):
    _hub, _run, p = await _hand_worked_world(db_session)
    first_id = p["first"].id
    before = {
        pid: (prio, band)
        for pid, prio, band in (
            await db_session.execute(
                select(Project.id, Project.priority, PriorityScore.suggested_band).join(
                    PriorityScore, PriorityScore.project_id == Project.id
                )
            )
        ).all()
    }
    audits = await db_session.scalar(select(func.count()).select_from(AuditLogEntry))
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for path in (
            "/priorities",
            "/priorities/capacity-fill",
            "/priorities/distribution",
            "/priorities/summary",
            f"/priorities/{first_id}",
        ):
            assert (await client.get(path)).status_code == 200
    db_session.expire_all()
    after = {
        pid: (prio, band)
        for pid, prio, band in (
            await db_session.execute(
                select(Project.id, Project.priority, PriorityScore.suggested_band).join(
                    PriorityScore, PriorityScore.project_id == Project.id
                )
            )
        ).all()
    }
    assert after == before
    assert before[first_id] == (ProjectPriority.P3, ProjectPriority.P2)
    assert await db_session.scalar(select(func.count()).select_from(AuditLogEntry)) == audits


async def test_constant_query_count(db_session):
    """No N+1: the fill costs the same number of queries for 3 or 30 projects."""

    hub = await _hub10(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    for i in range(3):
        await _project(db_session, hub, run, f"S{i}", 60 + i, 1)

    statements: list[str] = []

    def _count(_conn, _cursor, statement, *_args):
        statements.append(statement)

    engine = db_session.bind.sync_engine
    event.listen(engine, "before_cursor_execute", _count)
    try:
        small = await compute_capacity_fill(db_session, {hub.id})
        n_small = len(statements)
        for i in range(27):
            await _project(db_session, hub, run, f"L{i}", 40 + i % 30, 1 + i % 3)
        statements.clear()
        large = await compute_capacity_fill(db_session, {hub.id})
        n_large = len(statements)
    finally:
        event.remove(engine, "before_cursor_execute", _count)
    assert n_small == n_large
    assert len(small.hubs[hub.id].promoted_ids) == 3
    assert large.hubs[hub.id].filled_load_weeks <= large.hubs[hub.id].capacity_weeks
