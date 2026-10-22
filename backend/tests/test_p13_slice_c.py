"""P13 wave 2, slice C backend (docs/API_CONTRACT_P13.md §7):

- T13 Gantt: row meta (`external_code`, `type`, `leader_name` under the OQ #8
  rule, `design_weeks` / `lab_weeks` / `total_weeks`), the toolbar filters,
  `sort`, and `weekly_active_counts` reconciled with the step rows.
- T14 Matrix (`GET /priorities`): `status`, `type`, `leader_name`, `rank`, and
  the `type` / `status_` / `q` filters.
- T15 Shell: `GET /export-jobs` (own jobs; Admin all) and `current_week` /
  `weeks_left_in_year` on `GET /me`.

Seed: the prototype demo seed, scheduled with the real greedy scheduler and
activated inside the per-test savepoint (same as `test_p13_region_filter.py`).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.engineer import Engineer
from models.enums import (
    ExportFormat,
    ExportJobStatus,
    ExportSurface,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    SolverType,
)
from models.export import ExportJob
from models.project import Project
from scheduling.greedy import run_greedy_sgs
from seed import seed_demo_data
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_user
from tests.rubric_helpers import INITIAL_KEYS

_FINANCIAL = ("customer_name", "tcogs", "selling_price", "gross_margin")


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


async def _act_as(db_session, *roles: RoleName, hub_ids=None, email=None):
    user = await make_user(
        db_session, *roles, email=email, hub_ids=hub_ids or [], hub_scope_all=hub_ids is None
    )
    override_current_principal(
        make_principal(
            *roles, user_id=user.id, email=user.email, hub_scope_all=hub_ids is None,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def _seeded(db_session) -> SimpleNamespace:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session)
    output = run_greedy_sgs(schedule_input)
    run = await persist_schedule_output(
        db_session, schedule_input, output, solver_type=SolverType.GREEDY,
        trigger_reason="test", activate=True,
    )
    return SimpleNamespace(hubs=hubs, run=run)


async def _get(client: AsyncClient, path: str, **params):
    resp = await client.get(path, params={k: str(v) for k, v in params.items()})
    assert resp.status_code == 200, (path, resp.text)
    return resp.json()


async def _gantt(client: AsyncClient, **params):
    return await _get(client, "/gantt", limit=500, **params)


async def _projects_by_id(db_session) -> dict[str, Project]:
    return {str(p.id): p for p in (await db_session.execute(select(Project))).scalars()}


def _ids(rows) -> list[str]:
    return [r["project_id"] for r in rows]


# --- T13: Gantt row meta -----------------------------------------------------------------


async def test_gantt_row_meta_matches_project_and_step_rows(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _gantt(client)
    projects = await _projects_by_id(db_session)
    assert body["rows"]
    saw_lab = False
    leader_names = {
        e.id: e.name for e in (await db_session.execute(select(Engineer))).scalars().all()
    }
    for row in body["rows"]:
        project = projects[row["project_id"]]
        assert row["external_code"] == project.external_code
        assert row["type"] == (project.type.value if project.type else None)
        assert row["leader_engineer_id"] == (
            str(project.leader_engineer_id) if project.leader_engineer_id else None
        )
        # ADR 0028: the leader's name is served to any reader.
        assert row["leader_name"] == (
            leader_names[project.leader_engineer_id] if project.leader_engineer_id else None
        )
        live = [s for s in row["steps"] if not s["skipped"]]
        if not row["steps"]:
            assert (row["design_weeks"], row["lab_weeks"], row["total_weeks"]) == (
                None, None, None,
            )
            continue
        design = sum(s["duration_weeks"] for s in live if s["kind"] == "design")
        lab = sum(s["duration_weeks"] for s in live if s["kind"] == "lab")
        assert row["design_weeks"] == design
        assert row["lab_weeks"] == lab
        assert row["total_weeks"] == sum(s["duration_weeks"] for s in live)
        assert row["total_weeks"] >= design + lab
        saw_lab = saw_lab or lab > 0
        for key in _FINANCIAL:
            assert not any(key in k for k in row), key
    assert saw_lab


async def test_gantt_design_and_lab_weeks_reconcile_with_capacity_design_load(db_session):
    """Same basis as the Capacity design load (I6): Σ per hub agrees."""

    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        rows = (await _gantt(client))["rows"]
        capacity = await _get(client, "/capacity/hub-load")
    design_by_hub: dict[str, int] = {}
    for row in rows:
        # P29 (ADR 0042): Capacity rows are capacity hubs (OEM -> R&D-Greece).
        key = dc.capacity_hub_name(row["hub"])
        design_by_hub[key] = design_by_hub.get(key, 0) + (row["design_weeks"] or 0)
    for hub_row in capacity["rows"]:
        assert design_by_hub.get(hub_row["hub"], 0) == hub_row["design_load_weeks"], hub_row["hub"]


async def test_gantt_leader_name_is_served_to_every_reader(db_session):
    await _seeded(db_session)
    user = await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    engineer = (
        await db_session.execute(
            select(Engineer).join(Project, Project.leader_engineer_id == Engineer.id).limit(1)
        )
    ).scalars().first()
    engineer.user_id = user.id
    await db_session.flush()
    projects = await _projects_by_id(db_session)
    async with _client(db_session) as client:
        rows = (await _gantt(client))["rows"]
        matrix = await _get(client, "/priorities")
    seen = 0
    for r in [*rows, *matrix]:
        if projects[r["project_id"]].leader_engineer_id == engineer.id:
            assert r["leader_name"] == engineer.name
            seen += 1
        else:
            assert r["leader_name"] is not None  # ADR 0028: every reader sees leader names
    assert seen >= 2  # on both surfaces


# --- T13: weekly active counts -----------------------------------------------------------


def _recount(rows) -> dict[int, tuple[int, int]]:
    out = {w: [0, 0] for w in range(1, dc.WITHIN_YEAR_WEEK + 1)}
    for row in rows:
        col = 1 if row["workflow_id"] == "OEM" else 0
        for s in row["steps"]:
            if s["skipped"]:
                continue
            for w in range(max(1, s["planned_start_week"]),
                           min(dc.WITHIN_YEAR_WEEK, s["planned_end_week"]) + 1):
                out[w][col] += 1
    return {w: (v[0], v[1]) for w, v in out.items()}


async def test_weekly_active_counts_reconcile_with_step_rows(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        full = await _gantt(client)
        india = await _gantt(client, region="India")
        greece = await _gantt(client, region="Greece")
        paged = await _get(client, "/gantt", limit=3, region="India")
    for body in (full, india, greece):
        counts = body["weekly_active_counts"]
        assert [c["week"] for c in counts] == list(range(1, dc.WITHIN_YEAR_WEEK + 1))
        assert {c["week"]: (c["pdd"], c["oem"]) for c in counts} == _recount(body["rows"])
    assert sum(c["pdd"] + c["oem"] for c in full["weekly_active_counts"]) > 0
    # Region slices add up to the portfolio (Romania is the remainder).
    romania = await _counts_for(db_session, "Romania")
    for c, i, g, r in zip(
        full["weekly_active_counts"], india["weekly_active_counts"],
        greece["weekly_active_counts"], romania, strict=True,
    ):
        assert c["pdd"] == i["pdd"] + g["pdd"] + r["pdd"]
        assert c["oem"] == i["oem"] + g["oem"] + r["oem"]
    # Counts cover the whole filtered set, not the page.
    assert len(paged["rows"]) == 3 < paged["total_count"]
    assert paged["weekly_active_counts"] == india["weekly_active_counts"]


async def _counts_for(db_session, region: str):
    async with _client(db_session) as client:
        return (await _gantt(client, region=region))["weekly_active_counts"]


async def test_weekly_active_counts_follow_filters_and_empty_without_run(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        cat_b = await _gantt(client, category="B")
        nothing = await _gantt(client, q="no-such-project-zzz")
    assert {c["week"]: (c["pdd"], c["oem"]) for c in cat_b["weekly_active_counts"]} == (
        _recount(cat_b["rows"])
    )
    assert nothing["total_count"] == 0
    assert all(c["pdd"] == c["oem"] == 0 for c in nothing["weekly_active_counts"])
    assert len(nothing["weekly_active_counts"]) == dc.WITHIN_YEAR_WEEK


async def test_gantt_without_active_run_serves_empty_counts(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client, "/gantt")
    assert body == {
        "has_active_schedule_run": False, "schedule_run_version": None, "total_count": 0,
        "rows": [], "weekly_active_counts": [],
    }


# --- T13: Gantt filters ------------------------------------------------------------------


async def test_gantt_field_filters_are_exact_subsets(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    projects = await _projects_by_id(db_session)
    async with _client(db_session) as client:
        everything = (await _gantt(client))["rows"]
        assert everything

        def expect(pred) -> set[str]:
            return {r["project_id"] for r in everything if pred(projects[r["project_id"]], r)}

        for t in {r["type"] for r in everything if r["type"]}:
            rows = (await _gantt(client, type=t))["rows"]
            assert set(_ids(rows)) == expect(lambda p, r, t=t: r["type"] == t)
        for c in {r["category"] for r in everything if r["category"]}:
            rows = (await _gantt(client, category=c))["rows"]
            assert set(_ids(rows)) == expect(lambda p, r, c=c: r["category"] == c)
        for pr in {r["priority"] for r in everything if r["priority"]}:
            rows = (await _gantt(client, priority=pr))["rows"]
            assert set(_ids(rows)) == expect(
                lambda p, r, pr=pr: r["priority"] == pr
                or (pr == "Q" and r["priority"] is None)  # Queue bucket
            )
        statuses = {p.status for p in projects.values()}
        assert len(statuses) > 1
        for st in statuses:
            body = await _gantt(client, status_=st.value)
            assert set(_ids(body["rows"])) == expect(lambda p, r, st=st: p.status == st)
            assert body["total_count"] == len(body["rows"])
        leader = next(
            projects[r["project_id"]].leader_engineer_id
            for r in everything if projects[r["project_id"]].leader_engineer_id
        )
        rows = (await _gantt(client, leader_engineer_id=leader))["rows"]
        assert rows and set(_ids(rows)) == expect(lambda p, r: p.leader_engineer_id == leader)
        # ANDed: type + status together.
        t = next(r["type"] for r in everything if r["type"])
        both = (await _gantt(client, type=t, status_=ProjectStatus.IN_DEVELOPMENT.value))["rows"]
        assert set(_ids(both)) == expect(
            lambda p, r: r["type"] == t and p.status == ProjectStatus.IN_DEVELOPMENT
        )
        for bad in ({"type": "XX"}, {"status_": "Nope"}, {"priority": "P9"}, {"sort": "score"},
                    {"category": "Z"}, {"current_step": "X" * 11}):
            assert (await client.get("/gantt", params=bad)).status_code == 422, bad


async def test_gantt_q_matches_name_and_code_and_escapes_wildcards(db_session):
    await _seeded(db_session)
    project = (
        await db_session.execute(select(Project).order_by(Project.name).limit(1))
    ).scalar_one()
    project.external_code = "ZZ-100%_X"
    await db_session.flush()
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        everything = (await _gantt(client))["rows"]
        needle = project.name[1:5].upper()
        got = (await _gantt(client, q=needle))["rows"]
        assert set(_ids(got)) == {
            r["project_id"] for r in everything
            if needle.lower() in r["project_name"].lower()
            or needle.lower() in (r["external_code"] or "").lower()
        }
        assert _ids((await _gantt(client, q="zz-100%_x"))["rows"]) == [str(project.id)]
        assert _ids((await _gantt(client, q="0%_"))["rows"]) == [str(project.id)]
        assert (await _gantt(client, q="   "))["total_count"] == len(everything)
        assert (await client.get("/gantt", params={"q": "x" * 101})).status_code == 422


async def test_gantt_current_step_matches_the_register_rule(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        register = (await _get(client, "/dashboard/projects"))["rows"]
        steps = {r["current_step_code"] for r in register if r["current_step_code"]}
        assert steps
        for code in steps:
            rows = (await _gantt(client, current_step=code))["rows"]
            assert set(_ids(rows)) == {
                r["project_id"] for r in register if r["current_step_code"] == code
            }, code
        none = await _gantt(client, current_step="NOPE")
        assert none["total_count"] == 0 and none["rows"] == []


async def test_gantt_filters_never_widen_the_scope(db_session):
    w = await _seeded(db_session)
    greece = w.hubs["R&D-Greece"]
    outside = (
        await db_session.execute(
            select(Project).where(
                Project.hub_id != greece.id, Project.leader_engineer_id.is_not(None)
            ).limit(1)
        )
    ).scalar_one()
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with _client(db_session) as client:
        by_leader = await _gantt(client, leader_engineer_id=outside.leader_engineer_id)
        by_name = await _gantt(client, q=outside.name)
        mine = await _gantt(client)
    assert all(r["hub"] == "R&D-Greece" for r in mine["rows"])
    assert str(outside.id) not in _ids(by_leader["rows"]) + _ids(by_name["rows"])
    assert set(_ids(by_leader["rows"])) <= set(_ids(mine["rows"]))


async def test_gantt_queue_tab_is_q_or_no_priority(db_session):
    """P13: `priority=Q` is the Queue bucket (Q OR null), as Capacity and the
    Board classify it; P1..P4 stay exact; `sort=priority` groups null with Q."""

    await _seeded(db_session)
    rows = list((await db_session.execute(select(Project).order_by(Project.name))).scalars())
    # Make sure both a Q and a null-priority project exist, whatever the seed has.
    q_project, null_project = rows[0], rows[1]
    q_project.priority = ProjectPriority.Q
    null_project.priority = None
    await db_session.flush()
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    projects = await _projects_by_id(db_session)
    async with _client(db_session) as client:
        queue = await _gantt(client, priority="Q")
        p1 = await _gantt(client, priority="P1")
        by_priority = (await _gantt(client, sort="priority"))["rows"]
    expected_queue = {
        pid for pid, p in projects.items() if p.priority in (ProjectPriority.Q, None)
    }
    assert set(_ids(queue["rows"])) == expected_queue
    assert {str(q_project.id), str(null_project.id)} <= expected_queue
    assert queue["total_count"] == len(expected_queue)
    assert set(_ids(p1["rows"])) == {
        pid for pid, p in projects.items() if p.priority == ProjectPriority.P1
    }
    # Queue rows (Q and null together) form one contiguous tail block.
    queue_bands = (ProjectPriority.Q, None)
    is_queue = [projects[r["project_id"]].priority in queue_bands for r in by_priority]
    first = is_queue.index(True)
    assert all(is_queue[first:]) and not any(is_queue[:first])


# --- T13: sort ---------------------------------------------------------------------------


async def test_gantt_sorts_and_pages_consistently(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        default = (await _gantt(client))["rows"]
        by_name = (await _gantt(client, sort="name"))["rows"]
        by_start = (await _gantt(client, sort="start"))["rows"]
        by_end = (await _gantt(client, sort="end"))["rows"]
        by_priority = (await _gantt(client, sort="priority"))["rows"]
        register = (await _get(client, "/dashboard/projects"))["rows"]
        pages = []
        for offset in range(0, len(default), 7):
            pages += (await _get(client, "/gantt", sort="end", limit=7, offset=offset))["rows"]
    assert _ids(default) == _ids(by_name)
    for rows in (by_start, by_end, by_priority):
        assert sorted(_ids(rows)) == sorted(_ids(default))
    assert _ids(pages) == _ids(by_end)

    def first_start(r):
        starts = [s["planned_start_week"] for s in r["steps"] if not s["skipped"]]
        return min(starts) if starts else None

    def non_decreasing_then_nulls(values):
        present = [v for v in values if v is not None]
        tail = values[len(present):]
        assert values[: len(present)] == present and all(v is None for v in tail)
        assert present == sorted(present)

    non_decreasing_then_nulls([first_start(r) for r in by_start])
    non_decreasing_then_nulls([r["projected_end_week"] for r in by_end])
    # Priority: band P1 → P4 → Q → none, then score (the register's rank) descending.
    band = {b: i for i, b in enumerate(dc.PRIORITY_ORDER)}
    rank = {r["project_id"]: r["priority_rank"] for r in register}
    keys = [
        (band.get(r["priority"], band["Q"]), rank[r["project_id"]] is None,
         rank[r["project_id"]] or 0)
        for r in by_priority
    ]
    assert keys == sorted(keys)


# --- T14: Matrix -------------------------------------------------------------------------


async def test_matrix_rows_gain_status_type_leader_and_rank(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    projects = await _projects_by_id(db_session)
    async with _client(db_session) as client:
        rows = await _get(client, "/priorities")
        india = await _get(client, "/priorities", region="India")
        one = await _get(client, f"/priorities/{rows[0]['project_id']}")
    for r in rows:
        p = projects[r["project_id"]]
        assert r["status"] == p.status.value
        assert r["type"] == (p.type.value if p.type else None)
        assert r["leader_engineer_id"] == (
            str(p.leader_engineer_id) if p.leader_engineer_id else None
        )
        assert (r["leader_name"] is not None) == (p.leader_engineer_id is not None)  # ADR 0028
        assert (r["rank"] is None) == (r["weighted_score"] is None)
    ranked = sorted((r for r in rows if r["rank"] is not None), key=lambda r: r["rank"])
    assert [r["rank"] for r in ranked] == list(range(1, len(ranked) + 1))
    assert [r["weighted_score"] for r in ranked] == sorted(
        (r["weighted_score"] for r in ranked), reverse=True
    )
    # Rank is within the filtered set.
    india_ranks = sorted(r["rank"] for r in india if r["rank"] is not None)
    assert india_ranks == list(range(1, len(india_ranks) + 1))
    assert len(india) < len(rows)
    # The single-row read has no list to rank within.
    assert one["rank"] is None and one["status"] == rows[0]["status"]


async def test_matrix_type_status_and_q_filters(db_session):
    await _seeded(db_session)
    project = (
        await db_session.execute(select(Project).order_by(Project.name).limit(1))
    ).scalar_one()
    project.external_code = "MX-7%_Q"
    await db_session.flush()
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    projects = await _projects_by_id(db_session)
    async with _client(db_session) as client:
        everything = await _get(client, "/priorities")
        for t in {r["type"] for r in everything if r["type"]}:
            rows = await _get(client, "/priorities", type=t)
            assert set(_ids(rows)) == {r["project_id"] for r in everything if r["type"] == t}
            ranks = sorted(r["rank"] for r in rows if r["rank"] is not None)
            assert ranks == list(range(1, len(ranks) + 1))
        for st in {r["status"] for r in everything}:
            rows = await _get(client, "/priorities", status_=st)
            assert set(_ids(rows)) == {r["project_id"] for r in everything if r["status"] == st}
        needle = project.name[1:5].upper()
        rows = await _get(client, "/priorities", q=needle)
        assert str(project.id) in _ids(rows)
        assert set(_ids(rows)) == {
            pid for pid, p in projects.items()
            if needle.lower() in p.name.lower()
            or needle.lower() in (p.external_code or "").lower()
        }
        assert _ids(await _get(client, "/priorities", q="mx-7%_q")) == [str(project.id)]
        assert _ids(await _get(client, "/priorities", q="7%_")) == [str(project.id)]
        assert len(await _get(client, "/priorities", q="  ")) == len(everything)
        for bad in ({"q": "x" * 101}, {"type": "XX"}, {"status_": "Nope"}):
            assert (await client.get("/priorities", params=bad)).status_code == 422, bad


async def test_matrix_hub_planner_filters_never_widen(db_session):
    w = await _seeded(db_session)
    greece = w.hubs["R&D-Greece"]
    outside = (
        await db_session.execute(select(Project).where(Project.hub_id != greece.id).limit(1))
    ).scalar_one()
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with _client(db_session) as client:
        rows = await _get(client, "/priorities", q=outside.name)
    assert str(outside.id) not in _ids(rows)
    assert all(r["hub"] == "R&D-Greece" for r in rows)


# --- T15: export jobs --------------------------------------------------------------------


def _job(user_id: uuid.UUID, surface: ExportSurface, fmt: ExportFormat, age_min: int,
         status: ExportJobStatus = ExportJobStatus.COMPLETED) -> ExportJob:
    return ExportJob(
        surface=surface, format=fmt, requested_by_user_id=user_id,
        filters={"hub_id": None}, status=status,
        created_at=datetime.now(UTC) - timedelta(minutes=age_min),
        row_count=5 if status == ExportJobStatus.COMPLETED else None,
        object_key="exports/x.csv" if status == ExportJobStatus.COMPLETED else None,
    )


async def test_export_jobs_lists_own_jobs_newest_first(db_session):
    me = await _act_as(db_session, RoleName.EXECUTIVE_VIEWER, email="me-jobs@example.com")
    other = await make_user(db_session, RoleName.PORTFOLIO_MANAGER, email="other-jobs@example.com")
    mine = [
        _job(me.id, ExportSurface.GANTT, ExportFormat.XLSX, 30),
        _job(me.id, ExportSurface.DASHBOARD, ExportFormat.CSV, 10, ExportJobStatus.QUEUED),
        _job(me.id, ExportSurface.MATRIX, ExportFormat.CSV, 20, ExportJobStatus.FAILED),
    ]
    theirs = _job(other.id, ExportSurface.CAPACITY, ExportFormat.CSV, 1)
    db_session.add_all([*mine, theirs])
    await db_session.flush()
    async with _client(db_session) as client:
        body = await _get(client, "/export-jobs")
        limited = await _get(client, "/export-jobs", limit=2)
        for bad in (0, 201, "x"):
            assert (await client.get("/export-jobs", params={"limit": bad})).status_code == 422
    assert [j["id"] for j in body] == [str(mine[1].id), str(mine[2].id), str(mine[0].id)]
    assert str(theirs.id) not in {j["id"] for j in body}
    assert [j["id"] for j in limited] == [str(mine[1].id), str(mine[2].id)]
    first = body[0]
    assert set(first) == {
        "id", "kind", "format", "status", "created_at", "completed_at", "row_count", "file_name",
    }
    assert (first["kind"], first["format"], first["status"]) == ("dashboard", "csv", "queued")
    by_id = {j["id"]: j for j in body}
    assert by_id[str(mine[0].id)]["file_name"] == "gantt-export.xlsx"
    assert by_id[str(mine[0].id)]["row_count"] == 5
    assert by_id[str(mine[2].id)]["file_name"] == "matrix-export.csv"


async def test_export_jobs_admin_sees_all_and_others_see_none(db_session):
    owner = await make_user(db_session, RoleName.PORTFOLIO_MANAGER, email="owner-jobs@example.com")
    job = _job(owner.id, ExportSurface.GANTT, ExportFormat.CSV, 5)
    db_session.add(job)
    await db_session.flush()
    for role in (RoleName.ADMIN, RoleName.SUPER_ADMIN):
        await _act_as(db_session, role, email=f"{role.name.lower()}-jobs@example.com")
        async with _client(db_session) as client:
            assert str(job.id) in {j["id"] for j in await _get(client, "/export-jobs")}
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[], email="hp-jobs@example.com")
    async with _client(db_session) as client:
        assert await _get(client, "/export-jobs") == []


async def test_export_jobs_requires_authentication(db_session):
    clear_current_principal_override()
    async with _client(db_session) as client:
        resp = await client.get("/export-jobs")
    assert resp.status_code == 401


async def test_export_jobs_file_name_matches_the_download_route(db_session, monkeypatch):
    me = await _act_as(db_session, RoleName.PORTFOLIO_MANAGER, email="dl-jobs@example.com")
    job = _job(me.id, ExportSurface.CAPACITY_PLANNING, ExportFormat.XLSX, 2)
    db_session.add(job)
    await db_session.flush()

    class _Obj:
        def stream(self, _size):
            yield b"PK"

        def close(self):
            pass

        def release_conn(self):
            pass

    class _Client:
        def get_object(self, _bucket, _key):
            return _Obj()

    monkeypatch.setattr("api.routers.exports.get_minio_client", lambda: _Client())
    monkeypatch.setattr(
        "api.routers.exports.get_minio_settings",
        lambda: SimpleNamespace(exports_bucket="exports"),
    )
    async with _client(db_session) as client:
        listed = (await _get(client, "/export-jobs"))[0]
        resp = await client.get(f"/exports/jobs/{job.id}/download")
    assert resp.status_code == 200
    assert resp.headers["content-disposition"] == f'attachment; filename="{listed["file_name"]}"'
    assert listed["file_name"] == "capacity_planning-export.xlsx"


# --- T15: /me ----------------------------------------------------------------------------


async def test_me_serves_current_week_and_weeks_left(db_session):
    await _act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with _client(db_session) as client:
        body = await _get(client, "/me")
    assert body["current_week"] == dc.CURRENT_WEEK
    assert body["weeks_left_in_year"] == max(0, 52 - dc.CURRENT_WEEK)
    assert body["weeks_left_in_year"] == dc.WITHIN_YEAR_WEEK - body["current_week"]


# --- P16-T01 (ADR 0029): served dimension table and per-row points -----------------------


async def test_priorities_dimensions_endpoint_and_row_points(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        table = await _get(client, "/priorities/dimensions")
        rows = await _get(client, "/priorities")
    assert table["total_weight"] == 295  # the initial rubric (ADR 0029 / 0037)
    assert table["rubric_version"] == 1
    dims = table["dimensions"]
    assert [d["key"] for d in dims] == list(INITIAL_KEYS)
    by_key = {d["key"]: d for d in dims}
    assert by_key["gross_margins"]["label"] == "Gross Profitability"
    assert by_key["profitability"]["label"] == "ROI"
    assert by_key["profitability"]["pillar"] == "Investment & Feasibility"
    assert by_key["three_year_volume"]["weight"] == 25
    assert by_key["capex_investment"]["scaled_weight"] == round(15 * 100 / 295, 2)
    assert set(by_key["strategic_project"]) == {"key", "label", "pillar", "weight", "scaled_weight"}

    scored = [r for r in rows if r["has_score"]]
    assert scored
    for r in scored:
        pts = r["dimension_points"]
        assert list(pts) == list(by_key)
        score_by_key = {d["key"]: d["score"] for d in r["dimension_scores"]}
        for k, d in by_key.items():
            assert pts[k]["points"] == round(score_by_key[k] * d["weight"] / 5, 2)
            assert pts[k]["scaled_points"] == round(
                score_by_key[k] * d["weight"] / 5 * 100 / 295, 2
            )
        assert round(sum(v["points"] for v in pts.values()), 1) == round(r["weighted_score"], 1)
        assert r["normalized_pct"] == round(r["weighted_score"] / 295 * 100)
    for r in rows:
        if not r["has_score"]:
            assert r["dimension_points"] is None
