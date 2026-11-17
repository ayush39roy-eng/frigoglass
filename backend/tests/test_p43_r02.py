"""P43-R02 (QA gate G2-G5 and the coordinator's G5 ruling).

- G4: the import `Steps` sheet starts with Project, Step code, Status and is
  frozen after them;
- an empty table keeps its header row;
- G5: Commercialized projects (counted as within year, OQ #109) are drawn in
  their own "Delivered (Commercialized)" section, one line, no bar, in every
  drawn Gantt; the planner Summary's outcome tables reconcile to its headline;
- wording: a status-excluded project reads "Not in the plan (status)".

G2 / G3 are the QA-gate tests in `test_p43_qa_gate.py` (no longer xfail).
"""

from __future__ import annotations

from typing import Any

from models.enums import HubName, LabRegion, ProjectPriority, ProjectStatus, RoleName
from services.xlsx_writer import (
    CHART_HEADER_ROW,
    OUTCOME_STYLES,
    TABLE_HEADER_ROW,
    GanttChart,
    GanttProjectBar,
    GanttStepBar,
    SheetBook,
    write_workbook,
)
from tests.factories import make_engineer, make_hub, make_project
from tests.test_p18_whatif_api import make_world
from tests.test_p32_whatif_import_api import _parsed_rows
from tests.test_p32_whatif_import_api import make_world as make_import_world
from tests.test_p43_exports import _as, _client, _reset, _wb, _week_cell  # noqa: F401
from tests.test_p43_qa_gate import _place, _surface_world

DELIVERED_HEADING = "Delivered (Commercialized) — counts as within year"


def _body(ws: Any) -> list[Any]:
    col_a = [ws.cell(row=r, column=1).value for r in range(CHART_HEADER_ROW + 1, ws.max_row + 1)]
    body = col_a[: col_a.index("Legend")]
    while body and body[-1] is None:
        body.pop()
    return body


def test_commercialized_is_its_own_section_one_line_no_bar() -> None:
    chart = GanttChart(
        title="G5",
        projects=[
            GanttProjectBar(
                name="Shipped", hub="R&D-Greece", priority="P1", priority_label=None,
                leader=None, outcome="excluded", outcome_text="x", status="Commercialized",
                steps=[GanttStepBar("PDD-A", "Marketing Brief", "elapsed", 1, 3, 5)],
                start=3, end=5,
            ),
            GanttProjectBar(
                name="Running", hub="R&D-Greece", priority="P2", priority_label=None,
                leader=None, outcome="within_year", outcome_text="Within year",
                steps=[GanttStepBar("PDD-A", "Marketing Brief", "elapsed", 1, 3, 5)],
            ),
            GanttProjectBar(
                name="Held", hub="R&D-Greece", priority="P1", priority_label=None,
                leader=None, outcome="excluded", outcome_text="Not in the plan (status)",
                status="On Hold",
            ),
        ],
        current_week=10,
        base_year=2026,
    )  # fmt: skip
    ws = _wb(write_workbook(SheetBook(charts={"G": chart})))["G"]
    body = _body(ws)
    assert body == [
        "In the plan", "Running", "A · Marketing Brief",
        DELIVERED_HEADING, "Shipped",
        "Not in the plan (status: On Hold, Cancelled, Draft, …)", "Held",
    ]  # fmt: skip
    r = CHART_HEADER_ROW + 1 + body.index("Shipped")
    assert ws.cell(row=r, column=7).value == "Delivered — counts as within year"
    assert all(_week_cell(ws, r, w).fill.patternType is None for w in range(1, 79) if w != 10)
    assert ws.cell(row=r, column=5).value in (None, "")
    assert OUTCOME_STYLES["excluded"][0] == "Not in the plan (status)"


async def test_surface_gantt_draws_commercialized_as_delivered(db_session: Any) -> None:
    hub, templates, engineer, run = await _surface_world(db_session)
    live = await make_project(db_session, hub, name="Live", priority=ProjectPriority.P1)
    await _place(db_session, run, live, templates, engineer, [(5, 6), (7, 8)])
    await make_project(
        db_session, hub, name="Shipped", priority=ProjectPriority.P1,
        status=ProjectStatus.COMMERCIALIZED,
    )  # fmt: skip
    await make_project(db_session, hub, name="Held", status=ProjectStatus.ON_HOLD)
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as c:
        resp = await c.get("/exports/gantt", params={"format": "xlsx"})
    ws = _wb(resp.content)["Gantt"]
    body = _body(ws)
    assert body[: body.index(DELIVERED_HEADING)][0] == "In the plan"
    assert body[body.index(DELIVERED_HEADING) + 1] == "Shipped"
    held = CHART_HEADER_ROW + 1 + body.index("Held")
    assert ws.cell(row=held, column=7).value == "Not in the plan (status)"


async def test_planner_summary_reconciles_to_the_headline(db_session: Any) -> None:
    world = await make_world(db_session)
    eng = await make_engineer(db_session, world.gr, name="Delivered Lead")
    await make_project(
        db_session, world.gr, leader=eng, name="Shipped Cooler",
        status=ProjectStatus.COMMERCIALIZED, priority=ProjectPriority.P1,
    )  # fmt: skip
    await db_session.flush()
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as c:
        sim = (await c.post("/whatif/simulate", json={"scenario": {}})).json()
        resp = await c.post("/whatif/export.xlsx", json={"scenario": {}})
    assert resp.status_code == 200, resp.text
    ws = _wb(resp.content)["Summary"]
    rows = [r for r in ws.iter_rows(min_row=TABLE_HEADER_ROW + 1, values_only=True)]
    items = [(r[0], r[1]) for r in rows if r and r[0] is not None]
    after_at = items.index(("Outcomes after the scenario", None))
    before_at = items.index(("Outcomes before the scenario", None))
    after = dict(items[after_at + 1 : before_at])
    headline = dict(items)
    delivered = sum(1 for p in sim["projects"] if p["outcome"] == "excluded" and p["within_year"])
    assert delivered >= 1  # the Commercialized project counts as within year
    assert after["Delivered (Commercialized) — counts as within year"] == delivered
    total = after["Within year, in total (the headline above)"]
    assert total == headline["Projects within the year after"] == sim["diff"]["within_year_after"]
    assert after["Within year"] + delivered == total
    # The planner chart draws it in the Delivered section.
    body = _body(_wb(resp.content)["Gantt"])
    assert body[body.index(DELIVERED_HEADING) + 1] == "Shipped Cooler"


async def test_import_steps_sheet_leads_with_project_step_status(db_session: Any) -> None:
    await make_import_world(db_session)
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as c:
        rows = await _parsed_rows(c)
        resp = await c.post("/whatif/import/export.xlsx", json={"request": {"rows": rows}})
    assert resp.status_code == 200, resp.text
    ws = _wb(resp.content)["Steps"]
    header = [c.value for c in ws[TABLE_HEADER_ROW]]
    assert header[:3] == ["Project", "Step code", "Status"]
    assert header[-1] == "Ref"
    assert ws.freeze_panes == f"D{TABLE_HEADER_ROW + 1}"


async def test_empty_table_keeps_its_header(db_session: Any) -> None:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_engineer(db_session, hub, name="Only Engineer")
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as c:
        resp = await c.get("/exports/capacity-planning", params={"format": "xlsx"})
    ws = _wb(resp.content)["Chambers"]
    header = [c.value for c in ws[TABLE_HEADER_ROW] if c.value]
    assert header[:2] == ["Code", "Lab region"] and "ID" in header
    assert ws.max_row == TABLE_HEADER_ROW
