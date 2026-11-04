"""P32-R05: served `breakdowns` on `POST /whatif/import/simulate` (docs/API_CONTRACT_P32.md C1).

Pure tests of the year / quarter / bucket rules on hand-built served projects,
then API tests (disposable Postgres, the real engine, synthetic workbooks)
asserting the reconciliation invariants against the returned `projects`:
Σ buckets per dimension = total, `by_year.all.total` = len(projects), every
year block's total = the projects matching that year rule, outcomes sum =
total, and a scoped Hub Planner's breakdowns cover only what is returned.
"""

from __future__ import annotations

from typing import Any

from models.enums import HubName, ProjectStatus, RoleName
from schemas.whatif_import import ImportProjectOut
from services.whatif_import import (
    breakdown_year_key,
    finish_quarter,
    import_breakdowns,
)
from tests.factories import make_project
from tests.plan_import_helpers import build_workbook, row
from tests.test_p32_whatif_import_api import (  # noqa: F401  (autouse fixture)
    _cleanup,
    _parsed_rows,
    act_as,
    client_for,
    make_world,
    sim_body,
)

YEAR_KEYS = ["all", "2026", "2027", "later", "not_placed"]
CATEGORY_ORDER = ["A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM"]
PRIORITY_ORDER = ["P1", "P2", "P3", "P4", "Q"]
HUB_ORDER = [h.value for h in HubName]
STATUS_ORDER = [s.value for s in ProjectStatus]
DIMENSIONS = ("by_category", "by_hub", "by_priority", "by_status", "by_source")
NOT_PLACED = {"left_out", "blocked", "data_error"}
PLACED = {"within_year", "spillover"}


def year_rule(p: dict[str, Any], key: str) -> bool:
    """The C1 year rule, written independently of the service."""

    if key == "all":
        return True
    if key == "not_placed":
        return p["outcome"] in NOT_PLACED
    if p["outcome"] not in PLACED or p["finish_week"] is None:
        return False
    w = p["finish_week"]
    return {"2026": 1 <= w <= 52, "2027": 53 <= w <= 104, "later": w > 104}[key]


def ordered(keys: list[str], order: list[str]) -> bool:
    known = [k for k in keys if k != "unknown"]
    return known == [k for k in order if k in known] and keys[len(known) :] in ([], ["unknown"])


def assert_invariants(body: dict[str, Any]) -> None:
    projects = body["projects"]
    b = body["breakdowns"]
    assert [y["key"] for y in b["years"]] == YEAR_KEYS
    assert list(b["by_year"]) == YEAR_KEYS
    assert b["by_year"]["all"]["total"] == len(projects)
    for key, block in b["by_year"].items():
        match = [p for p in projects if year_rule(p, key)]
        assert block["total"] == len(match), key
        assert block["file"] == sum(1 for p in match if p["source"] == "file")
        assert block["plan"] == sum(1 for p in match if p["source"] == "plan")
        assert block["file"] + block["plan"] == block["total"]
        assert sum(block["outcomes"].values()) == block["total"]
        for oc, n in block["outcomes"].items():
            assert n == sum(1 for p in match if p["outcome"] == oc), (key, oc)
        for dim in DIMENSIONS:
            buckets = block[dim]
            assert sum(x["total"] for x in buckets) == block["total"], (key, dim)
            assert all(x["total"] > 0 for x in buckets)  # empty buckets omitted
            for x in buckets:
                assert x["within_year"] + x["spillover"] + x["not_placed"] <= x["total"]
        assert sum(x["within_year"] for x in block["by_source"]) == sum(
            1 for p in match if p["within_plan_year"]
        )
        assert sum(x["not_placed"] for x in block["by_source"]) == sum(
            1 for p in match if p["outcome"] in NOT_PLACED
        )
        assert ordered([x["key"] for x in block["by_category"]], CATEGORY_ORDER)
        assert ordered([x["key"] for x in block["by_priority"]], PRIORITY_ORDER)
        assert ordered([x["key"] for x in block["by_hub"]], HUB_ORDER)
        assert ordered([x["key"] for x in block["by_status"]], STATUS_ORDER)
        assert ordered([x["key"] for x in block["by_source"]], ["file", "plan"])
        placed = [p for p in match if p["outcome"] in PLACED and p["finish_week"] is not None]
        quarters = block["by_finish_quarter"]
        assert sum(q["count"] for q in quarters) == len(placed)
        assert [q["key"] for q in quarters] == sorted(q["key"] for q in quarters)
        assert all(q["count"] > 0 for q in quarters)
    assert b["by_year"]["not_placed"]["by_finish_quarter"] == []


# --- pure rules -------------------------------------------------------------------------------


def served(**kw: Any) -> ImportProjectOut:
    base: dict[str, Any] = dict(
        ref="row-1", source="file", file_row=1, replaces_project_id=None, name="X",
        hub="R&D-Greece", capacity_hub="R&D-Greece", category="C", priority="P2",
        status="In Queue", leader_name=None, leader_ref=None, leader_auto_assigned=False,
        outcome="within_year", within_plan_year=True, start_week=43, end_week=50,
        finish_week=50, unconstrained_end_week=None, before_outcome=None,
        before_finish_week=None, eng_conflict=False, cat_not_allowed=False,
        lab_overlap=False, no_leader=False, no_chamber_step_id=None, data_error=None, steps=[],
    )  # fmt: skip
    base.update(kw)
    return ImportProjectOut(**base)


def test_finish_quarter_and_year_rule():
    assert finish_quarter(1) == (2026, 1)
    assert finish_quarter(13) == (2026, 1)
    assert finish_quarter(14) == (2026, 2)
    assert finish_quarter(40) == (2026, 4)
    assert finish_quarter(52) == (2026, 4)
    assert finish_quarter(53) == (2027, 1)
    assert finish_quarter(104) == (2027, 4)
    assert finish_quarter(105) == (2028, 1)
    assert breakdown_year_key(served(finish_week=52)) == "2026"
    assert breakdown_year_key(served(finish_week=53, outcome="spillover")) == "2027"
    assert breakdown_year_key(served(finish_week=104)) == "2027"
    assert breakdown_year_key(served(finish_week=105, outcome="spillover")) == "later"
    for oc in ("left_out", "blocked", "data_error"):
        assert breakdown_year_key(served(outcome=oc, finish_week=60)) == "not_placed"
    assert breakdown_year_key(served(outcome="excluded", finish_week=None)) is None


def test_breakdowns_on_hand_built_projects():
    ps = [
        served(ref="a", category="A", priority="P1", hub="PD-India", finish_week=50),
        served(ref="b", category="A+", priority="Q", finish_week=53, outcome="spillover",
               within_plan_year=False),
        served(ref="c", category="C", priority="P1", source="plan", file_row=None,
               status="In Development", finish_week=70),
        served(ref="d", category="B", finish_week=120, outcome="spillover", within_plan_year=False),
        served(ref="e", category=None, priority=None, outcome="data_error", finish_week=None,
               within_plan_year=False, data_error="bad"),
        served(ref="f", category="A+", outcome="left_out", finish_week=None,
               within_plan_year=False),
        served(ref="g", category="C-OEM", hub="OEM-HCK", outcome="excluded", finish_week=None,
               within_plan_year=False, status="On Hold"),
    ]  # fmt: skip
    body = import_breakdowns(ps).model_dump()
    years = body["by_year"]
    assert {k: v["total"] for k, v in years.items()} == {
        "all": 7, "2026": 1, "2027": 2, "later": 1, "not_placed": 2,
    }  # fmt: skip
    assert [y["label"] for y in body["years"]] == [
        "All projects", "Finish in 2026", "Finish in 2027", "Finish after 2027", "Not placed",
    ]  # fmt: skip
    al = years["all"]
    assert al["outcomes"] == {
        "within_year": 2, "spillover": 2, "left_out": 1, "blocked": 0, "data_error": 1,
        "excluded": 1,
    }  # fmt: skip
    assert [x["key"] for x in al["by_category"]] == ["A+", "A", "B", "C", "C-OEM", "unknown"]
    aplus = al["by_category"][0]
    assert (aplus["total"], aplus["within_year"], aplus["spillover"], aplus["not_placed"]) == (
        2, 0, 1, 1,
    )  # fmt: skip
    coem = next(x for x in al["by_category"] if x["key"] == "C-OEM")
    assert (coem["total"], coem["within_year"], coem["spillover"], coem["not_placed"]) == (
        1, 0, 0, 0,
    )  # excluded counts in total only  # fmt: skip
    assert [x["key"] for x in al["by_priority"]] == ["P1", "P2", "Q", "unknown"]
    assert [x["key"] for x in al["by_hub"]] == ["R&D-Greece", "PD-India", "OEM-HCK"]
    assert [x["key"] for x in al["by_status"]] == ["In Development", "In Queue", "On Hold"]
    assert [(x["key"], x["total"]) for x in al["by_source"]] == [("file", 6), ("plan", 1)]
    assert al["by_finish_quarter"] == [
        {"key": "2026-Q4", "label": "Q4 '26", "count": 1},
        {"key": "2027-Q1", "label": "Q1 '27", "count": 1},
        {"key": "2027-Q2", "label": "Q2 '27", "count": 1},
        {"key": "2028-Q2", "label": "Q2 '28", "count": 1},  # W120 = 2028 W16
    ]
    assert years["not_placed"]["by_finish_quarter"] == []
    assert_invariants({"projects": [p.model_dump() for p in ps], "breakdowns": body})


def test_empty_projects_give_five_empty_blocks():
    out = import_breakdowns([]).model_dump()
    assert list(out["by_year"]) == YEAR_KEYS
    for block in out["by_year"].values():
        assert block["total"] == 0 and block["by_category"] == []
        assert block["by_finish_quarter"] == []


# --- API --------------------------------------------------------------------------------------


async def test_simulate_serves_reconciling_breakdowns(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        for kw in ({}, {"mode": "file_only", "plan_year_end_week": 52}):
            resp = await c.post("/whatif/import/simulate", json=sim_body(rows, **kw))
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert_invariants(body)
            al = body["breakdowns"]["by_year"]["all"]
            k = body["kpis"]
            assert al["file"] == k["file_projects"]
            assert al["outcomes"]["within_year"] == k["within_plan_year"]
            # Excluded plan projects are counted in the KPIs but not returned.
            assert al["total"] == k["projects_total"] - (k["excluded"] - al["outcomes"]["excluded"])


async def test_crowded_plan_spreads_over_years(db_session):
    """Many file projects on one designer: some spill past the plan year, so
    the year blocks other than `all` are populated and still reconcile."""

    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    data = build_workbook(
        [
            row(sn=i, name=f"Crowd {i}", hub="Greece", category="A+" if i % 3 else "B",
                status="Que", engineer="Kanarios", priority=(i % 4) + 1)
            for i in range(1, 13)
        ]
    )  # fmt: skip
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c, data)
        resp = await c.post(
            "/whatif/import/simulate", json=sim_body(rows, mode="file_only", plan_year_end_week=52)
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert_invariants(body)
    years = body["breakdowns"]["by_year"]
    assert years["all"]["total"] == 12
    assert sum(years[k]["total"] for k in YEAR_KEYS[1:]) == 12  # no excluded file rows
    assert years["all"]["outcomes"]["spillover"] + years["all"]["outcomes"]["left_out"] > 0


async def test_hub_planner_breakdowns_cover_only_returned_projects(db_session):
    world = await make_world(db_session)
    # A live PD-India project no file row replaces: in an Admin's plan, not a Greece planner's.
    await make_project(db_session, world.ind, leader=world.eng_in, name="Epsilon Cooler")
    await db_session.flush()

    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        admin = (await c.post("/whatif/import/simulate", json=sim_body(rows))).json()
    assert_invariants(admin)
    assert admin["breakdowns"]["by_year"]["all"]["plan"] == 2  # Gamma + Epsilon

    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        resp = await c.post("/whatif/import/simulate", json=sim_body(rows))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert_invariants(body)
    assert "Epsilon Cooler" not in resp.text
    al = body["breakdowns"]["by_year"]["all"]
    assert al["total"] == len(body["projects"]) == 6
    assert (al["file"], al["plan"]) == (5, 1)
    plan_bucket = next(x for x in al["by_source"] if x["key"] == "plan")
    assert plan_bucket["total"] == 1  # Gamma only
    # Every hub bucket counts only returned projects (PD-India: the file rows).
    for x in al["by_hub"]:
        assert x["total"] == sum(1 for p in body["projects"] if p["hub"] == x["key"])
    assert al["total"] < admin["breakdowns"]["by_year"]["all"]["total"]
