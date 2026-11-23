"""P58-B: the Projects list download has exactly the Projects table's columns,
and an edited copy of it is accepted by the What-if import.

Disposable Postgres (the shared fixture), the real engine, the world of
`tests.test_p32_whatif_import_api`.
"""

from __future__ import annotations

import csv
import io
from typing import Any

import openpyxl
import pytest

from models.enums import RoleName
from services.register_export import (
    REGISTER_COLUMNS,
    parse_number,
    parse_rank,
    parse_step,
    parse_week,
    resolve_columns,
)
from tests.plan_import_helpers import SECRET_CUSTOMER
from tests.test_p32_whatif_import_api import (
    XLSX,
    _cleanup,  # noqa: F401  (autouse fixture)
    act_as,
    client_for,
    make_world,
    parse,
)

DEFAULT_HEADERS = [
    "#",
    "Project",
    "Project code",
    "Hub",
    "Category",
    "Type",
    "Status",
    "Leader",
    "Actual start",
    "Actual end",
    "Design time",
    "Lab time",
    "End week",
    "Current step",
    "Steps",
    "Priority",
    "Rank",
    "Project ID",
]
HEADER_ROW = 5  # the styled writer's table header row (title block above)


async def _export(c: Any, **params: Any) -> bytes:
    resp = await c.get(
        "/exports/dashboard", params={"view": "register", "format": "xlsx", **params}
    )
    assert resp.status_code == 200, resp.text
    assert 'filename="projects-list.xlsx"' in resp.headers["content-disposition"]
    return resp.content


def _sheet(data: bytes) -> tuple[Any, Any, list[str]]:
    wb = openpyxl.load_workbook(io.BytesIO(data))
    assert wb.sheetnames == ["Projects"]
    ws = wb["Projects"]
    headers = [c.value for c in ws[HEADER_ROW] if c.value is not None]
    return wb, ws, headers


def _rows_by_name(ws: Any, headers: list[str]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for r in ws.iter_rows(min_row=HEADER_ROW + 1, values_only=True):
        cells = dict(zip(headers, r, strict=False))
        if cells.get("Project"):
            out[str(cells["Project"])] = cells
    return out


def _set(ws: Any, headers: list[str], name: str, column: str, value: Any) -> None:
    col = headers.index(column) + 1
    for r in range(HEADER_ROW + 1, ws.max_row + 1):
        if ws.cell(r, headers.index("Project") + 1).value == name:
            ws.cell(r, col).value = value
            return
    raise AssertionError(name)


def _save(wb: Any) -> bytes:
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --- the download ---------------------------------------------------------------------------


def test_resolve_columns_default_and_selection():
    assert [c.header for c in resolve_columns(None)] == DEFAULT_HEADERS
    picked = resolve_columns(["current-step", "hub", "charter-plant"])
    assert [c.header for c in picked] == [
        "#", "Project", "Project code", "Hub", "Plant", "Current step", "Project ID",
    ]  # fmt: skip
    with pytest.raises(ValueError):
        resolve_columns(["hub", "tcogs_eur"])
    assert REGISTER_COLUMNS[-1].header == "Project ID"


def test_cell_readers():
    assert parse_week("W12 2026") == (12, True)
    assert parse_week("W1 2027") == (53, True)
    assert parse_week("W5 '27") == (57, True)
    assert parse_week(30) == (30, True)
    assert parse_week("") == (None, True)
    assert parse_week("soon")[1] is False
    assert parse_step("PDD-C · Concept") == ("PDD-C", True)
    assert parse_step("oem - b") == ("OEM-B", True)
    assert parse_step("later")[1] is False
    assert parse_rank("P1 · 3") == (3, True)
    assert parse_rank(4.0) == (4, True)
    assert parse_number("2.5") == (2.5, True)
    assert parse_number(20000)[1] is False and parse_number(-1)[1] is False


async def test_register_download_has_exactly_the_screen_columns(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        data = await _export(c)
        csv_resp = await c.get("/exports/dashboard", params={"view": "register"})
        picked = await _export(c, columns=["hub", "current-step"])
        bad = await c.get(
            "/exports/dashboard", params={"view": "register", "columns": ["hub", "customer_name"]}
        )
        dashboard = await c.get("/exports/dashboard", params={"format": "xlsx"})
    _, ws, headers = _sheet(data)
    assert headers == DEFAULT_HEADERS
    rows = _rows_by_name(ws, headers)
    assert set(rows) == {"Alpha Cooler", "Beta Cooler", "Gamma Cooler", "Delta Held"}
    alpha = rows["Alpha Cooler"]
    assert alpha["Project ID"] == str(world.alpha.id)
    assert alpha["Project code"] == "26-00001"
    assert alpha["Priority"] == "P2" and alpha["Status"] == "In Queue"
    # The world has no step rows, so the served current step is empty.
    assert alpha["Current step"] is None
    # No financial value anywhere in the file.
    assert all(
        SECRET_CUSTOMER not in str(v) for r in ws.iter_rows(values_only=True) for v in r if v
    )
    # CSV: the same headers, in order.
    assert csv_resp.status_code == 200
    first = next(csv.reader(io.StringIO(csv_resp.content.decode("utf-8-sig"))))
    assert first == DEFAULT_HEADERS
    # `columns`: the fixed columns plus the visible ones, in screen order.
    _, _, picked_headers = _sheet(picked)
    assert picked_headers == ["#", "Project", "Project code", "Hub", "Current step", "Project ID"]
    assert bad.status_code == 422 and bad.json()["code"] == "INVALID_COLUMNS"
    # The Dashboard's own export is unchanged (its own sheets).
    wb = openpyxl.load_workbook(io.BytesIO(dashboard.content))
    assert "Dashboard" in wb.sheetnames


# --- the round trip -------------------------------------------------------------------------


async def test_round_trip_without_edits_has_no_change(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        data = await _export(c)
        resp = await parse(c, data, name="projects-list.xlsx", ctype=XLSX)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        sim = await c.post("/whatif/import/simulate", json={"rows": body["rows"]})
    assert body["file_format"] == "projects_list"
    assert body["projects_sheet"] == "Projects"
    assert {r["change_kind"] for r in body["rows"]} == {"unchanged"}
    assert all(r["changes"] == [] for r in body["rows"])
    assert all(r["match_by"] == "id" for r in body["rows"])
    assert body["counts"]["changed"] == 0 and body["counts"]["unchanged"] == 4
    assert body["counts"]["projects_after_expansion"] == 0
    assert not [i for i in body["issues"] if i["code"] in ("CHANGED", "NOT_SIMULATED")]
    # Simulated: nothing replaces anything; the plan runs as it is.
    assert sim.status_code == 200, sim.text
    s = sim.json()
    assert s["kpis"]["file_projects"] == 0
    assert {p["source"] for p in s["projects"]} == {"plan"}
    assert s["changes"]["newly_slipping"] == [] and s["changes"]["moved"] == []


async def test_edited_rows_and_a_new_row_are_the_changes(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        wb, ws, headers = _sheet(await _export(c))
        _set(ws, headers, "Alpha Cooler", "Priority", "P1")
        _set(ws, headers, "Gamma Cooler", "Category", "B")
        # Renamed, still matched by its Project ID; a code is not simulated.
        _set(ws, headers, "Beta Cooler", "Project code", "26-99999")
        new_row = {
            "Project": "Brand New Cooler",
            "Hub": "R&D-Greece",
            "Category": "C",
            "Status": "In Queue",
            "Priority": "P2",
            "Design time": 6,
        }
        ws.append([new_row.get(h) for h in headers])
        resp = await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        by = {r["name"]: r for r in body["rows"]}
        sim = await c.post(
            "/whatif/import/simulate", json={"rows": body["rows"], "plan_year_end_week": 104}
        )

    alpha, gamma, beta = by["Alpha Cooler"], by["Gamma Cooler"], by["Beta Cooler"]
    assert alpha["change_kind"] == "changed" and alpha["priority"] == "P1"
    assert [(x["field"], x["before"], x["after"]) for x in alpha["changes"]] == [
        ("priority", "P2", "P1")
    ]
    assert alpha["matched_project_id"] == str(world.alpha.id)
    assert alpha["lead_time_label"] == "plan"
    assert gamma["change_kind"] == "changed" and gamma["category"] == "B"
    assert [(x["field"], x["before"], x["after"]) for x in gamma["changes"]] == [
        ("category", "C", "B")
    ]
    assert gamma["lead_time_label"] == "app"
    # A code-only edit is listed but is not a scheduling change.
    assert beta["change_kind"] == "unchanged"
    assert [(x["field"], x["simulated"]) for x in beta["changes"]] == [("code", False)]
    assert by["Delta Held"]["change_kind"] == "unchanged"
    new = by["Brand New Cooler"]
    assert new["change_kind"] == "new" and new["matched_project_id"] is None
    assert (new["hub"], new["category"], new["priority"], new["status"]) == (
        "R&D-Greece", "C", "P2", "In Queue",
    )  # fmt: skip
    design_steps = {
        m["step_id"] for m in body["steps_meta"] if m["workflow"] == "PDD" and m["kind"] == "design"
    }
    assert sum(w for s, w in new["step_weeks"].items() if s in design_steps) == 6
    counts = body["counts"]
    assert (counts["changed"], counts["unchanged"], counts["new"]) == (2, 2, 1)
    codes = {(i["row_key"], i["code"]) for i in body["issues"]}
    assert (alpha["key"], "CHANGED") in codes and (beta["key"], "NOT_SIMULATED") in codes

    # B2 (2026-11-23 audit): Alpha and Gamma keep their current step, so they
    # are edited in place (plan projects); only the new row is a file project.
    assert counts["projects_after_expansion"] == 1
    assert sim.status_code == 200, sim.text
    s = sim.json()
    files = [p for p in s["projects"] if p["source"] == "file"]
    assert {p["name"] for p in files} == {"Brand New Cooler"}
    assert s["kpis"]["file_projects"] == 1
    plan = {p["ref"]: p for p in s["projects"] if p["source"] == "plan"}
    assert {str(world.alpha.id), str(world.beta.id), str(world.gamma.id)} <= set(plan)
    assert plan[str(world.alpha.id)]["priority"] == "P1"
    assert plan[str(world.gamma.id)]["category"] == "B"


async def test_project_id_match_survives_a_rename_and_unknown_id_is_new(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        wb, ws, headers = _sheet(await _export(c))
        _set(ws, headers, "Alpha Cooler", "Project", "Alpha Cooler Mk2")
        _set(ws, headers, "Gamma Cooler", "Project ID", "00000000-0000-0000-0000-000000000000")
        _set(ws, headers, "Gamma Cooler", "Project", "Gamma Elsewhere")
        resp = await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)
    assert resp.status_code == 200, resp.text
    by = {r["name"]: r for r in resp.json()["rows"]}
    mk2 = by["Alpha Cooler Mk2"]
    assert mk2["matched_project_id"] == str(world.alpha.id) and mk2["match_by"] == "id"
    assert [(x["field"], x["simulated"]) for x in mk2["changes"]] == [("project", False)]
    # B2 (a): a rename is listed, never simulated; the plan project is kept.
    assert mk2["change_kind"] == "unchanged"
    assert by["Gamma Elsewhere"]["change_kind"] == "new"
    codes = {i["code"] for i in resp.json()["issues"]}
    assert "PROJECT_ID_UNKNOWN" in codes


async def test_hub_planner_sees_only_their_projects_in_the_round_trip(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        admin_file = await _export(c)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        own = await _export(c)
        resp = await parse(c, admin_file, name="projects-list.xlsx", ctype=XLSX)
    _, ws, headers = _sheet(own)
    assert set(_rows_by_name(ws, headers)) == {"Alpha Cooler", "Gamma Cooler"}
    assert resp.status_code == 200, resp.text
    by = {r["name"]: r for r in resp.json()["rows"]}
    # India projects are outside the planner's scope: read as new, never matched.
    assert by["Beta Cooler"]["change_kind"] == "new"
    assert by["Beta Cooler"]["matched_project_id"] is None
    assert by["Alpha Cooler"]["change_kind"] == "unchanged"


async def _start(db_session, project: Any) -> None:
    """Give `project` its 14 PDD step rows as recorded progress the list
    cannot carry: A to C Done, D In Progress at 50 %, and E already Done
    out of order (the audit's b275a1c3 shape)."""

    from models.enums import ProjectStatus, WorkflowStepStatus
    from models.workflow import ProjectWorkflowStep

    for i, letter in enumerate("ABCDEFGHIJKLMN", start=1):
        status = (
            WorkflowStepStatus.DONE
            if letter in "ABCE"
            else WorkflowStepStatus.IN_PROGRESS
            if letter == "D"
            else WorkflowStepStatus.NOT_STARTED
        )
        db_session.add(
            ProjectWorkflowStep(
                project_id=project.id,
                step_template_id=f"PDD-{letter}",
                sequence_order=i,
                duration_weeks=2,
                status=status,
                actual_start_week=10 if letter in "ABCDE" else None,
                actual_end_week=11 if letter in "ABCE" else None,
                percent_complete=100 if letter in "ABCE" else 50 if letter == "D" else 0,
            )
        )
    project.status = ProjectStatus.IN_DEVELOPMENT
    await db_session.flush()


def _steps(sim: Any, name: str) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    p = next(p for p in sim.json()["projects"] if p["name"] == name)
    return p, {s["step_id"]: s for s in p["steps"]}


def _comparable(sim: Any) -> Any:
    out = sim.json()
    out.pop("issues", None)
    return out


async def test_rename_only_is_the_live_plan_exactly(db_session):
    """B2 (a): renaming a started project simulates nothing: no movement and
    the same result as the unedited list."""

    world = await make_world(db_session)
    await _start(db_session, world.gamma)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        wb, ws, headers = _sheet(await _export(c))
        same = (await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)).json()
        _set(ws, headers, "Gamma Cooler", "Project", "Gamma Cooler renamed")
        body = (await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)).json()
        live = await c.post("/whatif/import/simulate", json={"rows": same["rows"]})
        sim = await c.post("/whatif/import/simulate", json={"rows": body["rows"]})
    g = next(r for r in body["rows"] if r["matched_project_id"] == str(world.gamma.id))
    assert g["change_kind"] == "unchanged"
    assert [(x["field"], x["simulated"]) for x in g["changes"]] == [("project", False)]
    assert body["counts"]["changed"] == 0 and body["counts"]["projects_after_expansion"] == 0
    assert sim.status_code == 200 and live.status_code == 200, sim.text
    assert sim.json()["changes"] == {"newly_slipping": [], "recovered": [], "moved": []}
    assert _comparable(sim) == _comparable(live)
    _, steps = _steps(sim, "Gamma Cooler")
    assert steps["PDD-E"]["status"] == "Done" and steps["PDD-D"]["status"] == "In Progress"


async def test_priority_edit_on_a_started_project_keeps_its_progress(db_session):
    """B2 (b): a priority edit keeps Done / In Progress steps and the remaining
    effort; only the priority changes. The current step is not rebuilt."""

    world = await make_world(db_session)
    await _start(db_session, world.gamma)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        wb, ws, headers = _sheet(await _export(c))
        same = (await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)).json()
        _set(ws, headers, "Gamma Cooler", "Priority", "P1")
        body = (await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)).json()
        live = await c.post("/whatif/import/simulate", json={"rows": same["rows"]})
        sim = await c.post("/whatif/import/simulate", json={"rows": body["rows"]})
    gamma = next(r for r in body["rows"] if r["name"] == "Gamma Cooler")
    assert gamma["change_kind"] == "changed" and gamma["status"] == "In Development"
    assert body["counts"]["projects_after_expansion"] == 0
    assert any(
        i["code"] == "CHANGED" and "in place" in i["message"]
        for i in body["issues"]
        if i["row_key"] == gamma["key"]
    )
    assert sim.status_code == 200, sim.text
    assert sim.json()["kpis"]["file_projects"] == 0
    g, steps = _steps(sim, "Gamma Cooler")
    lg, live_steps = _steps(live, "Gamma Cooler")
    assert g["source"] == "plan" and g["ref"] == str(world.gamma.id) and g["priority"] == "P1"
    for sid in ("PDD-A", "PDD-B", "PDD-C", "PDD-E"):
        assert steps[sid]["status"] == "Done", sid
    assert steps["PDD-D"]["status"] == "In Progress"
    # The In Progress step keeps its recorded start and remaining effort.
    assert (steps["PDD-D"]["start_week"], steps["PDD-D"]["end_week"]) == (
        live_steps["PDD-D"]["start_week"],
        live_steps["PDD-D"]["end_week"],
    )
    assert g["finish_week"] <= lg["finish_week"]


async def test_current_step_edit_rebuilds_from_the_list(db_session):
    """B2 (c): only an edited Current step rebuilds progress from the list."""

    world = await make_world(db_session)
    await _start(db_session, world.gamma)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        wb, ws, headers = _sheet(await _export(c))
        _set(ws, headers, "Gamma Cooler", "Current step", "PDD-H")
        body = (await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)).json()
        sim = await c.post("/whatif/import/simulate", json={"rows": body["rows"]})
    gamma = next(r for r in body["rows"] if r["name"] == "Gamma Cooler")
    assert gamma["change_kind"] == "changed" and gamma["stage_step_id"] == "PDD-H"
    assert sim.status_code == 200, sim.text
    g, steps = _steps(sim, "Gamma Cooler")
    assert g["source"] == "file" and g["replaces_project_id"] == str(world.gamma.id)
    assert steps["PDD-A"]["done_before_import"] and steps["PDD-E"]["done_before_import"]
    # Rebuilt: D (In Progress live) is now done before the import.
    assert steps["PDD-D"]["done_before_import"]
    assert steps["PDD-H"]["status"] == "In Progress"


async def test_priority_edit_on_a_cancelled_project_is_not_simulated(db_session):
    """B2 (d): priority is Not applicable on a Cancelled project (ADR 0067); an
    edit there is listed with an info issue and the totals stay the same."""

    from models.enums import ProjectStatus

    world = await make_world(db_session)
    world.delta.status = ProjectStatus.CANCELLED
    await db_session.flush()
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        wb, ws, headers = _sheet(await _export(c))
        same = (await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)).json()
        _set(ws, headers, "Delta Held", "Priority", "P1")
        body = (await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)).json()
        live = await c.post("/whatif/import/simulate", json={"rows": same["rows"]})
        sim = await c.post("/whatif/import/simulate", json={"rows": body["rows"]})
    delta = next(r for r in body["rows"] if r["name"] == "Delta Held")
    assert delta["change_kind"] == "unchanged"
    assert [(x["field"], x["simulated"]) for x in delta["changes"]] == [("priority", False)]
    assert (delta["key"], "PRIORITY_NOT_APPLICABLE") in {
        (i["row_key"], i["code"]) for i in body["issues"]
    }
    assert sim.status_code == 200, sim.text
    assert sim.json()["kpis"] == live.json()["kpis"]


def test_in_place_runner_without_edits_is_run_plan_import():
    """Drift guard: the in-place runner mirrors `run_plan_import` step by step."""

    import dataclasses

    from scheduling.plan_import import PlanImportRequest, run_plan_import
    from services.whatif_import_register import run_plan_import_in_place
    from tests.scheduling._whatif_fixtures import portfolio_baseline

    live = portfolio_baseline()
    after = dataclasses.replace(live, schedule=dataclasses.replace(live.schedule))
    req = PlanImportRequest(projects=(), mode="merge")
    assert run_plan_import_in_place(live, after, req) == run_plan_import(live, req)


async def test_leader_not_counted_in_capacity_is_kept(db_session):
    """2026-11-23 (orchestrator, end-to-end test): a plan leader who does not
    count in capacity is matched, not read as missing. A No-change row keeps
    the leader, a Changed row keeps it too, and no ENGINEER_MISSING is raised."""

    world = await make_world(db_session)
    world.eng_gr.counts_in_capacity = False
    await db_session.flush()
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        wb, ws, headers = _sheet(await _export(c))
        _set(ws, headers, "Gamma Cooler", "Status", "In Development")
        body = (await parse(c, _save(wb), name="projects-list.xlsx", ctype=XLSX)).json()
        sim = await c.post("/whatif/import/simulate", json={"rows": body["rows"]})
    by = {r["name"]: r for r in body["rows"]}
    want = {"kind": "existing", "engineer_id": str(world.eng_gr.id)}
    assert by["Alpha Cooler"]["change_kind"] == "unchanged"
    assert by["Alpha Cooler"]["leader"]["engineer_id"] == want["engineer_id"]
    assert by["Gamma Cooler"]["change_kind"] == "changed"
    assert by["Gamma Cooler"]["leader"]["engineer_id"] == want["engineer_id"]
    gr_keys = {by["Alpha Cooler"]["key"], by["Gamma Cooler"]["key"]}
    assert not [
        i for i in body["issues"] if i["row_key"] in gr_keys and i["code"] == "ENGINEER_MISSING"
    ]
    assert sim.status_code == 200, sim.text
