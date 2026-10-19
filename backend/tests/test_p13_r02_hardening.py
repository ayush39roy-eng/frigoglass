"""P13-R02 — security hardening (P13-F10, P13-F12).

- F10: CSV/XLSX formula injection (CWE-1236). A string cell starting with
  `= + - @ \\t \\r` gets a leading `'`; XLSX string cells are text, never
  formulas; numbers (negative ones too) stay numeric and unprefixed.
- F12: `leader_name` is withheld in every export, even for the leader;
  `/gantt` rejects a negative `offset`; an Engineer's Gantt names only the
  caller, never a colleague on a shared project.
"""

from __future__ import annotations

import csv
import io

import openpyxl
import pytest
from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, RoleName
from models.schedule import ScheduleRunProjectStep
from services.export_builder import csv_bytes, xlsx_bytes
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
    make_workflow_step_template,
)

DANGEROUS = ["=1+2", "+SUM(A1)", "-2+3", "@cmd", "\tTAB", "\rCR", '=HYPERLINK("http://x")']
HEADERS = ["text", "number", "negative", "float", "flag", "items"]


def _row(text: str) -> dict:
    return {
        "text": text,
        "number": 7,
        "negative": -5,
        "float": -1.25,
        "flag": True,
        "items": ["=evil", "ok"],
    }


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# --- F10: formula injection ------------------------------------------------------------------


def test_csv_prefixes_formula_strings_and_leaves_numbers_alone():
    content = csv_bytes(HEADERS, [_row(t) for t in DANGEROUS] + [_row("Plain name")])
    rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"), newline="")))
    for raw, row in zip(DANGEROUS, rows, strict=False):
        assert row["text"] == "'" + raw
        assert row["negative"] == "-5" and row["float"] == "-1.25" and row["number"] == "7"
        assert row["items"] == "'=evil, ok"
    assert rows[-1]["text"] == "Plain name"


def test_xlsx_writes_strings_as_text_never_formulas():
    content = xlsx_bytes({"S": (HEADERS, [_row(t) for t in DANGEROUS] + [_row("Plain")])})
    ws = openpyxl.load_workbook(io.BytesIO(content))["S"]
    data = list(ws.iter_rows(min_row=2))
    for raw, cells in zip(DANGEROUS, data, strict=False):
        text, number, negative, flt, _flag, items = cells
        # XML normalises a bare CR to LF on load; the leading `'` is what matters.
        assert text.data_type == "s" and text.value == "'" + raw.replace("\r", "\n")
        assert items.data_type == "s" and items.value == "'=evil, ok"
        assert number.data_type == "n" and number.value == 7
        assert negative.data_type == "n" and negative.value == -5
        assert flt.data_type == "n" and flt.value == -1.25
    assert data[-1][0].value == "Plain"
    assert all(c.data_type != "f" for row in ws.iter_rows() for c in row)


async def test_dashboard_export_neutralises_a_formula_project_name(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_project(db_session, hub, name='=HYPERLINK("http://evil","x")')
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    async with _client(db_session) as client:
        csv_resp = await client.get("/exports/dashboard", params={"format": "csv"})
        xlsx_resp = await client.get("/exports/dashboard", params={"format": "xlsx"})
    assert csv_resp.status_code == xlsx_resp.status_code == 200
    rows = list(csv.DictReader(io.StringIO(csv_resp.content.decode("utf-8-sig"))))
    assert rows[0]["project_name"].startswith("'=HYPERLINK")
    ws = openpyxl.load_workbook(io.BytesIO(xlsx_resp.content))["Dashboard"]
    headers = [c.value for c in next(ws.iter_rows(max_row=1))]
    cell = list(ws.iter_rows(min_row=2))[0][headers.index("project_name")]
    assert cell.data_type == "s" and cell.value.startswith("'=HYPERLINK")


# --- F12: leader_name withheld in every export ----------------------------------------------


async def test_exports_include_leader_name_and_neutralise_formulas(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    user = await make_user(db_session, RoleName.PORTFOLIO_MANAGER)
    leader = await make_engineer(db_session, hub, name="Leader Self Name")
    leader.user_id = user.id
    await make_project(db_session, hub, name="Led Project", leader=leader)
    await db_session.flush()
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user.id))
    async with _client(db_session) as client:
        live = await client.get("/dashboard/projects")
        csv_resp = await client.get("/exports/dashboard", params={"format": "csv"})
        xlsx_resp = await client.get("/exports/dashboard", params={"format": "xlsx"})
        matrix = await client.get("/exports/matrix", params={"format": "csv"})
    # The live read still names the caller's own leadership (OQ #8 self rule).
    assert live.status_code == 200
    assert live.json()["rows"][0]["leader_name"] == "Leader Self Name"
    # ADR 0028: exports carry the leader name again.
    rows = list(csv.DictReader(io.StringIO(csv_resp.content.decode("utf-8-sig"))))
    assert rows and all(r["leader_name"] == "Leader Self Name" for r in rows)
    assert rows[0]["leader_engineer_id"] == str(leader.id)
    ws = openpyxl.load_workbook(io.BytesIO(xlsx_resp.content))["Dashboard"]
    assert "Leader Self Name" in [c.value for row in ws.iter_rows() for c in row]
    assert matrix.status_code == 200
    assert b"Leader Self Name" in matrix.content
    # Formula-injection protection still applies to the leader name.
    leader.name = "=SUM(1+1)"
    await db_session.flush()
    async with _client(db_session) as client:
        again = await client.get("/exports/dashboard", params={"format": "csv"})
    rows = list(csv.DictReader(io.StringIO(again.content.decode("utf-8-sig"))))
    assert rows[0]["leader_name"].startswith("'=SUM")


# --- F12: Gantt offset and Engineer engineer_names ------------------------------------------


async def test_gantt_rejects_negative_offset(db_session):
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    async with _client(db_session) as client:
        bad = await client.get("/gantt", params={"offset": "-50"})
        ok = await client.get("/gantt", params={"offset": "0"})
    assert bad.status_code == 422
    assert ok.status_code == 200


async def test_gantt_engineer_never_sees_a_colleagues_name(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    me = await make_engineer(db_session, hub, name="Me Myself")
    colleague = await make_engineer(db_session, hub, name="Colleague Secret")
    user = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=False, hub_ids=[])
    me.user_id = user.id
    t_a = await make_workflow_step_template(db_session, step_id="PDD-A", sequence_order=1)
    t_b = await make_workflow_step_template(
        db_session, step_id="PDD-B", name="Concept Study", sequence_order=2
    )
    project = await make_project(db_session, hub, name="Shared Project")
    run = await make_schedule_run(db_session, is_active=True)
    for template, order, start, eng in ((t_a, 1, 31, me), (t_b, 2, 33, colleague)):
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id,
                project_id=project.id,
                step_template_id=template.id,
                sequence_order=order,
                duration_weeks=2,
                start_week=start,
                end_week=start + 1,
                assigned_engineer_id=eng.id,
            )
        )
    await db_session.flush()
    override_current_principal(
        make_principal(RoleName.ENGINEER, user_id=user.id, hub_scope_all=False, hub_ids=())
    )
    async with _client(db_session) as client:
        resp = await client.get("/gantt")
    assert resp.status_code == 200, resp.text
    steps = {s["step_id"]: s for s in resp.json()["rows"][0]["steps"]}
    assert steps["PDD-A"]["assigned_engineer_name"] == "Me Myself"
    assert steps["PDD-B"]["assigned_engineer_name"] is None
    assert "Colleague Secret" not in resp.text
