"""P53-R01 (workflow-auditor P53-T05 FAIL; I58, I59, I9).

- F53-1: an empty What-if scenario serves a `delivery_by_year` byte-equal
  to the Dashboard's, `left_out_reasons` included (a project with no leader
  is `no_leader` on both surfaces, never `beyond_horizon` on What-if).
- F53-2: the dashboard export's "Delivery by year" sheet carries every
  served band column, `Cumulative other` included.
- A1: a pre-P53 run serves `left_out_reason = null`, not a derived
  `beyond_horizon` (its search was 78 weeks).
"""

from __future__ import annotations

import io
import re
from collections.abc import Iterator
from types import SimpleNamespace

import openpyxl
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

import api.routers.whatif as whatif_router
from api.db import get_db
from api.main import app
from models.enums import ProjectStatus, RoleName, SolverType
from models.project import Project
from models.schedule import ScheduleRun
from scheduling import run_greedy_sgs
from schemas.delivery import DeliveryByYearOut, DeliveryRowOut
from seed import seed_demo_data
from services.delivery_serving import stored_left_out_reason
from services.export_builder import delivery_by_year_blocks
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.xlsx_writer import generated_line
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import clear_current_principal_override
from tests.p12_helpers import act_as, client_for


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    for lim in (whatif_router.WHATIF_RATE_LIMIT, whatif_router.WHATIF_SOLVE_RATE_LIMIT):
        lim.reset()
    yield
    for lim in (whatif_router.WHATIF_RATE_LIMIT, whatif_router.WHATIF_SOLVE_RATE_LIMIT):
        lim.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _seed_with_leaderless_project(db_session: AsyncSession) -> ScheduleRun:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    # One scheduled, counting project loses its leader: LEFT_OUT `no_leader`.
    victim = (
        await db_session.execute(
            select(Project.id)
            .where(
                Project.leader_engineer_id.is_not(None),
                Project.priority.is_not(None),
                Project.status == ProjectStatus.IN_DEVELOPMENT,
            )
            .order_by(Project.id)
            .limit(1)
        )
    ).scalar_one()
    await db_session.execute(
        update(Project).where(Project.id == victim).values(leader_engineer_id=None)
    )
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


async def test_empty_whatif_delivery_equals_dashboard_reasons_included(
    db_session: AsyncSession,
) -> None:
    await _seed_with_leaderless_project(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        dash = await client.get("/dashboard/completing-within-year")
        sim = await client.post("/whatif/simulate", json={"scenario": {}})
    assert dash.status_code == 200, dash.text
    assert sim.status_code == 200, sim.text
    dash_table = dash.json()["delivery_by_year"]
    sim_table = sim.json()["delivery_by_year"]
    assert dash_table is not None
    not_placed = next(r for r in dash_table["rows"] if r["kind"] == "not_placed")
    assert not_placed["left_out_reasons"]["no_leader"] >= 1
    # F53-1 acceptance: byte-equal, reasons included.
    assert sim_table == dash_table


async def test_export_sheet_carries_every_served_column() -> None:
    def row(kind: str, year: int | None, cum: bool) -> DeliveryRowOut:
        c = 1 if cum else None
        return DeliveryRowOut(
            kind=kind,
            year=year,
            label=str(year or kind),
            indicative=False,
            p1=1, p2=2, p3=3, other=4, total=10,
            cum_p1=c, cum_p2=c, cum_p3=c,
            cum_other=4 if cum else None,
            cum_total=c and 10,
        )  # fmt: skip

    table = DeliveryByYearOut(
        run_week=TEST_WEEK,
        base_year=2026,
        within_year_week=52,
        horizon_weeks=TEST_WEEK + 260,
        horizon_years=5,
        rows=[row("by_end_of_year", 2026, True), row("not_placed", None, False)],
    )
    cw = SimpleNamespace(
        delivery_by_year=table, delivery_by_year_unavailable=None, rules_label=None
    )
    (block,) = delivery_by_year_blocks(cw)
    assert block.headers == [
        "Year", "P1", "P2", "P3", "Other", "Total",
        "Cumulative P1", "Cumulative P2", "Cumulative P3", "Cumulative other",
        "Cumulative total",
    ]  # fmt: skip
    first = dict(zip(block.headers, block.rows[0], strict=True))
    # I59: P1 + P2 + P3 + Other = Total, cumulatively too.
    assert (
        first["Cumulative P1"]
        + first["Cumulative P2"]
        + first["Cumulative P3"]
        + first["Cumulative other"]
    ) == 1 + 1 + 1 + 4
    assert first["Cumulative other"] == 4


def test_pre_p53_run_serves_null_reason() -> None:
    pre = ScheduleRun(rules_epoch=None)
    post = ScheduleRun(rules_epoch="p53")
    left_out = SimpleNamespace(left_out=True, data_error=None, left_out_reason=None)
    stored = SimpleNamespace(left_out=True, data_error=None, left_out_reason="no_leader")
    assert stored_left_out_reason(left_out, pre) is None  # type: ignore[arg-type]
    assert stored_left_out_reason(stored, post) == "no_leader"  # type: ignore[arg-type]


# --- QA gate (P53): no raw absolute week in export / scenario text ---------------------

#: "W53" .. "W999": a raw absolute week printed as if it were a week of a year.
_RAW_WEEK = re.compile(r"\bW(5[3-9]|[6-9]\d|\d{3,})\b")


def _raw_week_texts(data: bytes) -> list[str]:
    wb = openpyxl.load_workbook(io.BytesIO(data))
    hits: list[str] = []
    for ws in wb.worksheets:
        for r in ws.iter_rows():
            for cell in r:
                for text in (cell.value, cell.number_format):
                    if isinstance(text, str) and _RAW_WEEK.search(text):
                        hits.append(f"{ws.title}!{cell.coordinate}: {text}")
    return hits


@pytest.mark.parametrize(("week", "label"), [(53, "W1 2027"), (105, "W1 2028")])
async def test_no_raw_absolute_week_in_scenario_exports(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, week: int, label: str
) -> None:
    from tests.test_p32_whatif_import_api import _parsed_rows, make_world
    from tests.test_p41_import_scenarios import save_body

    monkeypatch.setenv("RPD_CURRENT_WEEK", str(week))
    assert generated_line(week).endswith(f"plan week {label}")
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        a = await c.post("/whatif/import/scenarios", json=save_body({"rows": rows}, name="A"))
        assert a.status_code == 201, a.text
        assert a.json()["result"]["current_week"] == week
        b = await c.post("/whatif/import/scenarios", json=save_body({"rows": rows}, name="B"))
        ida, idb = a.json()["id"], b.json()["id"]
        saved = await c.get(f"/whatif/import/scenarios/{ida}/export.xlsx")
        current = await c.post(
            "/whatif/import/export.xlsx", json={"name": "Now", "request": {"rows": rows}}
        )
        compare = await c.get(f"/whatif/import/scenarios/compare.xlsx?ids={ida},{idb}")
    for resp in (saved, current, compare):
        assert resp.status_code == 200, resp.text
        assert _raw_week_texts(resp.content) == []
    texts = [
        str(cell.value)
        for ws in openpyxl.load_workbook(io.BytesIO(saved.content)).worksheets
        for r in ws.iter_rows()
        for cell in r
        if cell.value is not None
    ]
    assert any(f"Simulated at {label}" in t for t in texts)
    assert any(f"Current week ({label})" in t for t in texts)
