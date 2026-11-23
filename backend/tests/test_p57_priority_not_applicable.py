"""P57-T02 (ADR 0067, DOMAIN_RULES "Priority not applicable"): a Commercialized
or Cancelled project's effective priority is NULL ("Not applicable"). The
stored priority is kept; every by-priority count / filter / export uses the
effective value; a priority change on such a project is 409
`PRIORITY_NOT_APPLICABLE` (an unchanged round-trip still succeeds).
"""

from __future__ import annotations

import csv
import io
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects import postgresql

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.enums import (
    HubName,
    LabRegion,
    ProjectPriority,
    ProjectStatus,
    RoleName,
)
from models.schedule import ScheduleRunProjectOutcome
from scheduling.weeks import PLAN_YEAR_WEEKS
from schemas.dashboard import ProjectFilterRow
from services import priority_move
from services.capacity_priority import PRIORITY_BUCKET_LABELS, PRIORITY_BUCKETS, priority_bucket
from services.export_builder import rows_from_models
from services.priority_applicability import (
    NOT_APPLICABLE_FILTER,
    PRIORITY_NOT_APPLICABLE_STATUSES,
    effective_priority,
    effective_priority_display,
    effective_priority_expr,
    priority_applicable,
    priority_filter_predicate,
    served_priority_label,
)
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import act_as, client_for, stepped_project
from workers.schedule_tasks import run_greedy_schedule

NA = "Not applicable"


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(
        run_greedy_schedule,
        "delay",
        lambda *a, **k: calls.append((a, k)) or SimpleNamespace(id=f"t-{len(calls)}"),
    )
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return calls


# --- helper ---------------------------------------------------------------------------


def test_statuses_are_commercialized_and_cancelled():
    assert PRIORITY_NOT_APPLICABLE_STATUSES == {
        ProjectStatus.COMMERCIALIZED,
        ProjectStatus.CANCELLED,
    }


@pytest.mark.parametrize("status", list(ProjectStatus))
def test_effective_priority(status):
    na = status in (ProjectStatus.COMMERCIALIZED, ProjectStatus.CANCELLED)
    assert priority_applicable(status) is (not na)
    assert priority_applicable(status.value) is (not na)  # stored string
    expected = None if na else ProjectPriority.P1
    assert effective_priority(status, ProjectPriority.P1) == expected
    assert effective_priority(status.value, "P4") == (None if na else "P4")
    p1_label = dc.PRIORITY_LABELS["P1"]
    assert served_priority_label(status, ProjectPriority.P1) == (NA if na else p1_label)
    assert effective_priority_display(status, ProjectPriority.P4) == (NA if na else "P4")


def test_unknown_or_missing_status_keeps_the_stored_priority():
    assert effective_priority(None, "P2") == "P2"
    assert effective_priority("Not a status", "P2") == "P2"
    assert effective_priority_display(ProjectStatus.IN_QUEUE, None) == ""


def test_sql_expressions_are_bound_case_and_or():
    sql = str(effective_priority_expr().compile(dialect=postgresql.dialect()))
    assert sql.startswith("CASE WHEN (projects.status IN") and "ELSE projects.priority" in sql
    assert priority_filter_predicate(None) is None and priority_filter_predicate([]) is None
    both = str(
        priority_filter_predicate(
            [ProjectPriority.Q, NOT_APPLICABLE_FILTER], queue_includes_unset=True
        ).compile(dialect=postgresql.dialect())
    )
    # Bands on the effective value, Queue's "no priority" only when applicable,
    # plus the not_applicable statuses. Values are bound, never inlined.
    assert both.count("CASE WHEN") == 1 and "projects.priority IS NULL" in both
    assert "Commercialized" not in both and "POSTCOMPILE" in both


def test_capacity_bucket_and_label():
    assert PRIORITY_BUCKETS[-1] == "NA" and PRIORITY_BUCKET_LABELS["NA"] == NA
    assert priority_bucket(ProjectPriority.P1, ProjectStatus.COMMERCIALIZED) == "NA"
    assert priority_bucket(ProjectPriority.P4, "Cancelled") == "NA"
    assert priority_bucket(None, ProjectStatus.IN_QUEUE) == "Queue"


# --- served surfaces -------------------------------------------------------------------


async def _world(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(db_session, hub, name="NA Leader")

    async def mk(name, status, priority):
        return await stepped_project(
            db_session, hub, name=name, leader=leader, status=status, priority=priority
        )

    p = SimpleNamespace(
        live_p1=await mk("Live P1", ProjectStatus.IN_DEVELOPMENT, ProjectPriority.P1),
        live_p4=await mk("Live P4", ProjectStatus.IN_QUEUE, ProjectPriority.P4),
        comm_p1=await mk("Comm P1", ProjectStatus.COMMERCIALIZED, ProjectPriority.P1),
        comm_p3=await mk("Comm P3", ProjectStatus.COMMERCIALIZED, ProjectPriority.P3),
        canc_p4=await mk("Canc P4", ProjectStatus.CANCELLED, ProjectPriority.P4),
    )
    week = 31
    run = await make_schedule_run(
        db_session,
        is_active=True,
        rules_epoch="p53",
        current_week=week,
        horizon_weeks=week + 5 * PLAN_YEAR_WEEKS,
    )

    def outcome(project, **kw):
        db_session.add(
            ScheduleRunProjectOutcome(
                schedule_run_id=run.id,
                project_id=project.id,
                priority_at_run=project.priority.value,
                left_out=False,
                blocked=False,
                **kw,
            )
        )

    # Live P1 and a Commercialized P1 / P3 delivered within the plan year.
    outcome(p.live_p1, within_year=True, projected_end_week=44, last_step_end_week=44)
    outcome(p.comm_p1, within_year=True, projected_end_week=None, last_step_end_week=None)
    outcome(p.comm_p3, within_year=True, projected_end_week=None, last_step_end_week=None)
    await db_session.flush()
    return p, run


def _ids(rows, key="project_id"):
    return {r[key] for r in rows}


async def test_dashboard_register_filter_and_served_fields(db_session):
    p, _ = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        p4 = (await client.get("/dashboard/projects", params={"priority": "P4"})).json()
        p1 = (await client.get("/dashboard/projects", params={"priority": "P1"})).json()
        na = await client.get("/dashboard/projects", params={"priority": "not_applicable"})
        everything = (await client.get("/dashboard/projects")).json()
    # A P4 filter never matches a Cancelled P4; P1 never a Commercialized P1.
    assert _ids(p4["rows"]) == {str(p.live_p4.id)}
    assert _ids(p1["rows"]) == {str(p.live_p1.id)}
    assert na.status_code == 200
    assert _ids(na.json()["rows"]) == {str(p.comm_p1.id), str(p.comm_p3.id), str(p.canc_p4.id)}
    rows = {r["project_id"]: r for r in everything["rows"]}
    comm = rows[str(p.comm_p1.id)]
    # Register rows keep the STORED value (round-trip) and flag it.
    assert comm["priority"] == "P1" and comm["priority_applicable"] is False
    assert comm["priority_label"] == NA
    live = rows[str(p.live_p1.id)]
    assert live["priority_applicable"] is True
    assert live["priority_label"] == dc.PRIORITY_LABELS["P1"]


async def test_projects_list_and_read_serve_the_flag(db_session):
    p, _ = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        p4 = (await client.get("/projects", params={"priority": "P4"})).json()
        na = (await client.get("/projects", params={"priority": "not_applicable"})).json()
        one = (await client.get(f"/projects/{p.canc_p4.id}")).json()
        bad = await client.get("/projects", params={"priority": "P9"})
    assert _ids(p4, "id") == {str(p.live_p4.id)}
    assert _ids(na, "id") == {str(p.comm_p1.id), str(p.comm_p3.id), str(p.canc_p4.id)}
    assert one["priority"] == "P4" and one["priority_applicable"] is False
    assert bad.status_code == 422


async def test_gantt_filter_and_served_fields(db_session):
    p, _ = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        p1 = (await client.get("/gantt", params={"priority": "P1"})).json()
        na = (await client.get("/gantt", params={"priority": "not_applicable"})).json()
    assert _ids(p1["rows"]) == {str(p.live_p1.id)}
    na_rows = {r["project_id"]: r for r in na["rows"]}
    assert set(na_rows) <= {str(p.comm_p1.id), str(p.comm_p3.id), str(p.canc_p4.id)}
    assert str(p.comm_p1.id) in na_rows
    row = na_rows[str(p.comm_p1.id)]
    assert row["priority_applicable"] is False and row["priority_label"] == NA


async def test_priority_delivery_and_delivery_by_year_split(db_session):
    p, _ = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = (await client.get("/dashboard/completing-within-year")).json()
        drill = (
            await client.get(
                "/dashboard/delivery-by-year/projects",
                params={"kind": "by_end_of_year", "year": 2026, "band": "P1"},
            )
        ).json()
    bands = {b["priority"]: b for b in body["priority_delivery"]}
    # Only the live P1 / P4 are under a band; Commercialized / Cancelled none.
    assert bands["P1"]["total"] == 1 and bands["P1"]["delivered_total"] == 0
    assert bands["P3"]["total"] == 0
    assert bands["P4"]["total"] == 1
    assert sum(b["total"] for b in bands.values()) == 2
    # Delivery by year: the Commercialized P1 / P3 move to Other (I59 holds).
    table = body["delivery_by_year"]
    y0 = next(r for r in table["rows"] if r["kind"] == "by_end_of_year")
    assert (y0["p1"], y0["p2"], y0["p3"], y0["other"], y0["total"]) == (1, 0, 0, 2, 3)
    for r in table["rows"]:
        assert r["p1"] + r["p2"] + r["p3"] + r["other"] == r["total"]
    rows = {r["project_id"]: r for r in body["rows"]}
    comm = rows[str(p.comm_p1.id)]
    assert comm["priority"] is None and comm["priority_at_run"] is None
    assert comm["priority_applicable"] is False and comm["priority_label"] == NA
    assert rows[str(p.live_p1.id)]["priority_at_run"] == "P1"
    # The P1 drill cell lists the live P1 only.
    assert _ids(drill["rows"]) == {str(p.live_p1.id)}


async def test_capacity_split_has_not_applicable_bucket(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        hubs = (await client.get("/capacity/hubs")).json()
    assert hubs["priority_bucket_labels"]["NA"] == NA
    for row in hubs["rows"]:
        split = row["design_load_by_priority"]
        assert list(split) == list(PRIORITY_BUCKETS)
        assert round(sum(split.values()), 2) == row["design_load_weeks"]


async def test_matrix_summary_counts_effective_priority(db_session):
    p, _ = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        summary = (await client.get("/priorities/summary")).json()
        matrix = (await client.get("/priorities")).json()
    assert summary["set_priority_counts"] == {"P1": 1, "P4": 1}
    assert summary["priority_not_applicable_count"] == 3
    rows = {r["project_id"]: r for r in matrix}
    assert rows[str(p.canc_p4.id)]["set_priority"] == "P4"
    assert rows[str(p.canc_p4.id)]["priority_applicable"] is False


# --- exports -----------------------------------------------------------------------------


def test_export_rows_show_not_applicable_cell():
    base = dict(
        project_name="X", hub="R&D-Greece", category=None, is_vip=False,
        tracking_status="idle", external_code=None, type=None, region="Greece",
        leader_name=None, leader_engineer_id=None, current_step_code=None,
        current_step_name=None, end_week=None, outcome=None, counts_toward_year=None,
        not_scheduled_priority=None, reg_year=None, carry_over=False, plant=None,
        requesting_department=None, product_type=None, priority_rank=None,
        actual_start_week=None, actual_end_week=None, design_effort_weeks=None,
        lab_effort_weeks=None, design_weeks_calculated=None, lab_weeks_calculated=None,
        expected_status=None, status_mismatch=False, band_rank=None, band_size=None,
    )  # fmt: skip
    fields = ProjectFilterRow.model_fields
    kw = {k: v for k, v in base.items() if k in fields}
    comm = ProjectFilterRow.model_construct(
        project_id="a", status=ProjectStatus.COMMERCIALIZED, priority=ProjectPriority.P1,
        priority_applicable=False, priority_label=NA, **kw,
    )  # fmt: skip
    live = ProjectFilterRow.model_construct(
        project_id="b", status=ProjectStatus.IN_QUEUE, priority=ProjectPriority.P4,
        priority_applicable=True, priority_label="Not scheduled", **kw,
    )  # fmt: skip
    _, rows = rows_from_models([comm, live], ProjectFilterRow)
    assert rows[0]["priority"] == NA and rows[1]["priority"] == "P4"


async def test_dashboard_csv_export_priority_cell(db_session):
    p, _ = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.get("/exports/dashboard", params={"format": "csv"})
    assert resp.status_code == 200
    text = resp.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    by_name = {r[1]: r for r in rows if len(r) > 1}
    assert NA in by_name[p.comm_p1.name]
    assert NA in by_name[p.canc_p4.name]
    assert NA not in by_name[p.live_p4.name] and "P4" in by_name[p.live_p4.name]


# --- writes ------------------------------------------------------------------------------


async def test_patch_priority_change_is_409_but_round_trip_succeeds(db_session, dispatch):
    p, _ = await _world(db_session)
    # Super Admin: setting Cancelled is Super-Admin only (ADR 0058).
    await act_as(db_session, RoleName.SUPER_ADMIN)
    url = f"/projects/{p.comm_p1.id}"
    async with client_for(db_session) as client:
        changed = await client.patch(url, json={"priority": "P2"})
        same = await client.patch(url, json={"priority": "P1"})
        null = await client.patch(url, json={"priority": None})
        move = await client.post(f"{url}/priority", json={"priority": "P2"})
        preview = await client.post(f"{url}/priority/preview", json={"priority": "P2"})
        to_cancelled = await client.patch(
            f"/projects/{p.live_p4.id}", json={"status": "Cancelled", "priority": "P3"}
        )
    assert changed.status_code == 409, changed.text
    assert changed.json()["code"] == "PRIORITY_NOT_APPLICABLE"
    assert "Commercialized or Cancelled" in changed.json()["detail"]
    assert same.status_code == 200, same.text
    assert null.status_code == 200, null.text  # the "Not applicable" round-trip
    assert move.status_code == 409 and move.json()["code"] == "PRIORITY_NOT_APPLICABLE"
    assert preview.status_code == 409 and preview.json()["code"] == "PRIORITY_NOT_APPLICABLE"
    # Moving INTO Cancelled while changing the priority is refused too.
    assert to_cancelled.status_code == 409
    await db_session.refresh(p.comm_p1)
    await db_session.refresh(p.live_p4)
    # The stored value is kept (never cleared).
    assert p.comm_p1.priority == ProjectPriority.P1
    assert (p.live_p4.status, p.live_p4.priority) == (ProjectStatus.IN_QUEUE, ProjectPriority.P4)


async def test_patch_status_back_to_schedulable_may_set_priority(db_session, dispatch):
    p, _ = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{p.comm_p3.id}", json={"status": "In Development", "priority": "P2"}
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["priority"] == "P2" and body["priority_applicable"] is True


# --- What-if -----------------------------------------------------------------------------


async def test_whatif_results_serve_no_band_for_commercialized(db_session):
    p, _ = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.post("/whatif/simulate", json={"scenario": {}})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    rows = {r["project_id"]: r for r in body["projects"]}
    for project in (p.comm_p1, p.comm_p3, p.canc_p4):
        if str(project.id) in rows:
            r = rows[str(project.id)]
            assert r["priority"] is None and r["priority_applicable"] is False
    assert rows[str(p.comm_p1.id)]["priority_applicable"] is False
    assert rows[str(p.live_p1.id)]["priority"] == "P1"
    assert rows[str(p.live_p1.id)]["priority_applicable"] is True
    for r in body["delivery_by_year"]["rows"]:
        assert r["p1"] + r["p2"] + r["p3"] + r["other"] == r["total"]
