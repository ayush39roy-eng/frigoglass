"""P41-T04 gate (qa-inspector): extra acceptance tests for ADR 0055 /
docs/API_CONTRACT_P41.md, filling the thin spots of test_p41_import_scenarios.py.

- the template round-trips through the parser with every field filled, for the
  built-in and an edited format;
- an edited alias is used by /import/parse (case and spacing normalised, any
  alias, not just the first), and reset brings the built-in headers back;
- the 409 version conflict leaves the stored format and the audit untouched;
- the 403 for non-admins leaves the stored format untouched;
- excluded plan projects are absent from the before run as well as the after
  run (equal to a world where the project is not schedulable), and
  `plan_excluded` counts only what is actually taken out;
- a saved scenario equals a fresh simulate of the same request at the same week,
  with an active run (plan_version set), non-default options and edits;
- the compare-id rules (2..4, unique, uuid, visible);
- export workbooks open and have the stated sheets;
- an Admin snapshot is 404 to a hub viewer (R01 H-1); a same-scope snapshot
  carries no capacity rows for hubs outside that viewer's scope.
"""

from __future__ import annotations

import io
import uuid
from typing import Any

import openpyxl
import pytest
from sqlalchemy import select

import api.routers.whatif as whatif_router
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import ProjectStatus, RoleName
from services.plan_import_xlsx import FIELD_KEYS, parse_plan_workbook
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_schedule_run
from tests.test_p32_plan_import_xlsx import _ctx
from tests.test_p32_whatif_import_api import (
    _parsed_rows,
    act_as,
    client_for,
    make_world,
    parse,
)

SHA = "c" * 64
SHA2 = "d" * 64


@pytest.fixture(autouse=True)
def _cleanup():
    whatif_router.WHATIF_RATE_LIMIT.reset()
    yield
    whatif_router.WHATIF_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def audit_count(db_session, action: str) -> int:
    stmt = select(AuditLogEntry).where(AuditLogEntry.action == action)
    return len((await db_session.execute(stmt)).scalars().all())


def save_body(request: dict[str, Any], **kw: Any) -> dict[str, Any]:
    return {
        "name": "QA scenario",
        "source_file_name": "qa.xlsx",
        "source_file_sha256": SHA,
        "imported_at": "2026-11-17T10:00:00Z",
        "request": request,
        **kw,
    }


def wb_of(data: bytes) -> openpyxl.Workbook:
    return openpyxl.load_workbook(io.BytesIO(data))


def header_of(data: bytes) -> list[Any]:
    return [c.value for c in next(wb_of(data)["Projects"].iter_rows(max_row=1))]


def fill_template(data: bytes, values: dict[str, Any]) -> bytes:
    """Append one data row to a downloaded template, by FIELD_KEYS key."""

    wb = wb_of(data)
    ws = wb["Projects"]
    header = [c.value for c in next(ws.iter_rows(max_row=1))]
    line: list[Any] = [None] * len(header)
    for key, value in values.items():
        line[header.index(key)] = value
    ws.append(line)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --- A. template round trip, aliases, 409, 403 ----------------------------------------------


async def test_template_round_trip_every_field_builtin_and_edited(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        for edited in (False, True):
            if edited:
                new = {k: [f"qa {k.replace('_', ' ')} col"] for k in FIELD_KEYS}
                put = await c.put("/whatif/import/format", json={"version": 0, "fields": new})
                assert put.status_code == 200, put.text
            fmt = (await c.get("/whatif/import/format")).json()
            tpl = await c.get("/whatif/import/format/template.xlsx")
            assert tpl.status_code == 200
            header = header_of(tpl.content)
            # Row 1 = first alias of each field, Title Case, FIELD_KEYS order.
            assert header == [f["aliases"][0].title() for f in fmt["fields"]]
            col = {f["key"]: f["aliases"][0].title() for f in fmt["fields"]}
            filled = fill_template(
                tpl.content,
                {
                    col["sn"]: 7,
                    col["code"]: "26-00001",
                    col["plant"]: "PL-1",
                    col["expenses"]: "OPEX",
                    col["priority"]: 3,
                    col["name"]: "Alpha Cooler",
                    col["hub"]: "Greece",
                    col["category"]: "C",
                    col["status"]: "Que",
                    col["engineer"]: "Kanarios",
                    col["num_projects"]: 2,
                    col["must_do"]: "Yes",
                    col["complexity"]: "High",
                    col["est_duration"]: "6",
                },
            )
            # The pure parser with the stored aliases and the API both read it.
            if not edited:
                pure = parse_plan_workbook(filled, _ctx())
                assert [r.name for r in pure.rows] == ["Alpha Cooler"]
            resp = await parse(c, filled, name="tpl.xlsx")
            assert resp.status_code == 200, (edited, resp.text)
            (r,) = resp.json()["rows"]
            assert r["name"] == "Alpha Cooler"
            assert r["sn"] == "7" and r["code"] == "26-00001"
            assert r["hub"] == "R&D-Greece" and r["category"] == "C"
            assert r["status"] == "In Queue"
            assert r["rank"] == 3 and r["priority"] == "P1"
            assert r["num_projects"] == 2 and r["must_do"] is True
            assert r["complexity"] == "High" and r["est_duration_months"] == "6"
            assert r["matched_project_id"] == str(world.alpha.id)
            assert r["engineer_raw"] == "Kanarios"


async def test_any_edited_alias_is_used_normalised_and_reset_restores(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    from tests.plan_import_helpers import build_workbook, row

    def file_with(name_header: str) -> bytes:
        return build_workbook(
            [row(name="Second Alias Cooler", hub="Greece", category="C", status="Que")],
            rename={"Project description": name_header},
        )

    async with client_for(db_session) as c:
        put = await c.put(
            "/whatif/import/format",
            json={"version": 0, "fields": {"name": ["Headline", "Project   TITLE"]}},
        )
        assert put.status_code == 200, put.text
        # The second alias, written in another case and with extra spaces.
        got = await parse(c, file_with("  project Title  "))
        assert got.status_code == 200, got.text
        assert [r["name"] for r in got.json()["rows"]] == ["Second Alias Cooler"]
        # The built-in header is no longer read.
        assert (await parse(c, file_with("Project description"))).status_code == 422
        reset = await c.post("/whatif/import/format/reset", json={"version": 1})
        assert reset.status_code == 200, reset.text
        assert (await parse(c, file_with("Project description"))).status_code == 200
        assert (await parse(c, file_with("Project Title"))).status_code == 422


async def test_version_conflict_leaves_format_and_audit_untouched(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        first = await c.put(
            "/whatif/import/format", json={"version": 0, "fields": {"plant": ["factory"]}}
        )
        assert first.status_code == 200
    # A second admin, still holding version 0.
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as c:
        for bad_version in (0, 2, 99):
            stale = await c.put(
                "/whatif/import/format",
                json={"version": bad_version, "fields": {"plant": ["works"]}},
            )
            assert stale.status_code == 409, stale.text
            assert stale.json()["code"] == "FORMAT_VERSION_CONFLICT"
            stale_reset = await c.post("/whatif/import/format/reset", json={"version": bad_version})
            assert stale_reset.status_code == 409
            assert stale_reset.json()["code"] == "FORMAT_VERSION_CONFLICT"
        now = (await c.get("/whatif/import/format")).json()
    assert now["version"] == 1
    plant = next(f for f in now["fields"] if f["key"] == "plant")
    assert plant["aliases"] == ["factory"]
    assert await audit_count(db_session, "import_format.updated") == 1
    assert await audit_count(db_session, "import_format.reset") == 0


@pytest.mark.parametrize(
    "role",
    [RoleName.PORTFOLIO_MANAGER, RoleName.HUB_PLANNER],
)
async def test_non_admin_403_leaves_format_untouched_and_reads_can_edit_false(db_session, role):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        assert (
            await c.put("/whatif/import/format", json={"version": 0, "fields": {"plant": ["f"]}})
        ).status_code == 200
    hub_ids = [world.gr.id] if role is RoleName.HUB_PLANNER else None
    await act_as(db_session, role, hub_ids=hub_ids)
    async with client_for(db_session) as c:
        # Even with the right version, and even a no-op body.
        for body in ({"version": 1, "fields": {"plant": ["g"]}}, {"version": 1, "fields": {}}):
            resp = await c.put("/whatif/import/format", json=body)
            assert resp.status_code == 403, resp.text
        assert (await c.post("/whatif/import/format/reset", json={"version": 1})).status_code == 403
        got = (await c.get("/whatif/import/format")).json()
    assert got["can_edit"] is False and got["version"] == 1
    assert next(f for f in got["fields"] if f["key"] == "plant")["aliases"] == ["f"]
    assert await audit_count(db_session, "import_format.updated") == 1
    assert await audit_count(db_session, "import_format.reset") == 0


# --- B. exclusion: absent from both runs -----------------------------------------------------


def _by_ref(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {p["ref"]: p for p in body["projects"]}


def _project_view(p: dict[str, Any]) -> tuple[Any, ...]:
    return (
        p["outcome"], p["finish_week"], p["start_week"], p["before_outcome"],
        p["before_finish_week"], p["leader_name"],
        tuple((s["step_id"], s["start_week"], s["end_week"]) for s in p["steps"]),
    )  # fmt: skip


async def test_excluded_plan_project_is_absent_from_the_before_run_too(db_session):
    """Excluding Gamma must give exactly the run of a plan in which Gamma is
    not schedulable: same per-project before AND after figures for everyone
    else, same before/after KPIs."""

    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        picked = await c.post(
            "/whatif/import/simulate",
            json={"rows": rows, "exclude_plan_project_ids": [str(world.gamma.id)]},
        )
        assert picked.status_code == 200, picked.text
        a = picked.json()
        world.gamma.status = ProjectStatus.CANCELLED
        world.gamma.band_rank = None  # P36 membership CHECK
        await db_session.flush()
        b = (await c.post("/whatif/import/simulate", json={"rows": rows})).json()
    gid = str(world.gamma.id)
    assert gid not in _by_ref(a) and gid not in _by_ref(b)
    for lst in ("newly_slipping", "recovered", "moved"):
        assert gid not in {x["ref"] for x in a["changes"][lst]}
    assert set(_by_ref(a)) == set(_by_ref(b))
    for ref, pa in _by_ref(a).items():
        assert _project_view(pa) == _project_view(_by_ref(b)[ref]), ref
    for k in (
        "within_plan_year", "spillover", "left_out", "blocked", "file_projects",
        "file_within_plan_year", "before_within_plan_year",
        "after_within_plan_year_existing", "newly_slipping", "recovered",
    ):  # fmt: skip
        assert a["kpis"][k] == b["kpis"][k], k
    assert a["kpis"]["plan_excluded"] == 1 and b["kpis"]["plan_excluded"] == 0


async def test_plan_excluded_counts_only_what_is_taken_out(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        pickable = (await c.post("/whatif/import/simulate", json={"rows": rows})).json()[
            "plan_projects"
        ]
        all_ids = [p["id"] for p in pickable]
        # Alpha and Beta are replaced by file rows: accepted, not counted.
        assert {str(world.alpha.id), str(world.beta.id)} <= set(all_ids)
        resp = await c.post(
            "/whatif/import/simulate",
            json={"rows": rows, "exclude_plan_project_ids": all_ids},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Unticking a file-matched row's project while the row itself is
        # unticked: the plan project is then really taken out.
        rows_off = [
            {**r, "include": False} if r["matched_project_id"] == str(world.alpha.id) else r
            for r in rows
        ]
        resp2 = await c.post(
            "/whatif/import/simulate",
            json={"rows": rows_off, "exclude_plan_project_ids": [str(world.alpha.id)]},
        )
        assert resp2.status_code == 200, resp2.text
    replaced = {str(world.alpha.id), str(world.beta.id)}
    expected = len([i for i in all_ids if i not in replaced])
    assert body["kpis"]["plan_excluded"] == expected
    assert [p["id"] for p in body["plan_projects"]] == all_ids  # before exclusion
    assert not {p["ref"] for p in body["projects"] if p["source"] == "plan"} - replaced
    assert resp2.json()["kpis"]["plan_excluded"] == 1
    assert str(world.alpha.id) not in _by_ref(resp2.json())


# --- C. saved == fresh simulate -------------------------------------------------------------


async def test_saved_equals_fresh_simulate_with_active_run_options_and_edits(db_session):
    world = await make_world(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        first = (await c.post("/whatif/import/simulate", json={"rows": rows})).json()
        fresh_ref = next(p for p in first["projects"] if p["name"] == "Fresh Auto")
        step = next(s for s in fresh_ref["steps"] if s["editable"] != "none")
        requests = [
            {
                "rows": rows,
                "plan_year_end_week": 52,
                "expand_multi": False,
                "exclude_plan_project_ids": [str(world.gamma.id)],
                "edits": [
                    {
                        "project_ref": fresh_ref["ref"],
                        "step_id": step["step_id"],
                        "duration_weeks": 5,
                    }
                ],
            },  # fmt: skip
            {"rows": rows, "mode": "file_only"},
        ]
        for req in requests:
            fresh = await c.post("/whatif/import/simulate", json=req)
            assert fresh.status_code == 200, fresh.text
            saved = await c.post("/whatif/import/scenarios", json=save_body(req))
            assert saved.status_code == 201, saved.text
            s = saved.json()
            assert s["result"] == fresh.json()
            assert s["kpis"] == fresh.json()["kpis"]
            assert s["simulated_week"] == fresh.json()["current_week"]
            assert s["plan_version"] == run.version
            assert s["mode"] == req.get("mode", "merge")
            assert s["plan_year_end_week"] == req.get("plan_year_end_week", 104)
            # Re-run on today's plan: the stored request reproduces the stored result.
            again = await c.post("/whatif/import/simulate", json=s["request"])
            assert again.json() == s["result"]


# --- C/D. compare-id rules ------------------------------------------------------------------


async def test_compare_id_rules(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        ids = []
        for i in range(5):
            r = await c.post(
                "/whatif/import/scenarios",
                json=save_body({"rows": rows}, name=f"S{i}", source_file_sha256=SHA2 if i else SHA),
            )
            assert r.status_code == 201, r.text
            ids.append(r.json()["id"])
        url = "/whatif/import/scenarios/compare.xlsx"
        for bad in (
            "", ids[0], ",".join(ids), f"{ids[0]},{ids[0]}",
            f"{ids[0]},{ids[0].upper()}", f"{ids[0]},not-a-uuid", f",{ids[0]},",
        ):  # fmt: skip
            resp = await c.get(f"{url}?ids={bad}")
            assert resp.status_code == 422, (bad, resp.status_code, resp.text)
        assert (await c.get(url)).status_code == 422  # no ids at all
        # Empty segments are dropped (api/routers/whatif.py `_compare_ids`): lenient by design.
        assert (await c.get(f"{url}?ids={ids[0]},,{ids[1]}")).status_code == 200
        assert (await c.get(f"{url}?ids={ids[0]},{uuid.uuid4()}")).status_code == 404
        two = await c.get(f"{url}?ids={ids[1]},{ids[0]}")
        four = await c.get(f"{url}?ids={','.join(ids[:4])}")
    assert two.status_code == 200 and four.status_code == 200
    k2 = [[c.value for c in r] for r in wb_of(two.content)["KPIs"].iter_rows()]
    assert k2[0][1:3] == ["S1: S1", "S2: S0"]  # the caller's order
    k4 = [[c.value for c in r] for r in wb_of(four.content)["KPIs"].iter_rows()]
    assert k4[0][0] == "KPI" and k4[0][1:5] == ["S1: S0", "S2: S1", "S3: S2", "S4: S3"]
    assert len(k4[0]) == 1 + 4 + 3  # a delta against the first for S2..S4

    # A Greece planner: one visible + one invisible id is a 404, not a partial file.
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        gr_rows = [r for r in await _parsed_rows(c) if r["hub"] == "R&D-Greece"]
        mine = await c.post(
            "/whatif/import/scenarios",
            json=save_body({"rows": gr_rows, "mode": "file_only"}, name="mine"),
        )
        assert mine.status_code == 201, mine.text
        resp = await c.get(f"{url}?ids={mine.json()['id']},{ids[0]}")
    assert resp.status_code == 404


# --- D. workbooks open and carry the stated sheets ------------------------------------------


async def test_every_export_opens_with_the_stated_sheets(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        req = {"rows": rows, "exclude_plan_project_ids": [str(world.gamma.id)]}
        a = (await c.post("/whatif/import/scenarios", json=save_body(req, name="A"))).json()
        b = (
            await c.post("/whatif/import/scenarios", json=save_body({"rows": rows}, name="B"))
        ).json()
        files = {
            "scenario": await c.get(f"/whatif/import/scenarios/{a['id']}/export.xlsx"),
            "current": await c.post(
                "/whatif/import/export.xlsx", json={"name": "cur", "request": req}
            ),
            "compare": await c.get(
                f"/whatif/import/scenarios/compare.xlsx?ids={a['id']},{b['id']}"
            ),
            "template": await c.get("/whatif/import/format/template.xlsx"),
        }
    xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    for kind, resp in files.items():
        assert resp.status_code == 200, (kind, resp.text)
        assert resp.headers["content-type"] == xlsx, kind
        assert resp.headers["content-disposition"].startswith('attachment; filename="'), kind
        assert resp.headers["content-disposition"].endswith('.xlsx"'), kind
        # Both openpyxl modes open it.
        openpyxl.load_workbook(io.BytesIO(resp.content), read_only=True).close()
    scen = ["Summary", "Breakdown", "Projects", "Steps", "Capacity"]
    assert wb_of(files["scenario"].content).sheetnames == scen
    assert wb_of(files["current"].content).sheetnames == scen
    assert wb_of(files["compare"].content).sheetnames == ["KPIs", "Outcome changes"]
    assert wb_of(files["template"].content).sheetnames == ["Projects", "Process steps"]
    # The same request exported saved or unsaved gives the same data sheets.
    ws, wc = wb_of(files["scenario"].content), wb_of(files["current"].content)
    for sheet in ("Breakdown", "Projects", "Steps", "Capacity"):
        cs = [[c.value for c in r] for r in ws[sheet].iter_rows()]
        cc = [[c.value for c in r] for r in wc[sheet].iter_rows()]
        assert cs == cc, sheet
        assert len(cs) > 1, sheet  # a header and at least one data row


# --- scope of a saved snapshot ---------------------------------------------------------------


async def test_admin_snapshot_is_404_to_a_hub_viewer(db_session):
    """P41-R01 (security H-1), qa D1: an Admin's snapshot holds every hub's
    capacity and designers even when its projects are Greece only, so its
    hub_codes cover them and a Greece planner gets 404 on every route (list,
    read, export, compare), never 200 with another hub's engineer-level
    utilisation (GDPR, OQ #8)."""

    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        gr_rows = [r for r in await _parsed_rows(c) if r["hub"] == "R&D-Greece"]
        saved = await c.post(
            "/whatif/import/scenarios",
            json=save_body({"rows": gr_rows, "mode": "file_only"}, name="Greece file only"),
        )
        other = await c.post(
            "/whatif/import/scenarios", json=save_body({"rows": gr_rows}, name="other")
        )
    assert saved.status_code == 201 and other.status_code == 201, saved.text
    s = saved.json()
    assert {"R&D-Greece", "PD-India", "R&D-India"} <= set(s["hub_codes"])

    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        listed = (await c.get("/whatif/import/scenarios")).json()
        assert s["id"] not in {i["id"] for i in listed["items"]}
        assert listed["total"] == 0
        assert (await c.get(f"/whatif/import/scenarios/{s['id']}")).status_code == 404
        assert (await c.get(f"/whatif/import/scenarios/{s['id']}/export.xlsx")).status_code == 404
        cmp = await c.get(
            f"/whatif/import/scenarios/compare.xlsx?ids={s['id']},{other.json()['id']}"
        )
        assert cmp.status_code == 404


async def test_same_scope_snapshot_serves_only_in_scope_capacity(db_session):
    """The positive side: a Greece planner's own snapshot opened by another
    Greece planner is 200, and nothing in it or its export is outside Greece."""

    world = await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        gr_rows = [r for r in await _parsed_rows(c) if r["hub"] == "R&D-Greece"]
        saved = await c.post(
            "/whatif/import/scenarios",
            json=save_body({"rows": gr_rows, "mode": "file_only"}, name="mine"),
        )
    assert saved.status_code == 201, saved.text
    sid = saved.json()["id"]
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        got = await c.get(f"/whatif/import/scenarios/{sid}")
        exported = await c.get(f"/whatif/import/scenarios/{sid}/export.xlsx")
    assert got.status_code == 200 and exported.status_code == 200
    cap = got.json()["result"]["capacity"]
    assert {d["hub"] for d in cap["designers"]} <= {"R&D-Greece"}
    assert {h["hub"] for h in cap["hubs"]} | set(cap["weekly"]["hubs"]) <= {"R&D-Greece"}
    text = " ".join(
        str(cell.value)
        for ws in wb_of(exported.content).worksheets
        for r in ws.iter_rows()
        for cell in r
        if cell.value is not None
    )
    for name in ("Lokesh", "Ashish", "PD-India", "R&D-India"):
        assert name not in text, name
