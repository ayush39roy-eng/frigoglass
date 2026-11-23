"""P43 (ADR 0057, docs/API_CONTRACT_P43.md): presentable exports and the
drawn Gantt.

- D1: the styled table (title block, human header with its fill, frozen
  panes, auto-filter, widths, Yes / No, banding, print setup), CSV headers;
- D2: the drawn Gantt (a fill on exactly the planned weeks, the step colour,
  pinned outline, frozen hatch, current week, W52 line, legend, outcome
  colour), and the reconciliation drawn bars = served `GET /gantt` weeks;
- the formula guard on every text cell, charts included;
- no financial column for a role without one; 403 where the surface is
  closed;
- the import template still parses;
- D3: `POST /whatif/export.xlsx` (sheets, RBAC, hub scope, strict body,
  rate limit, audit, drawn weeks = the engine's schedule).
"""

from __future__ import annotations

import io
from typing import Any

import openpyxl
import pytest
from httpx import ASGITransport, AsyncClient

import api.routers.whatif as whatif_router
from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, RoleName, WorkflowStepKind
from models.schedule import ScheduleRunProjectStep
from services.export_builder import csv_bytes, xlsx_bytes
from services.import_format import template_xlsx
from services.plan_import_xlsx import read_workbook
from services.rate_limit import TokenBucketLimiter
from services.week_labels import week_label
from services.xlsx_writer import (
    CHART_FIRST_WEEK_COLUMN,
    CHART_FIXED_COLUMNS,
    CHART_HEADER_ROW,
    NAVY,
    STEP_PALETTE_HEX,
    TABLE_HEADER_ROW,
    GanttChart,
    GanttProjectBar,
    GanttStepBar,
    SheetBook,
    write_workbook,
)
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.export_read import csv_header, xlsx_table
from tests.factories import (
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
    make_workflow_step_template,
)
from tests.test_p18_whatif_api import (
    GR_ENGINEER,
    IN_ENGINEER,
    SECRET_CUSTOMER,
    add_c_projects,
    make_world,
    whatif_audit_rows,
)

FINANCIAL_LABELS = ("Customer", "TCOGS (EUR)", "Selling price (EUR)", "Gross margin %")
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@pytest.fixture(autouse=True)
def _reset() -> Any:
    whatif_router.WHATIF_RATE_LIMIT.reset()
    whatif_router.WHATIF_EXPORT_RATE_LIMIT.reset()
    yield
    whatif_router.WHATIF_RATE_LIMIT.reset()
    whatif_router.WHATIF_EXPORT_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session: Any) -> AsyncClient:
    async def _override_get_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _as(db_session: Any, role: RoleName, hub_ids: list[Any] | None = None) -> None:
    scope_all = hub_ids is None
    user = await make_user(db_session, role, hub_ids=hub_ids or [], hub_scope_all=scope_all)
    override_current_principal(
        make_principal(role, user_id=user.id, hub_scope_all=scope_all, hub_ids=hub_ids or [])
    )


def _wb(content: bytes) -> Any:
    return openpyxl.load_workbook(io.BytesIO(content))


def _rgb(colour: Any) -> str:
    return str(colour.rgb)[-6:] if colour is not None and colour.rgb else ""


def _fill_rgb(cell: Any) -> str:
    """The visible colour of a cell: fg for solid, bg for a pattern."""

    fill = cell.fill
    if fill is None or fill.patternType is None:
        return ""
    if fill.patternType == "solid":
        return _rgb(fill.fgColor)
    return _rgb(fill.bgColor)


def _week_cell(ws: Any, row: int, week: int) -> Any:
    return ws.cell(row=row, column=CHART_FIRST_WEEK_COLUMN + week - 1)


def _row_of(ws: Any, prefix: str) -> int:
    for r in range(CHART_HEADER_ROW + 1, ws.max_row + 1):
        v = ws.cell(row=r, column=1).value
        if isinstance(v, str) and v.startswith(prefix):
            return r
    raise AssertionError(f"no chart row starting {prefix!r}")


def _weeks_with(ws: Any, row: int, rgb: str, horizon: int) -> set[int]:
    return {w for w in range(1, horizon + 1) if _fill_rgb(_week_cell(ws, row, w)) == rgb}


def _all_text(wb: Any) -> str:
    return " ".join(
        str(c.value) for ws in wb.worksheets for r in ws.iter_rows() for c in r if c.value
    )


def _no_formulas(wb: Any) -> None:
    for ws in wb.worksheets:
        for r in ws.iter_rows():
            for c in r:
                assert c.data_type != "f", (ws.title, c.coordinate)
                if isinstance(c.value, str):
                    assert not c.value.startswith(("=", "+", "-", "@", "\t", "\r")), c.value


# --- D1: the styled table ----------------------------------------------------------------


def test_styled_table_round_trip() -> None:
    rows = [
        {"project_name": "=SUM(1)", "frozen": True, "booked_pct": 87.5, "delay_weeks": 3},
        {"project_name": "Plain", "frozen": False, "booked_pct": None, "delay_weeks": -2},
    ]
    keys = ["project_name", "frozen", "booked_pct", "delay_weeks"]
    book = SheetBook({"Data": (keys, rows)}, title="My export", context=["Scope: all hubs"])
    wb = _wb(write_workbook(book))
    ws = wb["Data"]
    assert ws["A1"].value == "My export" and ws["A1"].font.b
    assert ws["A2"].value == "Scope: all hubs"
    assert str(ws["A3"].value).startswith("Generated ")
    header = [c.value for c in ws[TABLE_HEADER_ROW]]
    assert header == ["Project", "Frozen", "Booked %", "Delay (weeks)"]
    for c in ws[TABLE_HEADER_ROW]:
        assert _fill_rgb(c) == NAVY and c.font.b and _rgb(c.font.color) == "FFFFFF"
    assert ws.freeze_panes == f"B{TABLE_HEADER_ROW + 1}"
    assert ws.auto_filter.ref == f"A{TABLE_HEADER_ROW}:D{TABLE_HEADER_ROW + 2}"
    assert ws.column_dimensions["A"].width >= 10
    first, second = ws[TABLE_HEADER_ROW + 1], ws[TABLE_HEADER_ROW + 2]
    # Formula guard and text type; Yes / No; number formats; negatives stay numbers.
    assert first[0].value == "'=SUM(1)" and first[0].data_type == "s"
    assert (first[1].value, second[1].value) == ("Yes", "No")
    assert first[2].value == 87.5 and first[2].number_format == "#,##0.00"
    assert second[3].value == -2 and second[3].data_type == "n"
    # Banding is one conditional format over the data rows.
    ranges = [str(cf.sqref) for cf in ws.conditional_formatting]
    assert ranges == [f"A{TABLE_HEADER_ROW + 1}:D{TABLE_HEADER_ROW + 2}"]
    # Print setup.
    assert ws.page_setup.orientation == "landscape"
    assert ws.page_setup.fitToWidth == 1 and ws.sheet_properties.pageSetUpPr.fitToPage
    assert ws.print_title_rows == f"${TABLE_HEADER_ROW}:${TABLE_HEADER_ROW}"
    _no_formulas(wb)


def test_csv_gets_human_headers_only() -> None:
    content = csv_bytes(
        ["project_name", "frozen", "tcogs_eur"], [{"project_name": "=x", "frozen": True}]
    )
    assert csv_header(content) == ["Project", "Frozen", "TCOGS (EUR)"]
    # Values are as before P43 (True stays True; the formula guard stays).
    assert content.decode("utf-8-sig").splitlines()[1] == "'=x,True,"


def test_report_sheet_and_plain_dict_still_work() -> None:
    from services.xlsx_writer import SECTION

    book = SheetBook(
        {"Summary": (["Item", "Value"], [{"Item": "Plan", "Value": SECTION},
                                         {"Item": "plan_version", "Value": 7},
                                         {"Item": "note", "Value": "@x"}])},
        title="T", reports={"Summary"},
    )  # fmt: skip
    ws = _wb(write_workbook(book))["Summary"]
    rows = [[c.value for c in r] for r in ws.iter_rows(min_row=TABLE_HEADER_ROW)]
    assert rows[0] == ["Item", "Value"]
    assert rows[1][0] == "Plan" and rows[2] == ["Plan version", 7] and rows[3] == ["Note", "'@x"]
    assert ws.auto_filter.ref is None
    # A plain dict (no SheetBook) still writes.
    plain = _wb(xlsx_bytes({"S": (["a"], [{"a": "=1"}])}))["S"]
    assert plain.cell(row=TABLE_HEADER_ROW + 1, column=1).value == "'=1"


# --- D2: the drawn Gantt -------------------------------------------------------------------


def _sample_chart() -> GanttChart:
    return GanttChart(
        title="Sample",
        projects=[
            GanttProjectBar(
                name="=evil()", hub="R&D-Greece", priority="P1",
                priority_label="Must do this year", leader="Lead", outcome="within_year",
                outcome_text="Within year",
                steps=[
                    GanttStepBar("PDD-A", "Marketing Brief", "elapsed", 1, 3, 5),
                    GanttStepBar("PDD-B", "Feasibility", "design", 2, 6, 9, "Eng", pinned=True),
                    GanttStepBar("PDD-C", "Business Case", "elapsed", 3, 9, 9, skipped=True),
                ],
            ),
            GanttProjectBar(
                name="Frozen one", hub="OEM-HCK", priority="P4", priority_label="Miscellaneous",
                leader=None, outcome="spillover", outcome_text="Spillover", frozen=True,
                steps=[GanttStepBar("OEM-E", "Proof of Concept", "lab", 5, 50, 55, "CH-1")],
            ),
        ],
        current_week=10,
        base_year=2026,
    )  # fmt: skip


def test_drawn_gantt_round_trip() -> None:
    book = SheetBook(
        {"Gantt data": (["project_name"], [{"project_name": "x"}])},
        title="T",
        charts={"Gantt": _sample_chart()},
        order=["Gantt", "Gantt data"],
    )
    wb = _wb(write_workbook(book))
    assert wb.sheetnames == ["Gantt", "Gantt data"]
    ws = wb["Gantt"]
    assert ws.freeze_panes == f"H{CHART_HEADER_ROW + 1}"
    header = [ws.cell(row=CHART_HEADER_ROW, column=i).value for i in range(1, 8)]
    assert header == list(CHART_FIXED_COLUMNS)
    assert _week_cell(ws, CHART_HEADER_ROW, 1).value == 1
    assert _week_cell(ws, CHART_HEADER_ROW, 78).value == 78  # W1..horizon
    assert _week_cell(ws, CHART_HEADER_ROW - 1, 1).value == "2026 (from W1)"
    # P53 (owner rule: no label >= W53): the year band reads the week of its year.
    assert _week_cell(ws, CHART_HEADER_ROW - 1, 53).value == "2027 (from W1)"
    # Current week and W52 boundary.
    assert _fill_rgb(_week_cell(ws, CHART_HEADER_ROW, 10)) == "F59E0B"
    assert _fill_rgb(_week_cell(ws, CHART_HEADER_ROW, 53)) == "CBD5E1"
    assert _rgb(_week_cell(ws, CHART_HEADER_ROW, 52).border.right.color) == "DC2626"

    project = _row_of(ws, "'=evil()")
    assert ws.cell(row=project, column=1).data_type == "s"
    assert ws.cell(row=project, column=3).value == "P1 · Must do this year"
    assert ws.cell(row=project, column=5).value == 3 and ws.cell(row=project, column=6).value == 9
    assert _rgb(ws.cell(row=project, column=7).font.color) == "15803D"
    assert _weeks_with(ws, project, "64748B", 78) == set(range(3, 10))

    a = _row_of(ws, "A · Marketing Brief")
    assert _weeks_with(ws, a, STEP_PALETTE_HEX[0], 78) == {3, 4, 5}
    assert _week_cell(ws, a, 3).value == "A"  # the step letter on the bar
    assert _fill_rgb(_week_cell(ws, a, 10)) == "FEF3C7"  # current week, empty cell
    b = _row_of(ws, "B · Feasibility (pinned)")
    assert _weeks_with(ws, b, STEP_PALETTE_HEX[1], 78) == {6, 7, 8, 9}
    assert _week_cell(ws, b, 6).border.left.style == "medium"
    assert all(_week_cell(ws, b, w).border.top.style == "medium" for w in range(6, 10))
    assert _week_cell(ws, b, 9).border.right.style == "medium"
    assert ws.cell(row=b, column=4).value == "Eng"
    c = _row_of(ws, "C · Business Case (skipped)")
    assert _weeks_with(ws, c, STEP_PALETTE_HEX[2], 78) == set()  # skipped: no bar

    frozen = _row_of(ws, "Frozen one (frozen)")
    e = _row_of(ws, "E · Proof of Concept")
    assert e == frozen + 1
    assert _weeks_with(ws, e, STEP_PALETTE_HEX[4], 78) == set(range(50, 56))
    assert _week_cell(ws, e, 50).fill.patternType == "lightUp"  # hatched
    assert _rgb(_week_cell(ws, e, 52).border.right.color) == "DC2626"
    assert _rgb(ws.cell(row=frozen, column=7).font.color) == "B45309"

    # The legend, below the chart.
    col_a = [ws.cell(row=r, column=1).value for r in range(1, ws.max_row + 1)]
    legend = col_a.index("Legend") + 1
    assert legend > e
    assert "A · Marketing Brief (PDD-A)" in col_a[legend:]
    assert "E · Proof of Concept (OEM-E)" in col_a[legend:]
    assert any(isinstance(v, str) and v.startswith("Frozen project") for v in col_a[legend:])
    assert "Legend: row" in str(ws["A3"].value)
    assert ws.auto_filter.ref == f"A{CHART_HEADER_ROW}:G{CHART_HEADER_ROW + 6}"
    _no_formulas(wb)


def test_chart_widens_to_a_served_week_past_the_horizon() -> None:
    chart = _sample_chart()
    chart.projects[0].steps[0] = GanttStepBar("PDD-A", "Marketing Brief", "elapsed", 1, 80, 90)
    ws = _wb(write_workbook(SheetBook(charts={"G": chart})))["G"]
    a = _row_of(ws, "A · Marketing Brief")
    assert _weeks_with(ws, a, STEP_PALETTE_HEX[0], 90) == set(range(80, 91))


# --- surface Gantt export: drawn bars = served weeks ---------------------------------------


async def test_gantt_export_draws_exactly_the_served_weeks(db_session: Any) -> None:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    t_a = await make_workflow_step_template(db_session, step_id="PDD-A", sequence_order=1)
    t_b = await make_workflow_step_template(
        db_session, step_id="PDD-B", kind=WorkflowStepKind.DESIGN, sequence_order=2
    )
    engineer = await make_engineer(db_session, hub)
    project = await make_project(db_session, hub, name="Drawn Project", leader=engineer)
    run = await make_schedule_run(db_session, is_active=True)
    for template, order, start, end, pinned in ((t_a, 1, 31, 32, False), (t_b, 2, 33, 37, True)):
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id, project_id=project.id, step_template_id=template.id,
                sequence_order=order, duration_weeks=end - start + 1, start_week=start,
                end_week=end, assigned_engineer_id=engineer.id, pinned=pinned,
            )
        )  # fmt: skip
    await db_session.flush()
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as c:
        served = (await c.get("/gantt")).json()
        resp = await c.get("/exports/gantt", params={"format": "xlsx"})
        csv_resp = await c.get("/exports/gantt", params={"format": "csv"})
    assert resp.status_code == 200 and csv_resp.status_code == 200
    wb = _wb(resp.content)
    assert wb.sheetnames == ["Summary", "Gantt", "Gantt data"]
    ws = wb["Gantt"]
    (row,) = served["rows"]
    project_row = _row_of(ws, "Drawn Project")
    for step in row["steps"]:
        letter = step["step_id"][-1]
        r = _row_of(ws, f"{letter} · {step['step_name']}")
        assert r > project_row
        colour = STEP_PALETTE_HEX["ABCDEFGHIJKLMN".index(letter)]
        want = set(range(step["planned_start_week"], step["planned_end_week"] + 1))
        assert _weeks_with(ws, r, colour, 78) == want, step["step_id"]
        assert ws.cell(row=r, column=5).value == step["planned_start_week"]
        assert ws.cell(row=r, column=6).value == step["planned_end_week"]
        assert ("(pinned)" in ws.cell(row=r, column=1).value) is step["pinned"]
    assert _weeks_with(ws, project_row, "64748B", 78) == set(range(31, 38))
    assert f"Schedule run v{served['schedule_run_version']}" in str(ws["A2"].value)
    # The table is kept (weeks written as labels, 2026-11-23 audit A1), and
    # CSV is that table with human headers.
    _, data = xlsx_table(resp.content, "Gantt data")
    assert [(d["step_id"], d["planned_start_week"]) for d in data] == [
        ("PDD-A", week_label(31)),
        ("PDD-B", week_label(33)),
    ]
    assert "Planned start (week)" in csv_header(csv_resp.content)


# --- roles: no financial column where the role has none -----------------------------------


async def test_no_financial_columns_without_the_right(db_session: Any) -> None:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_schedule_run(db_session, is_active=True)
    await make_project(db_session, hub, name="Fin", customer_name=SECRET_CUSTOMER, tcogs_eur=77.5)
    await db_session.flush()
    await _as(db_session, RoleName.ENGINEER, hub_ids=[hub.id])
    async with _client(db_session) as c:
        gantt = await c.get("/exports/gantt", params={"format": "xlsx"})
        for surface in ("matrix", "project-registration", "dashboard"):
            assert (await c.get(f"/exports/{surface}")).status_code == 403, surface
    assert gantt.status_code == 200
    text = _all_text(_wb(gantt.content))
    assert SECRET_CUSTOMER not in text and "77.5" not in text
    assert not any(label in text for label in FINANCIAL_LABELS)
    await _as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with _client(db_session) as c:
        assert (await c.get("/exports/project-registration")).status_code == 403
        dash = await c.get("/exports/dashboard", params={"format": "xlsx"})
    assert dash.status_code == 200
    assert not any(label in _all_text(_wb(dash.content)) for label in FINANCIAL_LABELS)


# --- the import template still parses -----------------------------------------------------


def test_template_is_styled_and_still_parses() -> None:
    from services.import_format import FIELD_KEYS
    from services.plan_import_xlsx import _FIELDS

    data = template_xlsx(_FIELDS)
    wb = _wb(data)
    ws = wb["Projects"]
    assert _fill_rgb(ws["A1"]) == NAVY and ws.freeze_panes == "B2"
    assert len([c for c in ws[1] if c.value]) <= len(FIELD_KEYS)
    raw = read_workbook(data, _FIELDS)
    assert raw is not None
    _no_formulas(wb)


# --- D3: the What-if planner export -------------------------------------------------------


@pytest.mark.parametrize(
    "role,allowed",
    [
        (RoleName.PORTFOLIO_MANAGER, True),
        (RoleName.HUB_PLANNER, True),
        (RoleName.ADMIN, True),
        (RoleName.EXECUTIVE_VIEWER, False),
        (RoleName.ENGINEER, False),
        (RoleName.AUDITOR, False),
    ],
)
async def test_planner_export_roles(db_session: Any, role: RoleName, allowed: bool) -> None:
    world = await make_world(db_session)
    await _as(db_session, role, [world.gr.id] if role == RoleName.HUB_PLANNER else None)
    async with _client(db_session) as c:
        resp = await c.post("/whatif/export.xlsx", json={"scenario": {}})
    assert resp.status_code == (200 if allowed else 403), resp.text


async def test_planner_export_sheets_and_weeks_match_the_simulation(db_session: Any) -> None:
    from scheduling.greedy import run_greedy_sgs
    from scheduling.whatif import AddProject, Scenario, apply_scenario
    from services import plan_clock
    from services.whatif_baseline import load_context

    await make_world(db_session)
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    body = {"scenario": add_c_projects("R&D-Greece", 2), "name": "=Two more"}
    async with _client(db_session) as c:
        sim = (await c.post("/whatif/simulate", json={"scenario": body["scenario"]})).json()
        forged = await c.post("/whatif/export.xlsx", json={**body, "result": {}})
        resp = await c.post("/whatif/export.xlsx", json=body)
    assert forged.status_code == 422
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == XLSX
    assert resp.headers["content-disposition"] == 'attachment; filename="Two more.xlsx"'
    wb = _wb(resp.content)
    assert wb.sheetnames == ["Summary", "Gantt", "Gantt data"]
    _no_formulas(wb)
    summary = {
        r[0]: r[1] for r in wb["Summary"].iter_rows(min_row=TABLE_HEADER_ROW, values_only=True)
    }
    assert summary["Name"] == "'=Two more"
    assert summary["Projects within the year after"] == sim["diff"]["within_year_after"]
    assert summary["Projects added"] == 2

    # Every finish week equals the served simulation's.
    _, data = xlsx_table(resp.content, "Gantt data")
    finish = {(d["project_name"]): d["finish_week"] for d in data}
    for p in sim["projects"]:
        want = None if p["finish_week"] is None else week_label(p["finish_week"])
        assert finish[p["name"]] == want, p["name"]

    # Every drawn bar is the engine's own schedule of this scenario.
    ctx = await load_context(
        db_session, make_principal(RoleName.PORTFOLIO_MANAGER), clock=plan_clock.now()
    )
    applied = apply_scenario(
        ctx.baseline, Scenario(add_projects=(AddProject(hub="R&D-Greece", category="C", count=2),))
    )
    out = run_greedy_sgs(applied.schedule_input)
    names = {p.project_id: p.name for p in applied.schedule_input.projects}
    by_key = {(d["project_name"], d["step_id"]): d for d in data}
    ws = wb["Gantt"]
    checked = 0
    for o in out.project_outcomes:
        for st in o.steps:
            d = by_key[(names[o.project_id], st.step_id)]
            assert (d["start_week"], d["end_week"]) == tuple(
                None if w is None else week_label(w) for w in (st.start_week, st.end_week)
            )
            checked += 1
    assert checked > 0
    # The drawn row of the first project's first placed step.
    first = next(o for o in out.project_outcomes if o.steps and not o.steps[0].skipped)
    project_row = _row_of(ws, names[first.project_id])
    st = first.steps[0]
    colour = STEP_PALETTE_HEX["ABCDEFGHIJKLMN".index(st.step_id[-1])]
    assert _weeks_with(ws, project_row + 1, colour, 120) == set(
        range(st.start_week, st.end_week + 1)
    )
    (audit,) = [a for a in await whatif_audit_rows(db_session) if a.action == "whatif.export"]
    assert audit.after_state["projects"] == len(sim["projects"])
    assert "Two more" not in str(audit.after_state)


async def test_planner_export_is_hub_scoped(db_session: Any) -> None:
    world = await make_world(db_session)
    await _as(db_session, RoleName.HUB_PLANNER, [world.gr.id])
    async with _client(db_session) as c:
        resp = await c.post(
            "/whatif/export.xlsx", json={"scenario": add_c_projects("R&D-Greece", 1)}
        )
        out_of_scope = await c.post(
            "/whatif/export.xlsx", json={"scenario": add_c_projects("PD-India", 1)}
        )
    assert resp.status_code == 200, resp.text
    assert out_of_scope.status_code == 403
    text = _all_text(_wb(resp.content))
    for leak in ("Secret in Project", IN_ENGINEER, "PD-India", "CH-IN-1", SECRET_CUSTOMER):
        assert leak not in text, leak
    assert "Secret gr Project 0" in text
    _, data = xlsx_table(resp.content, "Gantt data")
    assert data and {d["hub"] for d in data} == {"R&D-Greece"}
    # Step rows name the assigned engineer (as GET /gantt does); the project
    # row's leader column stays blank.
    assert GR_ENGINEER in text


async def test_planner_export_rate_limited(db_session: Any, monkeypatch: Any) -> None:
    await make_world(db_session)
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    # P43-R01 (security L-1): the export has its own, smaller bucket; it
    # neither uses nor drains the shared What-if bucket.
    monkeypatch.setattr(whatif_router, "WHATIF_EXPORT_RATE_LIMIT", TokenBucketLimiter(1, 0.001))
    monkeypatch.setattr(whatif_router, "WHATIF_RATE_LIMIT", TokenBucketLimiter(1, 0.001))
    async with _client(db_session) as c:
        assert (await c.post("/whatif/export.xlsx", json={"scenario": {}})).status_code == 200
        limited = await c.post("/whatif/export.xlsx", json={"scenario": {}})
        simulate = await c.post("/whatif/simulate", json={"scenario": {}})
    assert limited.status_code == 429 and limited.headers["Retry-After"]
    assert simulate.status_code == 200
    assert whatif_router.WHATIF_EXPORT_RATE_LIMIT is not whatif_router.WHATIF_SOLVE_RATE_LIMIT
    default = TokenBucketLimiter(capacity=6, refill_per_second=1 / 10)
    assert (default.capacity, default.refill_per_second) == (6, 0.1)


async def test_planner_workbook_is_built_inside_the_users_whatif_slot(
    db_session: Any, monkeypatch: Any
) -> None:
    """P43-R01 (security L-1): the workbook write holds the per-user
    in-flight slot, so a second heavy What-if call waits for it."""

    import services.whatif as whatif_service

    seen: list[int] = []
    real = whatif_router.planner_xlsx

    def spy(book: Any) -> bytes:
        seen.append(sum(whatif_service._IN_FLIGHT.values()))
        return real(book)

    monkeypatch.setattr(whatif_router, "planner_xlsx", spy)
    await make_world(db_session)
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as c:
        resp = await c.post("/whatif/export.xlsx", json={"scenario": {}})
    assert resp.status_code == 200
    assert seen == [1]


async def test_matrix_csv_header_from_a_rubric_label_is_neutralised(db_session: Any) -> None:
    """P43-R01 (security M-1): Matrix dimension columns are headed by the
    Admin-editable rubric label; a formula there must not survive into the
    CSV header (or the xlsx)."""

    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_project(db_session, hub, name="Scored")
    await db_session.flush()
    await _as(db_session, RoleName.ADMIN)
    evil = '=HYPERLINK("http://x")'
    async with _client(db_session) as c:
        rubric = (await c.get("/scoring-rubric")).json()
        dims = [
            {k: d[k] for k in ("key", "label", "pillar", "weight", "inverted", "active")}
            for d in rubric["dimensions"]
        ]
        dims[0]["label"] = evil
        put = await c.put(
            "/scoring-rubric",
            json={"version": rubric["version"], "reason": "p43-r01", "dimensions": dims},
        )
        assert put.status_code == 200, put.text
        csv_resp = await c.get("/exports/matrix", params={"format": "csv"})
        xlsx_resp = await c.get("/exports/matrix", params={"format": "xlsx"})
    header = csv_header(csv_resp.content)
    assert "'" + evil in header
    assert not any(h.startswith(("=", "+", "-", "@", "\t", "\r")) for h in header)
    wb = _wb(xlsx_resp.content)
    assert "'" + evil in [c.value for c in wb["Matrix"][TABLE_HEADER_ROW]]
    _no_formulas(wb)


def test_every_header_label_is_neutralised() -> None:
    from services.xlsx_writer import header_labels

    assert header_labels(["a", "b"], {"a": "=1+1", "b": "@x"}) == ["'=1+1", "'@x"]
    assert csv_header(csv_bytes(["k"], [], {"k": "-cmd"})) == ["'-cmd"]


def test_nested_field_null_on_the_first_row_is_still_flattened() -> None:
    """Regression (found building the P43 samples): the Matrix
    `last_score_version` is null on some rows; flattening keyed on row 0 left
    a later row's dict in the sheet and the xlsx write failed."""

    from pydantic import BaseModel

    from services.export_builder import rows_from_models

    class Inner(BaseModel):
        version: int
        at: str

    class Row(BaseModel):
        name: str
        last: Inner | None

    models = [Row(name="a", last=None), Row(name="b", last=Inner(version=2, at="x"))]
    headers, rows = rows_from_models(models)
    assert headers == ["name", "last_version", "last_at"]
    assert rows[1]["last_version"] == 2 and rows[0]["last_version"] is None
    wb = _wb(xlsx_bytes({"S": (headers, rows)}))
    assert wb["S"].cell(row=TABLE_HEADER_ROW + 2, column=2).value == 2


# --- P43 rework ---------------------------------------------------------------------------


def test_chart_order_sections_and_outline() -> None:
    def bar(name: str, prio: str | None, rank: int | None, outcome: str, steps: int) -> Any:
        return GanttProjectBar(
            name=name, hub="R&D-Greece", priority=prio, priority_label=None, leader=None,
            outcome=outcome, outcome_text=outcome, rank=rank,
            steps=[GanttStepBar(f"PDD-{'ABC'[i]}", f"S{i}", "design", i + 1, 2 + i, 2 + i)
                   for i in range(steps)],
        )  # fmt: skip

    chart = GanttChart(
        title="Order",
        projects=[
            bar("Not sched", "P4", 1, "not_scheduled_priority", 2),
            bar("Queued one", "P3", 1, "queued", 1),
            bar("P2 b", "P2", 2, "spillover", 1),
            bar("P1 z", "P1", None, "within_year", 1),
            bar("P1 y", "P1", 1, "within_year", 2),
            bar("On hold", "P1", None, "excluded", 0),
        ],
        current_week=10,
        base_year=2026,
    )
    ws = _wb(write_workbook(SheetBook(charts={"G": chart})))["G"]
    col_a = [ws.cell(row=r, column=1).value for r in range(CHART_HEADER_ROW + 1, ws.max_row + 1)]
    body = col_a[: col_a.index("Legend")]
    assert body == [
        "In the plan",
        "P1 y", "A · S0", "B · S1",
        "P1 z", "A · S0",
        "P2 b", "A · S0",
        "Queued (P3) — spare capacity only, not counted this year",
        "Queued one", "A · S0",
        "Not scheduled (P4)",
        "Not sched",  # one line, its steps are not drawn
        "Not in the plan (status: On Hold, Cancelled, Draft, …)",
        "On hold",
        None,
    ]  # fmt: skip
    # Step rows are outline level 1 under their project row (summary above).
    levels = {
        ws.cell(row=r, column=1).value: ws.row_dimensions[r].outlineLevel
        for r in range(CHART_HEADER_ROW + 1, CHART_HEADER_ROW + 16)
    }
    assert levels["P1 y"] == 0 and levels["A · S0"] == 1 and levels["Not sched"] == 0
    assert ws.sheet_properties.outlinePr.summaryBelow is False
    assert not any(ws.row_dimensions[r].hidden for r in range(1, ws.max_row + 1))


def test_table_puts_identifying_columns_first_and_ids_last() -> None:
    keys = [
        "project_id",
        "category",
        "status",
        "project_name",
        "hub",
        "hub_id",
        "leader_engineer_id",
    ]
    row = {k: "x" for k in keys}
    ws = _wb(write_workbook(SheetBook({"T": (keys, [row])})))["T"]
    header = [c.value for c in ws[TABLE_HEADER_ROW]]
    assert header == ["Project", "Hub", "Status", "Category", "Project ID", "Hub ID", "Leader ID"]
    assert ws.freeze_panes == f"D{TABLE_HEADER_ROW + 1}"
    assert ws.row_dimensions[TABLE_HEADER_ROW].height >= 17
    assert all(ws.column_dimensions[c].width <= 36 for c in "ABCDEFG")


async def test_dashboard_summary_is_the_served_delivery_read(db_session: Any) -> None:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_schedule_run(db_session, is_active=True)
    await make_project(db_session, hub, name="Dash")
    await db_session.flush()
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as c:
        served = (await c.get("/dashboard/completing-within-year")).json()
        resp = await c.get("/exports/dashboard", params={"format": "xlsx"})
        csv_resp = await c.get("/exports/dashboard", params={"format": "csv"})
    wb = _wb(resp.content)
    # P53 (R53-3): the served delivery-by-year table gets its own sheet.
    assert wb.sheetnames == ["Summary", "Delivery by year", "Dashboard"]
    values = {
        r[0]: r[1] for r in wb["Summary"].iter_rows(values_only=True) if r and r[0] is not None
    }
    assert values["Within year"] == served["within_year_count"]
    assert values["Queued (P3) — not counted this year"] == served["queued_count"]
    assert values["Not scheduled (P4)"] == served["not_scheduled_priority_count"]
    assert values["Within-year share"] == served["within_year_share_pct"]
    # P43-R01: every share is a 1-decimal percent, the headline included.
    share_cells = [r[1] for r in wb["Summary"].iter_rows() if r[0].value == "Within-year share"]
    assert share_cells and all(c.number_format == '0.0"%"' for c in share_cells)
    texts = [r[0] for r in wb["Summary"].iter_rows(values_only=True) if r]
    assert {"By priority", "By hub", "By country (lab region)"} <= set(texts)
    # P43-R01 (workflow A1): the band column says what it counts, and the
    # note states the identity with the headline denominator.
    flat = [c.value for r in wb["Summary"].iter_rows() for c in r if c.value is not None]
    assert "Counted (incl. on hold / cancelled)" in flat
    counted = sum(b["counting_total"] for b in served["priority_delivery"])
    note = next(v for v in flat if isinstance(v, str) and v.startswith("Counted, all bands"))
    assert note.startswith(
        f"Counted, all bands: {counted} = {served['counting_outcome_count']} in the headline"
    )
    # The Dashboard table: Project first, ids last; CSV keeps its own columns.
    header = [c.value for c in wb["Dashboard"][TABLE_HEADER_ROW]]
    assert header[0] == "Project" and header[-1].endswith("ID")
    assert csv_header(csv_resp.content)[0] == "Project ID"


def test_frozen_p4_is_drawn_as_locked_not_queued() -> None:
    """P43-R01 (workflow A4): a frozen P4 / Q project books capacity but is
    not counted; its bucket is QUEUED, yet it is not a queued P3."""

    def bar(name: str, prio: str, frozen: bool) -> Any:
        return GanttProjectBar(
            name=name, hub="R&D-Greece", priority=prio, priority_label=None, leader=None,
            outcome="queued", outcome_text="Queued", frozen=frozen,
            steps=[GanttStepBar("PDD-A", "Marketing Brief", "elapsed", 1, 4, 6)],
        )  # fmt: skip

    chart = GanttChart(
        title="Locked",
        projects=[bar("Frozen P4", "P4", True), bar("Waiting P3", "P3", False),
                  bar("Frozen Q", "Q", True)],
        current_week=10,
        base_year=2026,
    )  # fmt: skip
    ws = _wb(write_workbook(SheetBook(charts={"G": chart})))["G"]
    col_a = [ws.cell(row=r, column=1).value for r in range(CHART_HEADER_ROW + 1, ws.max_row + 1)]
    body = col_a[: col_a.index("Legend")]
    assert body == [
        "Queued (P3) — spare capacity only, not counted this year",
        "Waiting P3", "A · Marketing Brief",
        "Locked P4 / Q — booked, not counted",
        "Frozen P4 (frozen)", "A · Marketing Brief",
        "Frozen Q (frozen)", "A · Marketing Brief",
        None,
    ]  # fmt: skip
    # The locked project's bar is still drawn (hatched: frozen).
    r = CHART_HEADER_ROW + 1 + body.index("Frozen P4 (frozen)") + 1
    assert _week_cell(ws, r, 4).fill.patternType == "lightUp"


async def test_gantt_data_has_a_skipped_column(db_session: Any) -> None:
    """P43-R01 (workflow A3)."""

    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    t_a = await make_workflow_step_template(db_session, step_id="PDD-A", sequence_order=1)
    project = await make_project(db_session, hub, name="Skip")
    run = await make_schedule_run(db_session, is_active=True)
    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id, project_id=project.id, step_template_id=t_a.id,
            sequence_order=1, duration_weeks=0, start_week=30, end_week=30, skipped=True,
        )
    )  # fmt: skip
    await db_session.flush()
    await _as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as c:
        resp = await c.get("/exports/gantt", params={"format": "xlsx"})
    header, data = xlsx_table(resp.content, "Gantt data")
    assert "Skipped" in header
    assert [(d["step_id"], d["skipped"]) for d in data] == [("PDD-A", "Yes")]
    ws = _wb(resp.content)["Gantt"]
    r = _row_of(ws, "A · ")
    assert "(skipped)" in ws.cell(row=r, column=1).value
    assert _weeks_with(ws, r, STEP_PALETTE_HEX[0], 78) == set()
