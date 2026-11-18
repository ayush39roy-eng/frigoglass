"""P41-T02 (ADR 0055, docs/API_CONTRACT_P41.md A–D).

Import format (GET / PUT / reset / template, RBAC, validation codes, version
conflict, the parser using the stored aliases, the template round-trip),
hand-picked scenarios (`exclude_plan_project_ids`, `plan_excluded`,
`plan_projects`), saved scenarios (server recompute, hub-scope visibility as
404, creator/Admin edit rights, limits, no financial keys, audit without
payloads) and the three exports (sheets, formula injection, recompute).
"""

from __future__ import annotations

import io
import json
import uuid
from typing import Any

import openpyxl
import pytest
from sqlalchemy import select

import api.routers.whatif as whatif_router
import services.whatif_import_scenarios as scenario_service
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import RoleName
from models.import_scenario import WhatifImportScenario
from models.types import FINANCIAL_FIELD_NAMES
from services.plan_import_xlsx import (
    FIELD_KEYS,
    ImportFormatError,
    default_field_aliases,
    parse_plan_workbook,
)
from services.xlsx_writer import TABLE_HEADER_ROW
from tests.auth_helpers import clear_current_principal_override
from tests.export_read import keys_of, report
from tests.plan_import_helpers import SECRET_CUSTOMER, SECRET_NOTE, build_workbook, row
from tests.test_p32_plan_import_xlsx import _ctx
from tests.test_p32_whatif_import_api import (
    XLSX,
    _parsed_rows,
    act_as,
    client_for,
    make_world,
    parse,
    standard_file,
)

SHA = "a" * 64
SHA2 = "b" * 64


@pytest.fixture(autouse=True)
def _cleanup():
    whatif_router.WHATIF_RATE_LIMIT.reset()
    yield
    whatif_router.WHATIF_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def audit_rows(db_session, action: str) -> list[AuditLogEntry]:
    stmt = select(AuditLogEntry).where(AuditLogEntry.action == action)
    return list((await db_session.execute(stmt)).scalars().all())


def save_body(request: dict[str, Any], **kw: Any) -> dict[str, Any]:
    return {
        "name": "Scenario one",
        "source_file_name": "plan.xlsx",
        "source_file_sha256": SHA,
        "imported_at": "2026-11-17T10:00:00Z",
        "request": request,
        **kw,
    }


def workbook(data: bytes) -> openpyxl.Workbook:
    return openpyxl.load_workbook(io.BytesIO(data), read_only=False)


def all_keys(value: Any) -> set[str]:
    out: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            out.add(str(k))
            out |= all_keys(v)
    elif isinstance(value, list):
        for v in value:
            out |= all_keys(v)
    return out


# --- A. import format -------------------------------------------------------------------------


async def test_format_default_read_by_every_whatif_role(db_session):
    await make_world(db_session)
    for role, can_edit in (
        (RoleName.PORTFOLIO_MANAGER, False),
        (RoleName.ADMIN, True),
        (RoleName.SUPER_ADMIN, True),
    ):
        await act_as(db_session, role)
        async with client_for(db_session) as c:
            resp = await c.get("/whatif/import/format")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["version"] == 0 and body["is_default"] is True
        assert body["can_edit"] is can_edit
        assert body["updated_at"] is None and body["updated_by_name"] is None
        assert [f["key"] for f in body["fields"]] == list(FIELD_KEYS)
        name = next(f for f in body["fields"] if f["key"] == "name")
        assert name == {
            "key": "name", "label": "Project name", "required": True,
            "aliases": ["project description"], "default_aliases": ["project description"],
        }  # fmt: skip
        assert sum(f["required"] for f in body["fields"]) == 1
    await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with client_for(db_session) as c:
        assert (await c.get("/whatif/import/format")).status_code == 403
        assert (await c.get("/whatif/import/format/template.xlsx")).status_code == 403


@pytest.mark.parametrize(
    "role",
    [RoleName.PORTFOLIO_MANAGER, RoleName.HUB_PLANNER, RoleName.EXECUTIVE_VIEWER,
     RoleName.ENGINEER, RoleName.AUDITOR],
)  # fmt: skip
async def test_format_put_and_reset_forbidden_for_non_admin(db_session, role):
    world = await make_world(db_session)
    hub_ids = [world.gr.id] if role in (RoleName.HUB_PLANNER, RoleName.ENGINEER) else None
    await act_as(db_session, role, hub_ids=hub_ids)
    async with client_for(db_session) as c:
        put = await c.put(
            "/whatif/import/format", json={"version": 0, "fields": {"name": ["title"]}}
        )
        reset = await c.post("/whatif/import/format/reset", json={"version": 0})
    assert put.status_code == 403 and reset.status_code == 403
    assert await audit_rows(db_session, "import_format.updated") == []


@pytest.mark.parametrize("role", [RoleName.ADMIN, RoleName.SUPER_ADMIN])
async def test_format_put_version_conflict_reset_and_audit(db_session, role):
    await make_world(db_session)
    await act_as(db_session, role)
    async with client_for(db_session) as c:
        put = await c.put(
            "/whatif/import/format",
            json={"version": 0, "fields": {"name": ["Project  TITLE", "project title"]}},
        )
        assert put.status_code == 200, put.text
        body = put.json()
        assert body["version"] == 1 and body["is_default"] is False
        assert body["updated_by_name"] == "Test User" and body["updated_at"]
        fields = {f["key"]: f for f in body["fields"]}
        # Normalised like a header cell (casefold, single spaces), folded.
        assert fields["name"]["aliases"] == ["project title"]
        # A key left out keeps its aliases.
        assert fields["status"]["aliases"] == ["status"]

        stale = await c.put(
            "/whatif/import/format", json={"version": 0, "fields": {"name": ["x name"]}}
        )
        assert stale.status_code == 409 and stale.json()["code"] == "FORMAT_VERSION_CONFLICT"

    if role is RoleName.ADMIN:
        # P46 (ADR 0058 D1.4): the reset is Super Admin only. The Admin's
        # edit above stands; a Super Admin resets below.
        async with client_for(db_session) as c:
            refused = await c.post("/whatif/import/format/reset", json={"version": 1})
        assert refused.status_code == 403 and refused.json()["code"] == "SUPER_ADMIN_ONLY"
        await act_as(db_session, RoleName.SUPER_ADMIN)

    async with client_for(db_session) as c:
        stale_reset = await c.post("/whatif/import/format/reset", json={"version": 0})
        assert stale_reset.status_code == 409

        reset = await c.post("/whatif/import/format/reset", json={"version": 1})
        assert reset.status_code == 200, reset.text
        assert reset.json()["version"] == 2 and reset.json()["is_default"] is True
        got = (await c.get("/whatif/import/format")).json()
        assert got["version"] == 2

    (updated,) = await audit_rows(db_session, "import_format.updated")
    assert updated.before_state["version"] == 0 and updated.after_state["version"] == 1
    assert updated.before_state["field_aliases"]["name"] == ["project description"]
    assert updated.after_state["field_aliases"]["name"] == ["project title"]
    (reset_row,) = await audit_rows(db_session, "import_format.reset")
    assert reset_row.after_state["field_aliases"] == {
        k: list(v) for k, v in default_field_aliases().items()
    }


@pytest.mark.parametrize(
    "fields,code",
    [
        ({"customer": ["customer"]}, "FORMAT_UNKNOWN_FIELD"),
        ({"name": ["   "]}, "FORMAT_ALIAS_INVALID"),
        ({"name": ["x" * 61]}, "FORMAT_ALIAS_INVALID"),
        ({"plant": []}, "FORMAT_ALIAS_INVALID"),
        ({"name": ["status"]}, "FORMAT_ALIAS_DUPLICATE"),
        ({"plant": ["Project Code"]}, "FORMAT_ALIAS_DUPLICATE"),
        ({"name": []}, "FORMAT_REQUIRED_MISSING"),
        ({"status": [], "hub": []}, "FORMAT_REQUIRED_MISSING"),
        ({"name": [f"title {i}" for i in range(11)]}, "FORMAT_TOO_MANY_ALIASES"),
    ],
)
async def test_format_put_validation(db_session, fields, code):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        resp = await c.put("/whatif/import/format", json={"version": 0, "fields": fields})
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == code
    assert await audit_rows(db_session, "import_format.updated") == []


async def test_format_status_or_hub_one_may_be_empty(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        resp = await c.put("/whatif/import/format", json={"version": 0, "fields": {"status": []}})
    assert resp.status_code == 200, resp.text
    status = next(f for f in resp.json()["fields"] if f["key"] == "status")
    assert status["aliases"] == []


async def test_parse_uses_the_stored_format(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    renamed = build_workbook(
        [row(name="alpha cooler", hub="Greece", category="C", status="Que")],
        rename={"Project description": "Project Title", "Status": "State"},
    )
    async with client_for(db_session) as c:
        before = await parse(c, renamed)
        # With the default format the renamed status column is not read, but
        # RPD HUB still makes the header row, and the name column is missing.
        assert before.status_code == 422
        put = await c.put(
            "/whatif/import/format",
            json={"version": 0, "fields": {"name": ["project title"], "status": ["state"]}},
        )
        assert put.status_code == 200, put.text
        after = await parse(c, renamed)
        assert after.status_code == 200, after.text
        (r,) = after.json()["rows"]
        assert r["matched_project_id"] == str(world.alpha.id)
        assert r["status"] == "In Queue"
        # The original headers are no longer recognised; the message lists
        # the current aliases.
        old = await parse(c, standard_file())
        assert old.status_code == 422 and old.json()["code"] == "IMPORT_FORMAT"
        assert "project title" in old.json()["detail"]


def test_parser_aliases_argument_defaults_to_builtin():
    data = build_workbook(
        [row(name="x", hub="Greece", category="C", status="Que")],
        rename={"Project description": "Headline"},
    )
    with pytest.raises(ImportFormatError):
        parse_plan_workbook(data, _ctx())
    aliases = {**default_field_aliases(), "name": ("headline",)}
    res = parse_plan_workbook(data, _ctx(), aliases)
    assert [r.name for r in res.rows] == ["x"]


async def test_template_round_trips_through_the_parser(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.get("/whatif/import/format/template.xlsx")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == XLSX
        assert (
            'attachment; filename="plan-import-template.xlsx"'
            == (resp.headers["content-disposition"])
        )
        wb = workbook(resp.content)
        assert wb.sheetnames == ["Projects", "Process steps"]
        header = [c.value for c in next(wb["Projects"].iter_rows(max_row=1))]
        assert header[0] == "S/N" and "Project Description" in header
        assert len(header) == len(FIELD_KEYS)
        steps = [[c.value for c in r] for r in wb["Process steps"].iter_rows()]
        flat = {v for r in steps for v in r if v}
        assert {f"PDD-{x}" for x in "ABCDEFGHIJKLMN"} <= flat
        assert {f"OEM-{x}" for x in "ABCDEFGHIJKLMN"} <= flat
        # Pure parser: accepted (no rows, the empty category rows give the
        # app's lead times).
        res = parse_plan_workbook(resp.content, _ctx())
        assert res.rows == () and res.projects_sheet == "Projects"
        # The API: accepted too.
        parsed = await parse(c, resp.content, name="template.xlsx")
        assert parsed.status_code == 200, parsed.text
        assert parsed.json()["rows"] == []
        # Filled in, it imports.
        wb2 = workbook(resp.content)
        ws = wb2["Projects"]
        by = {h: i for i, h in enumerate(header)}
        line: list[Any] = [None] * len(header)
        line[by["Project Description"]] = "Template Cooler"
        line[by["Rpd Hub"]] = "Greece"
        line[by["Project Category"]] = "C"
        line[by["Status"]] = "Que"
        ws.append(line)
        buf = io.BytesIO()
        wb2.save(buf)
        filled = await parse(c, buf.getvalue(), name="template.xlsx")
        assert filled.status_code == 200, filled.text
        assert [r["name"] for r in filled.json()["rows"]] == ["Template Cooler"]


async def test_template_follows_the_stored_format(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        await c.put(
            "/whatif/import/format", json={"version": 0, "fields": {"name": ["headline", "x"]}}
        )
        resp = await c.get("/whatif/import/format/template.xlsx")
        header = [c.value for c in next(workbook(resp.content)["Projects"].iter_rows(max_row=1))]
        assert "Headline" in header and "Project Description" not in header
        assert (await parse(c, resp.content, name="t.xlsx")).status_code == 200


# --- B. hand-picked scenario ------------------------------------------------------------------


async def test_exclude_plan_projects_both_runs(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        base = (await c.post("/whatif/import/simulate", json={"rows": rows})).json()
        picked = await c.post(
            "/whatif/import/simulate",
            json={"rows": rows, "exclude_plan_project_ids": [str(world.gamma.id)]},
        )
    assert picked.status_code == 200, picked.text
    body = picked.json()
    assert base["kpis"]["plan_excluded"] == 0 and body["kpis"]["plan_excluded"] == 1
    refs = {p["ref"] for p in body["projects"]}
    assert str(world.gamma.id) not in refs
    assert str(world.gamma.id) in {p["ref"] for p in base["projects"]}
    # Taken out of both runs: one plan project fewer, counted nowhere else.
    assert body["kpis"]["plan_projects"] == base["kpis"]["plan_projects"] - 1
    assert body["kpis"]["projects_total"] == base["kpis"]["projects_total"] - 1
    # The tick list is before exclusion, in scope, merge only.
    ids = {p["id"] for p in body["plan_projects"]}
    assert ids == {p["id"] for p in base["plan_projects"]}
    assert str(world.gamma.id) in ids and str(world.delta.id) not in ids  # On Hold
    gamma = next(p for p in body["plan_projects"] if p["id"] == str(world.gamma.id))
    assert gamma == {
        "id": str(world.gamma.id), "name": "Gamma Cooler", "hub": "R&D-Greece",
        "category": "C", "priority": "P3", "status": "In Queue",
    }  # fmt: skip


async def test_exclude_matched_by_a_file_row_is_not_an_error(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        resp = await c.post(
            "/whatif/import/simulate",
            json={"rows": rows, "exclude_plan_project_ids": [str(world.alpha.id)]},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["kpis"]["plan_excluded"] == 0


async def test_exclude_plan_projects_rejections(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        for ids, kw in (
            ([str(world.beta.id)], {}),  # out of scope
            ([str(uuid.uuid4())], {}),  # unknown
            ([str(world.gamma.id), str(world.gamma.id)], {}),  # duplicated
            ([str(world.gamma.id)], {"mode": "file_only"}),
        ):
            resp = await c.post(
                "/whatif/import/simulate",
                json={"rows": rows, "exclude_plan_project_ids": ids, **kw},
            )
            assert resp.status_code == 422, (ids, kw, resp.text)
            assert resp.json()["code"] == "INVALID_IMPORT"
            assert "Beta" not in resp.text
        file_only = await c.post(
            "/whatif/import/simulate", json={"rows": rows, "mode": "file_only"}
        )
    assert file_only.json()["plan_projects"] == []


async def test_plan_projects_scoped(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/import/simulate", json={"rows": []})
    assert {p["id"] for p in resp.json()["plan_projects"]} == {
        str(world.alpha.id), str(world.gamma.id)
    }  # fmt: skip


# --- C. saved scenarios ---------------------------------------------------------------------


def _greece_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [r for r in rows if r["hub"] == "R&D-Greece"]


async def test_save_recomputes_and_stores_a_frozen_record(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        request = {"rows": rows, "exclude_plan_project_ids": [str(world.gamma.id)]}
        fresh = (await c.post("/whatif/import/simulate", json=request)).json()
        # A browser-supplied result is refused outright.
        forged = await c.post(
            "/whatif/import/scenarios", json=save_body(request, result={"kpis": {}})
        )
        assert forged.status_code == 422
        resp = await c.post("/whatif/import/scenarios", json=save_body(request, note="first try"))
        assert resp.status_code == 201, resp.text
        saved = resp.json()
        got = await c.get(f"/whatif/import/scenarios/{saved['id']}")
    assert got.status_code == 200 and got.json() == saved
    assert saved["result"] == fresh
    assert saved["kpis"] == fresh["kpis"] and saved["kpis"]["plan_excluded"] == 1
    assert saved["request"]["exclude_plan_project_ids"] == [str(world.gamma.id)]
    assert saved["simulated_week"] == fresh["current_week"]
    assert saved["plan_version"] is None  # no active run in this world
    assert saved["mode"] == "merge" and saved["plan_year_end_week"] == 104
    # P41-R01 (H-1): every hub of the snapshot plus the saver's scope (all hubs).
    import domain_constants as dc

    assert saved["hub_codes"] == sorted(dc.HUB_LAB_REGION)
    assert saved["can_edit"] is True and saved["created_by_name"] == "Test User"
    assert saved["note"] == "first try" and saved["source_file_sha256"] == SHA

    stored = (await db_session.execute(select(WhatifImportScenario))).scalar_one()
    keys = all_keys(stored.request) | all_keys(stored.result)
    assert not keys & FINANCIAL_FIELD_NAMES
    assert not any(
        k in key.casefold()
        for key in keys
        for k in ("tcogs", "margin", "selling_price", "customer")
    )
    blob = json.dumps(stored.request) + json.dumps(stored.result)
    for secret in (SECRET_CUSTOMER, SECRET_NOTE, "secret business case"):
        assert secret not in blob

    (audit,) = await audit_rows(db_session, "whatif_scenario.saved")
    assert audit.entity_id == saved["id"]
    assert set(audit.after_state) == {"id", "name", "counts"}
    dumped = json.dumps(audit.after_state)
    for leak in ("Fresh", "Kanarios", "rows", "Alpha", "plan.xlsx"):
        assert leak not in dumped


async def test_save_validation_and_limits(db_session, monkeypatch):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        req = {"rows": rows}
        for bad in (
            save_body(req, name=""),
            save_body(req, name="x" * 121),
            save_body(req, note="x" * 1001),
            save_body(req, source_file_sha256="nothex"),
        ):
            assert (await c.post("/whatif/import/scenarios", json=bad)).status_code == 422
        assert (await c.post("/whatif/import/scenarios", json=save_body(req))).status_code == 201

        monkeypatch.setattr(scenario_service, "MAX_SCENARIOS_PER_USER", 1)
        per_user = await c.post("/whatif/import/scenarios", json=save_body(req))
        assert per_user.status_code == 422 and per_user.json()["code"] == "SCENARIO_LIMIT"
        monkeypatch.setattr(scenario_service, "MAX_SCENARIOS_PER_USER", 200)
        monkeypatch.setattr(scenario_service, "MAX_SCENARIOS_TOTAL", 1)
        total = await c.post("/whatif/import/scenarios", json=save_body(req))
        assert total.status_code == 422 and total.json()["code"] == "SCENARIO_LIMIT"
        monkeypatch.setattr(scenario_service, "MAX_SCENARIOS_TOTAL", 2000)
        monkeypatch.setattr(scenario_service, "MAX_SNAPSHOT_BYTES", 1000)
        big = await c.post("/whatif/import/scenarios", json=save_body(req))
        assert big.status_code == 413 and big.json()["code"] == "SCENARIO_TOO_LARGE"
    count = len((await db_session.execute(select(WhatifImportScenario))).scalars().all())
    assert count == 1


async def test_scope_visibility_is_404_and_edit_rights(db_session):
    world = await make_world(db_session)
    # A Greece planner saves a Greece-only scenario.
    creator = await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        rows = _greece_rows(await _parsed_rows(c))
        gr_resp = await c.post(
            "/whatif/import/scenarios", json=save_body({"rows": rows}, name="Greece only")
        )
    assert gr_resp.status_code == 201, gr_resp.text
    gr = gr_resp.json()
    assert gr["hub_codes"] == ["R&D-Greece"]

    # An Admin saves a whole-plan scenario (touches PD-India too).
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        everything = (
            await c.post(
                "/whatif/import/scenarios",
                json=save_body({"rows": rows}, name="All hubs", source_file_sha256=SHA2),
            )
        ).json()
        listed = (await c.get("/whatif/import/scenarios")).json()["items"]
        assert [i["name"] for i in listed] == ["All hubs", "Greece only"]  # newest first
        assert all(i["can_edit"] for i in listed)
        by_sha = (await c.get(f"/whatif/import/scenarios?source_file_sha256={SHA2}")).json()
        assert [i["name"] for i in by_sha["items"]] == ["All hubs"]
        assert "request" not in listed[0] and "result" not in listed[0]
    assert "PD-India" in everything["hub_codes"]

    # An India planner sees neither: 404 everywhere, never 403.
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.ind.id])
    async with client_for(db_session) as c:
        assert (await c.get("/whatif/import/scenarios")).json()["items"] == []
        for sid in (gr["id"], everything["id"]):
            assert (await c.get(f"/whatif/import/scenarios/{sid}")).status_code == 404
            assert (await c.get(f"/whatif/import/scenarios/{sid}/export.xlsx")).status_code == 404
            assert (
                await c.patch(f"/whatif/import/scenarios/{sid}", json={"name": "x"})
            ).status_code == 404
            assert (await c.delete(f"/whatif/import/scenarios/{sid}")).status_code == 404
        cmp = await c.get(
            f"/whatif/import/scenarios/compare.xlsx?ids={gr['id']},{everything['id']}"
        )
        assert cmp.status_code == 404
        assert (await c.get(f"/whatif/import/scenarios/{uuid.uuid4()}")).status_code == 404

    # A second Greece planner sees the Greece one only, and may not edit it.
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        items = (await c.get("/whatif/import/scenarios")).json()["items"]
        assert [i["id"] for i in items] == [gr["id"]] and items[0]["can_edit"] is False
        assert (await c.get(f"/whatif/import/scenarios/{everything['id']}")).status_code == 404
        assert (
            await c.patch(f"/whatif/import/scenarios/{gr['id']}", json={"name": "mine"})
        ).status_code == 403
        assert (await c.delete(f"/whatif/import/scenarios/{gr['id']}")).status_code == 403
        assert (await c.get(f"/whatif/import/scenarios/{gr['id']}/export.xlsx")).status_code == 200

    # The creator renames; an Admin deletes.
    from tests.auth_helpers import make_principal, override_current_principal

    override_current_principal(
        make_principal(RoleName.HUB_PLANNER, user_id=creator.id, email=creator.email,
                       hub_scope_all=False, hub_ids=[world.gr.id])
    )  # fmt: skip
    async with client_for(db_session) as c:
        renamed = await c.patch(
            f"/whatif/import/scenarios/{gr['id']}", json={"name": "Greece v2", "note": None}
        )
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["name"] == "Greece v2" and renamed.json()["can_edit"] is True
        assert renamed.json()["result"] == gr["result"]  # frozen
        assert (
            await c.patch(f"/whatif/import/scenarios/{gr['id']}", json={"name": None})
        ).status_code == 422
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as c:
        assert (await c.delete(f"/whatif/import/scenarios/{gr['id']}")).status_code == 204
        assert (await c.get(f"/whatif/import/scenarios/{gr['id']}")).status_code == 404

    (ren,) = await audit_rows(db_session, "whatif_scenario.renamed")
    assert ren.before_state == {"id": gr["id"], "name": "Greece only"}
    assert ren.after_state == {"id": gr["id"], "name": "Greece v2", "changed": ["name"]}
    (dele,) = await audit_rows(db_session, "whatif_scenario.deleted")
    assert dele.after_state == {"id": gr["id"], "name": "Greece v2"}


# --- D. exports ---------------------------------------------------------------------------


def _cells(ws: Any) -> list[list[Any]]:
    """P43: a table from its header row down (the title block is above)."""

    return [[c.value for c in r] for r in ws.iter_rows(min_row=TABLE_HEADER_ROW)]


def _summary(ws: Any) -> dict[str, Any]:
    """P43: the Summary report, keyed by label and by machine key."""

    return {k: v for label, v in report(ws).items() for k in keys_of(label)}


async def test_scenario_export_sheets_and_formula_injection(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        evil = next(r for r in rows if r["name"] == "Fresh Auto")
        evil["name"] = '=HYPERLINK("http://x")'
        saved = (
            await c.post(
                "/whatif/import/scenarios",
                json=save_body({"rows": rows}, name="@evil", note="+cmd|' /C calc'!A0"),
            )
        ).json()
        resp = await c.get(f"/whatif/import/scenarios/{saved['id']}/export.xlsx")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == XLSX
    assert resp.headers["content-disposition"] == 'attachment; filename="evil.xlsx"'
    wb = workbook(resp.content)
    assert wb.sheetnames == ["Summary", "Gantt", "Breakdown", "Projects", "Steps", "Capacity"]
    summary = _summary(wb["Summary"])
    assert summary["name"] == "'@evil"
    assert summary["note"] == "'+cmd|' /C calc'!A0"
    assert summary["within_plan_year"] == saved["kpis"]["within_plan_year"]
    assert summary["plan_excluded"] == 0
    projects = _cells(wb["Projects"])
    names = [r[projects[0].index("Name")] for r in projects[1:]]
    assert '\'=HYPERLINK("http://x")' in names
    for ws in wb.worksheets:
        for r in ws.iter_rows():
            for cell in r:
                assert cell.data_type != "f"
                if isinstance(cell.value, str):
                    assert not cell.value.startswith(("=", "+", "-", "@", "\t", "\r"))
    assert len(projects) - 1 == len(saved["result"]["projects"])
    steps = _cells(wb["Steps"])
    assert len(steps) - 1 == sum(len(p["steps"]) for p in saved["result"]["projects"])
    (audit,) = await audit_rows(db_session, "whatif_scenario.exported")
    assert audit.after_state["ids"] == [saved["id"]] and "rows" not in json.dumps(audit.after_state)


async def test_current_result_export_recomputes(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        req = {"rows": rows, "exclude_plan_project_ids": [str(world.gamma.id)]}
        fresh = (await c.post("/whatif/import/simulate", json=req)).json()
        forged = await c.post(
            "/whatif/import/export.xlsx", json={"request": req, "result": {"kpis": {}}}
        )
        assert forged.status_code == 422
        resp = await c.post("/whatif/import/export.xlsx", json={"name": "My pick", "request": req})
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-disposition"] == 'attachment; filename="My pick.xlsx"'
    summary = _summary(workbook(resp.content)["Summary"])
    assert summary["name"] == "My pick"
    for k, v in fresh["kpis"].items():
        assert summary[k] == v, k
    (audit,) = await audit_rows(db_session, "whatif_scenario.exported")
    assert audit.entity_id == "current" and audit.after_state["kind"] == "current"


async def test_compare_export(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        a = await c.post("/whatif/import/scenarios", json=save_body({"rows": rows}, name="A"))
        b = await c.post(
            "/whatif/import/scenarios",
            json=save_body(
                {"rows": rows, "exclude_plan_project_ids": [str(world.gamma.id)]},
                name="=B", source_file_sha256=SHA2,
            ),
        )  # fmt: skip
        ida, idb = a.json()["id"], b.json()["id"]
        for bad in (ida, f"{ida},{ida}", ",".join([ida, idb] * 3), "nope,also-nope"):
            resp = await c.get(f"/whatif/import/scenarios/compare.xlsx?ids={bad}")
            assert resp.status_code == 422, bad
        missing = await c.get(f"/whatif/import/scenarios/compare.xlsx?ids={ida},{uuid.uuid4()}")
        assert missing.status_code == 404
        resp = await c.get(f"/whatif/import/scenarios/compare.xlsx?ids={ida},{idb}")
    assert resp.status_code == 200, resp.text
    wb = workbook(resp.content)
    assert wb.sheetnames == ["KPIs", "Outcome changes", "Gantt S1", "Gantt S2"]
    kpis = _cells(wb["KPIs"])
    assert kpis[0] == ["KPI", "S1: A", "S2: =B", "S2 - S1"]
    # Workflow A4: the Compare tab's two derived rows, row for row.
    a_res, b_res = a.json()["result"], b.json()["result"]
    sched = next(r for r in kpis if r[0] == "Projects scheduled")
    a_all = a_res["breakdowns"]["by_year"]["all"]["total"]
    b_all = b_res["breakdowns"]["by_year"]["all"]["total"]
    assert sched[1:] == [a_all, b_all, b_all - a_all]
    not_placed = next(r for r in kpis if r[0] == "Not placed")
    a_np = a_res["breakdowns"]["by_year"]["not_placed"]["total"]
    b_np = b_res["breakdowns"]["by_year"]["not_placed"]["total"]
    assert not_placed[1:] == [a_np, b_np, b_np - a_np]
    line = next(r for r in kpis if r[0] == "Plan excluded")
    assert line[1:] == [0, 1, 1]
    src = next(r for r in kpis if r[0] == "Source file")
    assert src[1:3] == ["plan.xlsx", "plan.xlsx"]
    changes = _cells(wb["Outcome changes"])
    ref_col = changes[0].index("Ref")  # P43 rework: id columns sit at the far right
    gamma = [r for r in changes[1:] if r[ref_col] == str(world.gamma.id)]
    assert gamma and gamma[0][changes[0].index("S2: =B outcome")] == "not in scenario"
    (audit,) = await audit_rows(db_session, "whatif_scenario.exported")
    assert audit.after_state["kind"] == "compare" and audit.after_state["ids"] == [ida, idb]


async def test_rate_limit_applies_to_mutations_and_exports(db_session, monkeypatch):
    from services.rate_limit import TokenBucketLimiter

    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    monkeypatch.setattr(whatif_router, "WHATIF_RATE_LIMIT", TokenBucketLimiter(1, 0.001))
    async with client_for(db_session) as c:
        assert (await c.get("/whatif/import/format/template.xlsx")).status_code == 200
        assert (await c.get("/whatif/import/format/template.xlsx")).status_code == 429
        put = await c.put("/whatif/import/format", json={"version": 0, "fields": {}})
        assert put.status_code == 429
        save = await c.post("/whatif/import/scenarios", json=save_body({"rows": []}))
        assert save.status_code == 429
        # P41-R01 (M-1): the list and the read are limited too.
        assert (await c.get("/whatif/import/scenarios")).status_code == 429
        assert (await c.get(f"/whatif/import/scenarios/{uuid.uuid4()}")).status_code == 429


# --- P41-R01: security H-1 probes (hub_codes covers the whole snapshot) and M-1 paging ------


async def _invisible_to(db_session, sid: str, hub_ids) -> None:
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=hub_ids)
    async with client_for(db_session) as c:
        items = (await c.get("/whatif/import/scenarios")).json()["items"]
        assert sid not in {i["id"] for i in items}
        assert (await c.get(f"/whatif/import/scenarios/{sid}")).status_code == 404
        assert (await c.get(f"/whatif/import/scenarios/{sid}/export.xlsx")).status_code == 404


async def _save_as_india_planner(db_session, world, request_of) -> dict[str, Any]:
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.ind.id])
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        resp = await c.post("/whatif/import/scenarios", json=save_body(request_of(rows)))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_probe_unticked_india_rows_file_only(db_session):
    world = await make_world(db_session)

    def req(rows):
        for r in rows:
            r["include"] = r["hub"] == "R&D-Greece" and r["name"] == "Fresh Auto"
        return {"rows": rows, "mode": "file_only"}

    saved = await _save_as_india_planner(db_session, world, req)
    assert {p["hub"] for p in saved["result"]["projects"]} == {"R&D-Greece"}
    assert {"PD-India", "R&D-Greece", "R&D-India"} <= set(saved["hub_codes"])
    await _invisible_to(db_session, saved["id"], [world.gr.id])


async def test_probe_everything_unticked(db_session):
    world = await make_world(db_session)

    def req(rows):
        for r in rows:
            r["include"] = False
        return {"rows": rows, "mode": "file_only"}

    saved = await _save_as_india_planner(db_session, world, req)
    assert saved["result"]["projects"] == [] and saved["hub_codes"]
    await _invisible_to(db_session, saved["id"], [world.ri.id])
    await _invisible_to(db_session, saved["id"], [world.gr.id])


async def test_probe_merge_with_india_plan_project_excluded(db_session):
    world = await make_world(db_session)

    def req(rows):
        gr = [r for r in rows if r["hub"] == "R&D-Greece"]
        return {"rows": gr, "exclude_plan_project_ids": [str(world.beta.id)]}

    saved = await _save_as_india_planner(db_session, world, req)
    assert str(world.beta.id) not in {p["ref"] for p in saved["result"]["projects"]}
    assert "PD-India" in saved["hub_codes"]
    await _invisible_to(db_session, saved["id"], [world.gr.id])


async def test_probe_admin_saves_one_greece_row(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = [r for r in await _parsed_rows(c) if r["name"] == "Fresh Auto"]
        resp = await c.post(
            "/whatif/import/scenarios", json=save_body({"rows": rows, "mode": "file_only"})
        )
    assert resp.status_code == 201, resp.text
    saved = resp.json()
    # An all-hubs saver: every hub (its result holds every hub's capacity).
    assert set(saved["hub_codes"]) >= {"PD-India", "R&D-Greece", "R&D-India"}
    await _invisible_to(db_session, saved["id"], [world.gr.id])


async def test_probe_greece_peer_still_sees_a_greece_scenario(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        rows = [r for r in await _parsed_rows(c) if r["hub"] == "R&D-Greece"]
        saved = (await c.post("/whatif/import/scenarios", json=save_body({"rows": rows}))).json()
    assert saved["hub_codes"] == ["R&D-Greece"]
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        got = await c.get(f"/whatif/import/scenarios/{saved['id']}")
    assert got.status_code == 200
    cap = got.json()["result"]["capacity"]
    assert {d["hub"] for d in cap["designers"]} <= {"R&D-Greece"}
    assert {h["hub"] for h in cap["hubs"]} <= {"R&D-Greece"}


async def test_empty_hub_codes_never_grants_visibility(db_session):
    world = await make_world(db_session)
    owner = await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/import/scenarios", json=save_body({"rows": []}))
    sid = resp.json()["id"]
    row = await db_session.get(WhatifImportScenario, uuid.UUID(sid))
    row.hub_codes = []
    await db_session.flush()
    await _invisible_to(db_session, sid, [world.gr.id])
    # The creator still sees it (and Admin always).
    from tests.auth_helpers import make_principal, override_current_principal

    override_current_principal(
        make_principal(RoleName.ADMIN, user_id=owner.id, email=owner.email, hub_scope_all=True)
    )
    async with client_for(db_session) as c:
        assert (await c.get(f"/whatif/import/scenarios/{sid}")).status_code == 200


async def test_list_is_paged_and_reads_the_kpis_column(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        for i in range(3):
            r = await c.post("/whatif/import/scenarios", json=save_body({"rows": []}, name=f"S{i}"))
            assert r.status_code == 201
        page = (await c.get("/whatif/import/scenarios?limit=2")).json()
        assert page["total"] == 3 and page["limit"] == 2 and page["offset"] == 0
        assert [i["name"] for i in page["items"]] == ["S2", "S1"]
        nxt = (await c.get("/whatif/import/scenarios?limit=2&offset=2")).json()
        assert [i["name"] for i in nxt["items"]] == ["S0"] and nxt["total"] == 3
        default = (await c.get("/whatif/import/scenarios")).json()
        assert default["limit"] == 50
        for bad in ("limit=0", "limit=201", "offset=-1"):
            assert (await c.get(f"/whatif/import/scenarios?{bad}")).status_code == 422
    rows = (await db_session.execute(select(WhatifImportScenario))).scalars().all()
    assert all(r.kpis == r.result["kpis"] for r in rows)


# --- P41-R01 addendum (workflow A1, A3) --------------------------------------------------


async def test_exclude_accepts_ids_the_plan_or_file_already_drop(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        # Delta is On Hold in the live plan (in scope, not schedulable): counted 0.
        held = await c.post(
            "/whatif/import/simulate",
            json={"rows": rows, "exclude_plan_project_ids": [str(world.delta.id)]},
        )
        assert held.status_code == 200, held.text
        assert held.json()["kpis"]["plan_excluded"] == 0
        # The file removes Alpha (an On Hold row matching it): counted 0, no 422.
        alpha_row = next(r for r in rows if r["matched_project_id"] == str(world.alpha.id))
        alpha_row["status"] = "On Hold"
        removed = await c.post(
            "/whatif/import/simulate",
            json={
                "rows": rows,
                "exclude_plan_project_ids": [str(world.alpha.id), str(world.gamma.id)],
            },
        )
        assert removed.status_code == 200, removed.text
        body = removed.json()
        assert body["kpis"]["plan_excluded"] == 1  # gamma only
        refs = {p["ref"] for p in body["projects"]}
        assert str(world.alpha.id) not in refs and str(world.gamma.id) not in refs
    audits = await audit_rows(db_session, "whatif.import_simulate")
    shapes = sorted(a.after_state["scenario"]["plan_excluded"] for a in audits)
    # Workflow A3: the audit carries the served count, not the ids sent (2).
    assert shapes == [0, 1]
