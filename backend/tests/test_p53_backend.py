"""P53-T03 backend (ADR 0063, R53-1..R53-9, I57–I63; docs/API_CONTRACT_P53.md).

- Admin search-limit setting N: GET for anyone, PUT Admin/Super Admin only,
  optimistic version, audited, 1..10; `/me` serves N and `cw + 52 × N`.
- Every run persisted from P53 on is `rules_epoch = 'p53'`, stores
  `horizon_weeks = cw + 52 × N`, `priority_at_run` and `left_out_reason`;
  a run without the epoch is labelled pre-P53 and its delivery table is null.
- Dashboard delivery table reconciles with the within-year count (I59);
  drill-in is hub-scoped.
- Weekly rollover (P37-T05 on the absolute week): not_needed / queued /
  deferred, never CP-SAT, one row per week, failed after 3 failed attempts.
- target_end_week ≤ cw + 520; Commercialized stamps the actual end week.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    HubName,
    LabRegion,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
    SolverType,
)
from models.plan_week_rollover import PlanWeekRollover
from models.schedule import (
    PRE_P53_RULES_LABEL,
    RULES_EPOCH_P53,
    ScheduleRun,
    ScheduleRunProjectOutcome,
)
from scheduling import run_greedy_sgs
from seed import seed_demo_data
from services import week_rollover
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_hub, make_schedule_run
from tests.p12_helpers import act_as, client_for, stepped_project


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _seed_and_run(db_session: AsyncSession) -> ScheduleRun:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    return await persist_schedule_output(
        db_session,
        schedule_input,
        run_greedy_sgs(schedule_input),
        solver_type=SolverType.GREEDY,
        trigger_reason="test",
        activate=True,
    )


# --- the N setting ---------------------------------------------------------------------


async def test_settings_get_put_audit_and_me(db_session: AsyncSession) -> None:
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        got = (await client.get("/scheduling-settings")).json()
        assert (got["horizon_years"], got["current_week"]) == (5, TEST_WEEK)
        assert got["horizon_weeks_next_run"] == TEST_WEEK + 260
        put = await client.put(
            "/scheduling-settings", json={"horizon_years": 7, "version": got["version"]}
        )
        assert put.status_code == 200, put.text
        assert put.json()["horizon_years"] == 7
        assert put.json()["horizon_weeks_next_run"] == TEST_WEEK + 364
        stale = await client.put(
            "/scheduling-settings", json={"horizon_years": 3, "version": got["version"]}
        )
        assert stale.status_code == 409 and stale.json()["code"] == "VERSION_CONFLICT"
        bad = await client.put(
            "/scheduling-settings", json={"horizon_years": 11, "version": put.json()["version"]}
        )
        assert bad.status_code == 422
        me = (await client.get("/me")).json()
    assert (me["horizon_years"], me["horizon_weeks"]) == (7, TEST_WEEK + 364)
    assert (me["week_base_year"], me["plan_year"]) == (2026, 2026)
    assert (me["plan_year_start_week"], me["plan_year_end_week"]) == (1, 52)
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "settings.scheduling_horizon_updated"
            )
        )
    ).scalars().all()
    assert len(audit) == 1
    assert audit[0].before_state["horizon_years"] == 5
    assert audit[0].after_state["horizon_years"] == 7
    # Rescheduling is explicit: the save dispatched nothing.
    assert (await db_session.execute(select(ScheduleRun.id))).first() is None


async def test_settings_put_is_admin_only(db_session: AsyncSession) -> None:
    await act_as(db_session, RoleName.HUB_PLANNER)
    async with client_for(db_session) as client:
        assert (await client.get("/scheduling-settings")).status_code == 200
        put = await client.put("/scheduling-settings", json={"horizon_years": 2, "version": 1})
    assert put.status_code == 403


# --- persisted runs ----------------------------------------------------------------------


async def test_p53_run_fields_and_dashboard_delivery(db_session: AsyncSession) -> None:
    run = await _seed_and_run(db_session)
    assert run.rules_epoch == RULES_EPOCH_P53
    assert run.horizon_weeks == TEST_WEEK + 260
    outcomes = (
        await db_session.execute(
            select(ScheduleRunProjectOutcome).where(
                ScheduleRunProjectOutcome.schedule_run_id == run.id
            )
        )
    ).scalars().all()
    assert any(o.priority_at_run is not None for o in outcomes)
    for o in outcomes:
        if o.left_out:
            assert o.left_out_reason in {"no_leader", "no_chamber", "data_error", "beyond_horizon"}
    # No step row ends after the search limit (I58).
    ends = [o.last_step_end_week for o in outcomes if o.last_step_end_week is not None]
    assert max(ends) <= run.horizon_weeks

    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = (await client.get("/dashboard/completing-within-year")).json()
        summary = (await client.get("/schedule-runs/active")).json()
        drill = await client.get(
            "/dashboard/delivery-by-year/projects",
            params={"kind": "by_end_of_year", "year": 2026},
        )
    assert summary["rules_epoch"] == "p53" and summary["pre_p53"] is False
    assert summary["within_year_week"] == 52 and summary["rules_label"] is None
    table = body["delivery_by_year"]
    assert body["delivery_by_year_unavailable"] is None
    assert table["base_year"] == 2026 and table["horizon_years"] == 5
    rows = table["rows"]
    first = rows[0]
    assert first["kind"] == "by_end_of_year"
    # I59: first row == the within-year count; later years == spillover;
    # not placed == left out; blocked == blocked.
    assert first["total"] == body["within_year_count"]
    years = [r for r in rows if r["kind"] == "year"]
    assert sum(r["total"] for r in years) == body["spillover_count"]
    not_placed = next(r for r in rows if r["kind"] == "not_placed")
    assert not_placed["total"] == body["left_out_count"]
    assert sum(not_placed["left_out_reasons"].values()) == not_placed["total"]
    assert next(r for r in rows if r["kind"] == "blocked")["total"] == body["blocked_count"]
    for r in rows:
        assert r["p1"] + r["p2"] + r["p3"] + r["other"] == r["total"]
    cums = [r["cum_total"] for r in rows if r["cum_total"] is not None]
    assert cums == sorted(cums)
    assert body["tail_warnings"] is not None
    assert drill.status_code == 200, drill.text
    assert len(drill.json()["rows"]) == first["total"]


async def test_pre_p53_run_is_labelled_and_has_no_table(db_session: AsyncSession) -> None:
    await make_schedule_run(db_session, is_active=True, current_week=TEST_WEEK)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = (await client.get("/dashboard/completing-within-year")).json()
        summary = (await client.get("/schedule-runs/active")).json()
        drill = (
            await client.get(
                "/dashboard/delivery-by-year/projects", params={"kind": "not_placed"}
            )
        ).json()
    assert body["delivery_by_year"] is None
    assert body["delivery_by_year_unavailable"] == "pre_p53_run"
    assert body["rules_label"] == PRE_P53_RULES_LABEL
    assert summary["pre_p53"] is True and summary["rules_label"] == PRE_P53_RULES_LABEL
    assert drill["delivery_by_year_unavailable"] == "pre_p53_run" and drill["rows"] == []


async def test_no_active_run_table_unavailable(db_session: AsyncSession) -> None:
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = (await client.get("/dashboard/completing-within-year")).json()
    assert body["delivery_by_year"] is None
    assert body["delivery_by_year_unavailable"] == "no_active_run"


# --- weekly rollover ---------------------------------------------------------------------


async def test_rollover_not_needed_without_active_run(db_session: AsyncSession) -> None:
    assert await week_rollover.ensure_week_rollover(db_session) == "not_needed"
    assert (await db_session.execute(select(PlanWeekRollover))).first() is None


async def test_rollover_not_needed_when_current(db_session: AsyncSession) -> None:
    await make_schedule_run(db_session, is_active=True, current_week=TEST_WEEK)
    assert await week_rollover.ensure_week_rollover(db_session) == "not_needed"


async def test_rollover_queues_one_greedy_run_then_defers(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[str] = []
    monkeypatch.setattr(
        week_rollover, "dispatch_greedy", lambda run_id, **_kw: sent.append(run_id) or "task-1"
    )
    await make_schedule_run(db_session, is_active=True, current_week=TEST_WEEK - 1)
    assert await week_rollover.ensure_week_rollover(db_session) == "queued"
    runs = (
        await db_session.execute(
            select(ScheduleRun).where(ScheduleRun.trigger_reason == "week_rollover")
        )
    ).scalars().all()
    assert len(runs) == 1
    run = runs[0]
    assert (run.solver_type, run.current_week, run.triggered_by_user_id) == (
        SolverType.GREEDY,
        TEST_WEEK,
        None,
    )
    assert run.horizon_weeks == TEST_WEEK + 260 and run.rules_epoch == "p53"
    row = await db_session.get(PlanWeekRollover, TEST_WEEK)
    assert row is not None and (row.attempts, row.status, row.plan_year) == (1, "queued", 2026)
    assert sent == [str(run.id)]
    # The run at the calendar week is in flight: a second tick adds nothing.
    assert await week_rollover.ensure_week_rollover(db_session) == "not_needed"
    assert len(
        (
            await db_session.execute(
                select(ScheduleRun).where(ScheduleRun.trigger_reason == "week_rollover")
            )
        ).scalars().all()
    ) == 1


async def test_rollover_failed_after_three_failed_attempts(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(week_rollover, "dispatch_greedy", lambda run_id, **_kw: "task")
    await make_schedule_run(db_session, is_active=True, current_week=TEST_WEEK - 1)
    for attempt in range(1, 4):
        assert await week_rollover.ensure_week_rollover(db_session) == "queued"
        run = (
            await db_session.execute(
                select(ScheduleRun)
                .where(ScheduleRun.trigger_reason == "week_rollover")
                .order_by(ScheduleRun.version.desc())
            )
        ).scalars().first()
        assert run is not None
        run.status = ScheduleRunStatus.FAILED
        row = await db_session.get(PlanWeekRollover, TEST_WEEK)
        assert row is not None and row.attempts == attempt
        row.last_attempt_at = datetime.now(UTC) - timedelta(hours=1)
        await db_session.flush()
    assert await week_rollover.ensure_week_rollover(db_session) == "failed"
    assert await week_rollover.rollover_failed_for_week(db_session, TEST_WEEK)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        me = (await client.get("/me")).json()
    assert me["plan_week"]["status"] == "failed"


async def test_rollover_retry_waits_30_minutes(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(week_rollover, "dispatch_greedy", lambda run_id, **_kw: "task")
    await make_schedule_run(db_session, is_active=True, current_week=TEST_WEEK - 1)
    assert await week_rollover.ensure_week_rollover(db_session) == "queued"
    run = (
        await db_session.execute(
            select(ScheduleRun).where(ScheduleRun.trigger_reason == "week_rollover")
        )
    ).scalar_one()
    run.status = ScheduleRunStatus.FAILED
    await db_session.flush()
    assert await week_rollover.ensure_week_rollover(db_session) == "deferred"


# --- bounds and the Commercialized stamp ------------------------------------------------


async def test_target_end_bound_is_relative(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project = await stepped_project(db_session, hub, name="Target")
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        ok = await client.patch(
            f"/projects/{project.id}", json={"target_end_week": TEST_WEEK + 520}
        )
        too_far = await client.patch(
            f"/projects/{project.id}", json={"target_end_week": TEST_WEEK + 521}
        )
    assert ok.status_code == 200, ok.text
    assert too_far.status_code == 422
    assert too_far.json()["code"] == "TARGET_END_OUT_OF_RANGE"


async def test_commercialized_stamps_actual_end_week(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project = await stepped_project(db_session, hub, name="Shipping")
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.patch(
            f"/projects/{project.id}", json={"status": ProjectStatus.COMMERCIALIZED.value}
        )
    assert r.status_code == 200, r.text
    await db_session.refresh(project)
    assert project.actual_end_week == TEST_WEEK


async def test_run_in_2027_uses_the_absolute_week(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pin 53 (4 Jan 2027): the run stores week 53, H = 53 + 260, the plan
    year is 2027 and the table starts at 2027 (I57, I58)."""

    monkeypatch.setenv("RPD_CURRENT_WEEK", "53")
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session, current_week=53)
    assert (schedule_input.horizon_weeks, schedule_input.within_year_week) == (313, 104)
    run = await persist_schedule_output(
        db_session,
        schedule_input,
        run_greedy_sgs(schedule_input),
        solver_type=SolverType.GREEDY,
        trigger_reason="test",
        activate=True,
    )
    assert (run.current_week, run.horizon_weeks) == (53, 313)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = (await client.get("/dashboard/completing-within-year")).json()
        me = (await client.get("/me")).json()
        gantt = (await client.get("/gantt", params={"limit": 5})).json()
    assert me["plan_week"]["status"] == "current"
    table = body["delivery_by_year"]
    assert table["base_year"] == 2027 and table["rows"][0]["year"] == 2027
    assert table["rows"][0]["total"] == body["within_year_count"]
    assert (gantt["plan_year_start_week"], gantt["plan_year_end_week"]) == (53, 104)
    assert gantt["last_finish_week"] % 52 == 0 and gantt["last_finish_week"] >= 104
    assert gantt["weekly_active_counts"][0]["week"] == 53
