"""P43-T04 gate (qa-inspector): acceptance tests for ADR 0057 /
docs/API_CONTRACT_P43.md §7 that fill the gaps in test_p43_exports.py.

- every surface `.xlsx` (dashboard, capacity, matrix, gantt, project
  registration, capacity planning) goes through the API and opens with the §7
  sheets in order: a Summary first, a styled header row (navy, bold, white),
  frozen panes under the header, an auto-filter, and no formula anywhere, even
  with a hostile project name and a hostile engineer name in the data;
- the surface Gantt (real DB rows through `GET /exports/gantt`): §7 sections,
  P1 by band rank then P2, the "(VIP)" marker, a status-excluded project as one
  line in the last section, and step rows at outline level 1 under their
  project with the summary above;
- import exports (current result and comparison): every drawn step bar equals
  the served `POST /whatif/import/simulate` / stored scenario weeks, and every
  data sheet has the styled header and frozen panes;
- the planner export's sheets carry the styled header, frozen panes and an
  outline on the step rows;
- cosmetic gaps G1-G3, pinned here as strict xfails at P43-T04 and fixed at
  P43-R01 / P43-R02 (now plain tests):
  G1 every Dashboard Summary share, the headline included, uses `0.0"%"`;
  G2 the Capacity `*_load_by_priority_*` headers are words;
  G3 the comparison "Outcome changes" headers have no raw `finish_week`.
"""

from __future__ import annotations

import io
from typing import Any

import openpyxl
import pytest

import api.routers.whatif as whatif_router
from api.db import get_db
from api.main import app
from models.enums import (
    HubName,
    LabRegion,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    WorkflowStepKind,
)
from models.schedule import ScheduleRunProjectStep
from services.xlsx_writer import (
    CHART_FIRST_WEEK_COLUMN,
    CHART_HEADER_ROW,
    NAVY,
    STEP_PALETTE_HEX,
    TABLE_HEADER_ROW,
)
from tests.auth_helpers import clear_current_principal_override
from tests.factories import (
    make_chamber,
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_workflow_step_template,
)
from tests.test_p32_whatif_import_api import (
    _parsed_rows,
    act_as,
    client_for,
)
from tests.test_p32_whatif_import_api import (
    make_world as make_import_world,
)
from tests.test_p41_qa_gate import save_body
from tests.test_p43_exports import _all_text, _fill_rgb, _no_formulas, _rgb

HOSTILE_PROJECT = '=HYPERLINK("http://x.invalid","P43 hostile")'
HOSTILE_ENGINEER = "+cmd|' /C calc'!A0"
SECTION_FILL = "DBEAFE"
PALE_CURRENT_WEEK = "FEF3C7"

#: API_CONTRACT_P43 §7: sheets, in order, per surface xlsx.
SURFACE_SHEETS: dict[str, list[str]] = {
    "gantt": ["Summary", "Gantt", "Gantt data"],
    "dashboard": ["Summary", "Dashboard"],
    "capacity": ["Summary", "Capacity"],
    "matrix": ["Summary", "Matrix"],
    "project-registration": ["Summary", "Projects"],
    "capacity-planning": ["Summary", "Engineers", "Chambers"],
}


@pytest.fixture(autouse=True)
def _cleanup() -> Any:
    whatif_router.WHATIF_RATE_LIMIT.reset()
    yield
    whatif_router.WHATIF_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _wb(content: bytes) -> Any:
    return openpyxl.load_workbook(io.BytesIO(content))


def _assert_styled_table(ws: Any) -> None:
    """A table sheet: title in A1, the human header on row 5 (navy fill, bold
    white text), frozen below the header, an auto-filter from A5."""

    assert ws["A1"].value and ws["A1"].font.b, ws.title
    header = [c for c in ws[TABLE_HEADER_ROW] if c.value is not None]
    assert header, ws.title
    for c in header:
        assert _fill_rgb(c) == NAVY, (ws.title, c.coordinate)
        assert c.font.b and _rgb(c.font.color) == "FFFFFF", (ws.title, c.coordinate)
    assert ws.freeze_panes and ws.freeze_panes.endswith(str(TABLE_HEADER_ROW + 1)), ws.title
    assert ws.freeze_panes != f"A{TABLE_HEADER_ROW + 1}" or ws.title == "Summary", ws.title
    assert ws.auto_filter.ref and ws.auto_filter.ref.startswith(f"A{TABLE_HEADER_ROW}"), ws.title


def _raw_headers(ws: Any) -> list[str]:
    """Header cells still in `snake_case` (§1: keys become words)."""

    return [
        str(c.value) for c in ws[TABLE_HEADER_ROW]
        if isinstance(c.value, str) and "_" in c.value
    ]  # fmt: skip


def _assert_summary(ws: Any) -> None:
    """A surface Summary: the title block, then at least one blue heading bar
    and a navy header row under it."""

    assert ws.title == "Summary"
    assert ws["A1"].value and str(ws["A1"].value).endswith("Summary") and ws["A1"].font.b
    assert str(ws["A3"].value).startswith("Generated ")
    fills = [_fill_rgb(ws.cell(row=r, column=1)) for r in range(TABLE_HEADER_ROW, ws.max_row + 1)]
    assert SECTION_FILL in fills and NAVY in fills, fills
    assert fills.index(SECTION_FILL) < fills.index(NAVY)


def _assert_chart_sheet(ws: Any) -> None:
    assert ws.freeze_panes == f"H{CHART_HEADER_ROW + 1}", ws.title
    assert ws.auto_filter.ref.startswith(f"A{CHART_HEADER_ROW}:G"), ws.title
    for col in range(1, 8):
        c = ws.cell(row=CHART_HEADER_ROW, column=col)
        assert _fill_rgb(c) == NAVY and c.font.b, (ws.title, c.coordinate)
    assert ws.sheet_properties.outlinePr.summaryBelow is False, ws.title


async def _surface_world(db_session: Any) -> Any:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    t_a = await make_workflow_step_template(db_session, step_id="PDD-A", sequence_order=1)
    t_b = await make_workflow_step_template(
        db_session, step_id="PDD-B", kind=WorkflowStepKind.DESIGN, sequence_order=2
    )
    engineer = await make_engineer(db_session, hub, name=HOSTILE_ENGINEER)
    await make_chamber(db_session, code="CH-QA-1", lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    return hub, (t_a, t_b), engineer, run


async def _place(db_session: Any, run: Any, project: Any, templates: Any, engineer: Any,
                 weeks: list[tuple[int, int]], pinned: bool = False) -> None:  # fmt: skip
    for order, (template, (start, end)) in enumerate(zip(templates, weeks, strict=True), 1):
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id, project_id=project.id, step_template_id=template.id,
                sequence_order=order, duration_weeks=end - start + 1, start_week=start,
                end_week=end, assigned_engineer_id=engineer.id,
                pinned=pinned and order == len(weeks),
            )
        )  # fmt: skip
    await db_session.flush()


# --- every surface xlsx: Summary, styled header, frozen panes, no formula ------------------


@pytest.mark.parametrize("surface", list(SURFACE_SHEETS))
async def test_every_surface_xlsx_is_styled_summarised_and_formula_free(
    db_session: Any, surface: str
) -> None:
    hub, templates, engineer, run = await _surface_world(db_session)
    project = await make_project(
        db_session, hub, name=HOSTILE_PROJECT, leader=engineer, priority=ProjectPriority.P1
    )
    await _place(db_session, run, project, templates, engineer, [(10, 11), (12, 14)])
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.get(f"/exports/{surface}", params={"format": "xlsx"})
    assert resp.status_code == 200, (surface, resp.text)
    assert resp.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    wb = _wb(resp.content)
    assert wb.sheetnames == SURFACE_SHEETS[surface]
    _assert_summary(wb["Summary"])
    for ws in wb.worksheets[1:]:
        if ws.title == "Gantt":
            _assert_chart_sheet(ws)
        else:
            _assert_styled_table(ws)
            if surface != "capacity":  # gap G2, pinned below
                assert _raw_headers(ws) == [], (surface, ws.title)
    # The formula guard holds on every cell of every sheet, chart and Summary
    # included; the hostile text survives as text.
    _no_formulas(wb)
    text = _all_text(wb)
    if surface not in ("capacity", "capacity-planning"):
        assert "'" + HOSTILE_PROJECT in text, surface
    if surface in ("gantt", "capacity-planning"):
        assert "'" + HOSTILE_ENGINEER in text, surface
    # Read-only mode opens it too (what a streaming consumer uses).
    openpyxl.load_workbook(io.BytesIO(resp.content), read_only=True).close()


# --- the surface Gantt: §7 sections, order, VIP marker, outline ------------------------------


async def test_surface_gantt_sections_order_markers_and_outline(db_session: Any) -> None:
    hub, templates, engineer, run = await _surface_world(db_session)
    p2 = await make_project(db_session, hub, name="Alpha P2", priority=ProjectPriority.P2)
    p1_second = await make_project(
        db_session, hub, name="Beta P1", priority=ProjectPriority.P1, band_rank=2
    )
    p1_first = await make_project(
        db_session, hub, name="Zulu P1", priority=ProjectPriority.P1, band_rank=1, is_vip=True
    )
    await make_project(db_session, hub, name="Held", priority=None, status=ProjectStatus.ON_HOLD)
    await _place(db_session, run, p2, templates, engineer, [(5, 6), (7, 8)])
    await _place(db_session, run, p1_second, templates, engineer, [(9, 9), (10, 12)], pinned=True)
    await _place(db_session, run, p1_first, templates, engineer, [(1, 2), (3, 4)])
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        served = (await c.get("/gantt")).json()
        resp = await c.get("/exports/gantt", params={"format": "xlsx"})
    assert resp.status_code == 200, resp.text
    ws = _wb(resp.content)["Gantt"]
    col_a = [ws.cell(row=r, column=1).value for r in range(CHART_HEADER_ROW + 1, ws.max_row + 1)]
    body = col_a[: col_a.index("Legend")]
    while body and body[-1] is None:
        body.pop()
    served_names = {r["project_name"] for r in served["rows"]}
    assert "Held" in served_names  # GET /gantt serves the status-excluded project
    step_a, step_b = (
        f"A · {templates[0].name}",
        f"B · {templates[1].name}",
    )
    expected = [
        "In the plan",
        "Zulu P1 (VIP)", step_a, step_b,  # P1, band rank 1 (before Beta by rank, not name)
        "Beta P1", step_a, f"{step_b} (pinned)",  # P1, band rank 2
        "Alpha P2", step_a, step_b,  # P2
        # A status-excluded project: one line in the last section, no step rows.
        "Not in the plan (status: On Hold, Cancelled, Draft, …)", "Held",
    ]  # fmt: skip
    assert body == expected
    # Outline: step rows level 1 under their project row, summary above, expanded.
    first = CHART_HEADER_ROW + 1
    for offset, value in enumerate(body):
        level = ws.row_dimensions[first + offset].outlineLevel
        is_step = isinstance(value, str) and value[:4] in ("A · ", "B · ")
        assert level == (1 if is_step else 0), (value, level)
        assert not ws.row_dimensions[first + offset].hidden
    assert ws.sheet_properties.outlinePr.summaryBelow is False
    # Section heading rows carry the blue fill.
    assert _fill_rgb(ws.cell(row=first, column=1)) == SECTION_FILL


# --- import exports: drawn bars = served weeks; styled data sheets --------------------------


def _chart_bars(ws: Any) -> dict[tuple[str, str], set[int]]:
    """(project name, step letter) -> weeks with a bar (pale current-week
    cells and empty cells excluded)."""

    header = [c.value for c in ws[CHART_HEADER_ROW]]
    horizon = max(v for v in header if isinstance(v, int))
    out: dict[tuple[str, str], set[int]] = {}
    project = ""
    for r in range(CHART_HEADER_ROW + 1, ws.max_row + 1):
        a = ws.cell(row=r, column=1).value
        if a == "Legend":
            break
        if not isinstance(a, str):
            continue
        if ws.row_dimensions[r].outlineLevel == 0:
            project = a.removesuffix(" (VIP, frozen)").removesuffix(" (VIP)")
            project = project.removesuffix(" (frozen)")
            continue
        weeks = set()
        for w in range(1, horizon + 1):
            cell = ws.cell(row=r, column=CHART_FIRST_WEEK_COLUMN + w - 1)
            colour = _fill_rgb(cell)
            if colour and colour != PALE_CURRENT_WEEK:
                weeks.add(w)
        out[(project, a[0])] = weeks
    return out


def _served_bars(result: dict[str, Any]) -> dict[tuple[str, str], set[int]]:
    out: dict[tuple[str, str], set[int]] = {}
    for p in result["projects"]:
        for st in p["steps"]:
            if st["skipped"] or st["start_week"] is None:
                weeks: set[int] = set()
            else:
                weeks = set(range(st["start_week"], st["end_week"] + 1))
            out[(p["name"], st["step_id"][-1])] = weeks
    return out


def _bar_colours_match_palette(ws: Any) -> None:
    allowed = {h.upper() for h in STEP_PALETTE_HEX} | {"64748B", PALE_CURRENT_WEEK}
    for r in range(CHART_HEADER_ROW + 1, min(ws.max_row, CHART_HEADER_ROW + 200) + 1):
        if ws.cell(row=r, column=1).value == "Legend":
            break
        for col in range(CHART_FIRST_WEEK_COLUMN, ws.max_column + 1):
            colour = _fill_rgb(ws.cell(row=r, column=col))
            if colour and colour != SECTION_FILL:
                assert colour.upper() in allowed, (r, col, colour)


async def test_import_exports_draw_the_served_weeks(db_session: Any) -> None:
    await make_import_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        req = {"rows": rows}
        sim = await c.post("/whatif/import/simulate", json=req)
        assert sim.status_code == 200, sim.text
        current = await c.post("/whatif/import/export.xlsx", json={"name": "cur", "request": req})
        a = (await c.post("/whatif/import/scenarios", json=save_body(req, name="A"))).json()
        b_req = {"rows": rows[: max(1, len(rows) // 2)]}
        b = (await c.post("/whatif/import/scenarios", json=save_body(b_req, name="B"))).json()
        saved_a = (await c.get(f"/whatif/import/scenarios/{a['id']}")).json()
        saved_b = (await c.get(f"/whatif/import/scenarios/{b['id']}")).json()
        compare = await c.get(f"/whatif/import/scenarios/compare.xlsx?ids={a['id']},{b['id']}")
    assert current.status_code == 200 and compare.status_code == 200

    wb = _wb(current.content)
    served = _served_bars(sim.json())
    drawn = _chart_bars(wb["Gantt"])
    assert served and drawn == served
    _bar_colours_match_palette(wb["Gantt"])
    _assert_chart_sheet(wb["Gantt"])
    for name in ("Breakdown", "Projects", "Steps", "Capacity"):
        _assert_styled_table(wb[name])
        assert _raw_headers(wb[name]) == [], name
    assert wb["Summary"].cell(row=TABLE_HEADER_ROW, column=1).value == "Item"
    _no_formulas(wb)

    cmp_wb = _wb(compare.content)
    for sheet, saved in (("Gantt S1", saved_a), ("Gantt S2", saved_b)):
        result = saved.get("result") or saved
        assert _chart_bars(cmp_wb[sheet]) == _served_bars(result), sheet
        _assert_chart_sheet(cmp_wb[sheet])
    for name in ("KPIs", "Outcome changes"):
        _assert_styled_table(cmp_wb[name])  # header text: gap G3, pinned below
    _no_formulas(cmp_wb)


# --- cosmetic gaps G1-G3 (fixed at P43-R01 / P43-R02) -----------------------------------


async def test_capacity_headers_are_human(db_session: Any) -> None:
    hub, templates, engineer, run = await _surface_world(db_session)
    project = await make_project(db_session, hub, name="Cap", priority=ProjectPriority.P1)
    await _place(db_session, run, project, templates, engineer, [(10, 11), (12, 14)])
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.get("/exports/capacity", params={"format": "xlsx"})
    assert _raw_headers(_wb(resp.content)["Capacity"]) == []


async def test_comparison_outcome_change_headers_are_human(db_session: Any) -> None:
    await make_import_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        a = (
            await c.post("/whatif/import/scenarios", json=save_body({"rows": rows}, name="A"))
        ).json()
        b = (
            await c.post("/whatif/import/scenarios", json=save_body({"rows": rows[:1]}, name="B"))
        ).json()
        resp = await c.get(f"/whatif/import/scenarios/compare.xlsx?ids={a['id']},{b['id']}")
    assert resp.status_code == 200
    assert _raw_headers(_wb(resp.content)["Outcome changes"]) == []


async def test_dashboard_summary_shares_use_one_format(db_session: Any) -> None:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_schedule_run(db_session, is_active=True)
    await make_project(db_session, hub, name="Dash", priority=ProjectPriority.P1)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.get("/exports/dashboard", params={"format": "xlsx"})
    ws = _wb(resp.content)["Summary"]
    formats: dict[str, str] = {}
    share_columns: set[int] = set()
    for row in ws.iter_rows(min_row=TABLE_HEADER_ROW):
        for c in row:
            if isinstance(c.value, str) and "share" in c.value.lower():
                share_columns.add(c.column)
                if c.column == 1:  # a key / value row: the value is in B
                    formats[c.value] = ws.cell(row=c.row, column=2).number_format
    for row in ws.iter_rows(min_row=TABLE_HEADER_ROW):
        for c in row:
            if c.column in share_columns and c.column != 1 and isinstance(c.value, (int, float)):
                formats[c.coordinate] = c.number_format
    assert formats and len(set(formats.values())) == 1, formats
