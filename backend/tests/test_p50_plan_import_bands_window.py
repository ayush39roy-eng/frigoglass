"""P50-T01 (ADR 0061, ruling R49-1..R49-21, invariants I54..I56): plan import
band columns and the "Plan from" / "Plan until" window, backend side.

Synthetic workbooks only (`tests.plan_import_helpers`); the client's file is
never read here.
"""

from __future__ import annotations

import dataclasses
import io
from types import SimpleNamespace
from typing import Any

import openpyxl
import pytest
from sqlalchemy import select, update

import api.routers.whatif as whatif_router
from api.db import get_db
from api.errors import CodedHTTPException
from api.main import app
from models.enums import RoleName
from models.import_scenario import WhatifImportScenario
from schemas.whatif_import import ImportSimulateRequest
from services.plan_import_xlsx import (
    MatchableProject,
    ParseResult,
    parse_plan_workbook,
)
from services.whatif_import import (
    PLAN_FROM_LATER,
    PLAN_FROM_RAISED,
    PLAN_UNTIL_RAISED,
    plan_week_choices,
    plan_week_label,
    plan_window_issues,
    plan_window_label,
    resolve_plan_window,
)
from tests.auth_helpers import clear_current_principal_override
from tests.export_read import keys_of, report
from tests.plan_import_helpers import HEADERS, build_workbook, row
from tests.test_p32_plan_import_xlsx import _ctx
from tests.test_p32_whatif_import_api import (
    _parsed_rows,
    act_as,
    client_for,
    make_world,
)

BAND_HEADERS = (
    "Must Do (P1)",
    "Good to Have (P2)",
    "In Queue (P3)",
    "Not Approved, on HOLD, NO Priority (P4)",
)
#: The client's 2027 layout: the four band columns after "Comments".
HEADERS_WITH_BANDS = (*HEADERS, *BAND_HEADERS)


def _band_row(bands: dict[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
    out = row(**kw)
    out.update(bands or {})
    return out


def _parse(rows: list[dict[str, Any]], ctx=None, *, bands: bool = True) -> ParseResult:
    headers = HEADERS_WITH_BANDS if bands else HEADERS
    return parse_plan_workbook(build_workbook(rows, headers=headers), ctx or _ctx())


def _by_name(res: ParseResult) -> dict[str, Any]:
    return {r.name: r for r in res.rows}


def _codes(res: ParseResult, key: str | None = None) -> list[str]:
    return [i.code for i in res.issues if key is None or i.row_key == key]


_BASE = dict(hub="Greece", category="C", status="Que", engineer="Kanarios")


# --- I55: no band Yes parses exactly as before -----------------------------------------------


def _strip(res: ParseResult) -> tuple[Any, ...]:
    return (
        tuple(dataclasses.replace(r, file_band=None) for r in res.rows),
        res.issues,
        res.counts,
        res.lead_times,
    )


def test_i55_no_band_yes_parses_as_before():
    rows = [
        _band_row(sn=1, name="Ranked", priority=3, **_BASE),
        _band_row(sn=2, name="Running", priority="Running", **_BASE),
        _band_row(sn=3, name="Plain", must_do="No", **_BASE),
        _band_row(sn=4, name="Blank bands", **_BASE),
        _band_row(
            {"Good to Have (P2)": "No", "In Queue (P3)": " ", "Must Do (P1)": "n"},
            sn=5,
            name="No bands",
            **_BASE,
        ),  # fmt: skip
    ]
    with_cols = _parse(rows, bands=True)
    without_cols = _parse(rows, bands=False)
    assert _strip(with_cols) == _strip(without_cols)
    for r in with_cols.rows:
        assert r.file_band is None and r.priority_source != "band"
    by = _by_name(with_cols)
    assert (by["Ranked"].priority, by["Ranked"].priority_source) == ("P1", "rank")
    assert (by["Running"].rank, by["Running"].priority_source) == (0, "running")
    assert (by["Plain"].priority, by["Plain"].priority_source) == ("P3", "default")


def test_i55_must_do_odd_text_keeps_its_pre_r49_reading():
    res = _parse([_band_row(sn=1, name="Odd", must_do="maybe", **_BASE)])
    (r,) = res.rows
    assert r.must_do is None and r.file_band is None and r.priority == "P3"
    assert "BAND_VALUE_INVALID" not in _codes(res)


# --- R49-1 / R49-2: columns and the file band -----------------------------------------------


def test_must_do_and_must_do_p1_are_two_columns():
    res = _parse(
        [
            _band_row(sn=1, name="Only N", must_do="Yes", **_BASE),
            _band_row({"Must Do (P1)": "Yes"}, sn=2, name="Only Z", **_BASE),
            _band_row({"Must Do (P1)": "Yes"}, sn=3, name="Both", must_do="Yes", **_BASE),
        ]
    )
    by = _by_name(res)
    assert by["Only N"].must_do is True and by["Only N"].file_band == "P1"
    assert by["Only Z"].must_do is None and by["Only Z"].file_band == "P1"
    for r in res.rows:
        assert (r.priority, r.priority_source) == ("P1", "band")
    # Must Do + Must Do (P1) both Yes is not a conflict.
    assert "PRIORITY_BAND_CONFLICT" not in _codes(res)


def test_must_do_p1_alone_is_read_as_band_p1():
    headers = tuple(h if h != "Must Do" else "Must Do (P1)" for h in HEADERS)
    # No "Must Do" column: "Must Do (P1)" is band_p1, never must_do.
    data = build_workbook(
        [{**row(sn=1, name="Z only", **_BASE), "Must Do (P1)": "Yes"}], headers=headers
    )
    (r,) = parse_plan_workbook(data, _ctx()).rows
    assert r.must_do is None and r.file_band == "P1" and r.priority_source == "band"


@pytest.mark.parametrize(
    ("bands", "band"),
    [
        ({"Good to Have (P2)": "Yes"}, "P2"),
        ({"In Queue (P3)": "y"}, "P3"),
        ({"Not Approved, on HOLD, NO Priority (P4)": "X"}, "P4"),
    ],
)
def test_each_band_column_sets_the_priority(bands, band):
    res = _parse([_band_row(bands, sn=1, name="Banded", **_BASE)])
    (r,) = res.rows
    assert (r.priority, r.priority_source, r.file_band, r.rank) == (band, "band", band, None)
    assert r.include is True


def test_most_urgent_band_wins_with_a_conflict_warning():
    res = _parse(
        [
            _band_row(
                {"Good to Have (P2)": "Yes", "Not Approved, on HOLD, NO Priority (P4)": "Yes"},
                sn=1, name="Two", **_BASE,
            )
        ]
    )  # fmt: skip
    (r,) = res.rows
    assert r.priority == "P2" and r.file_band == "P2"
    assert _codes(res, r.key).count("PRIORITY_BAND_CONFLICT") == 1


def test_band_value_invalid_is_ignored_with_a_warning():
    res = _parse(
        [_band_row({"Good to Have (P2)": "later", "In Queue (P3)": "Yes"}, sn=1, name="X", **_BASE)]
    )
    (r,) = res.rows
    assert r.priority == "P3" and r.file_band == "P3"
    issue = next(i for i in res.issues if i.code == "BAND_VALUE_INVALID")
    assert issue.severity == "warning" and issue.field == "band_p2"


# --- R49-3: precedence ------------------------------------------------------------------------


def test_band_beats_rank_and_keeps_it_as_the_in_band_order():
    res = _parse(
        [
            _band_row({"Good to Have (P2)": "Yes"}, sn=1, name="R3", priority=3, **_BASE),
            _band_row({"In Queue (P3)": "Yes"}, sn=2, name="Run", priority="Running", **_BASE),
            _band_row(sn=3, name="R5 must", priority=5, must_do="Yes", **_BASE),
        ]
    )
    by = _by_name(res)
    assert (by["R3"].priority, by["R3"].rank, by["R3"].priority_source) == ("P2", 3, "band")
    assert (by["Run"].priority, by["Run"].rank) == ("P3", 0)
    # The Running row's status is still derived and applied (status first).
    assert by["Run"].status == "In Queue"  # the Status cell says Que
    assert (by["R5 must"].priority, by["R5 must"].rank) == ("P1", 5)
    assert "PRIORITY_BAND_OVER_RANK" in _codes(res, by["R3"].key)
    assert "PRIORITY_BAND_OVER_RANK" in _codes(res, by["Run"].key)
    # A P1 band over a rank agrees with the rank: no warning.
    assert "PRIORITY_BAND_OVER_RANK" not in _codes(res, by["R5 must"].key)


def test_band_beats_the_matched_plan_band_with_info():
    plan = (
        MatchableProject("p-1", "Matched One", None, "R&D-Greece", "P2"),
        MatchableProject("p-2", "Matched Two", None, "R&D-Greece", "P2"),
        MatchableProject("p-3", "Matched Three", None, "R&D-Greece", "P1"),
    )
    res = _parse(
        [
            _band_row(sn=1, name="Matched One", must_do="Yes", **_BASE),
            _band_row(sn=2, name="Matched Two", **_BASE),
            _band_row(sn=3, name="Matched Three", must_do="Yes", **_BASE),
        ],
        _ctx(projects=plan),
    )
    by = _by_name(res)
    assert (by["Matched One"].priority, by["Matched One"].priority_source) == ("P1", "band")
    over = [i for i in res.issues if i.code == "PRIORITY_BAND_OVER_PLAN"]
    assert [i.row_key for i in over] == [by["Matched One"].key] and over[0].severity == "info"
    # No band Yes: the matched fallback still applies.
    assert (by["Matched Two"].priority, by["Matched Two"].priority_source) == ("P2", "matched")
    assert by["Matched Three"].priority_source == "band"


@pytest.mark.parametrize("status", ["On Hold", "Cancelled", "Commercialized"])
def test_status_first_not_mapped_whatever_the_band(status):
    res = _parse([_band_row(sn=1, name="Held", must_do="Yes", **{**_BASE, "status": status})])
    (r,) = res.rows
    assert r.include is False and r.priority == "P1" and r.file_band == "P1"


def test_p4_band_row_in_a_schedulable_status_is_included():
    res = _parse(
        [_band_row({"Not Approved, on HOLD, NO Priority (P4)": "Yes"}, sn=1, name="P4", **_BASE)]
    )
    (r,) = res.rows
    assert r.include is True and r.priority == "P4"


# --- R49-7 / R49-15: labels and window resolution ---------------------------------------------


def test_week_labels_are_server_made():
    assert plan_week_label(53) == "W1 2027 (4 Jan 2027)"
    assert plan_week_label(47) == "W47 2026 (16 Nov 2026)"
    assert plan_week_label(52) == "W52 2026 (21 Dec 2026)"
    assert plan_week_label(104) == "W52 2027 (27 Dec 2027)"
    choices = plan_week_choices(47)
    assert [c.week for c in choices] == list(range(47, 105))


def _wctx(cw: int) -> Any:
    return SimpleNamespace(baseline=SimpleNamespace(schedule=SimpleNamespace(current_week=cw)))


def _req(**kw: Any) -> ImportSimulateRequest:
    return ImportSimulateRequest.model_validate({"rows": [], **kw})


def test_resolve_defaults_to_cw_and_the_preset():
    w = resolve_plan_window(_wctx(47), _req())
    assert (w.from_week, w.until_week, w.until_given) == (47, 104, False)
    assert plan_window_issues(w) == [] and plan_window_label(w) is None
    w = resolve_plan_window(_wctx(47), _req(plan_year_end_week=52, plan_until_week=52))
    assert (w.until_week, w.until_given) == (52, False)  # the preset: plan-year wording


@pytest.mark.parametrize(
    "kw",
    [
        {"plan_from_week": 46},
        {"plan_from_week": 60, "plan_year_end_week": 52},
        {"plan_from_week": 60, "plan_until_week": 59},
        {"plan_until_week": 46},
    ],
)
def test_resolve_rejects_out_of_window(kw):
    with pytest.raises(CodedHTTPException) as exc:
        resolve_plan_window(_wctx(47), _req(**kw))
    assert exc.value.status_code == 422 and exc.value.code == "INVALID_IMPORT"


def test_schema_bounds_the_weeks():
    for bad in ({"plan_from_week": 105}, {"plan_until_week": 0}, {"plan_from_week": "53"}):
        with pytest.raises(ValueError):
            _req(**bad)


def test_resolve_later_start_and_window_label():
    w = resolve_plan_window(_wctx(47), _req(plan_from_week=48, plan_until_week=72))
    assert (w.from_week, w.until_week) == (48, 72)
    assert plan_window_label(w) == "W48 2026 – W20 2027"
    (issue,) = plan_window_issues(w)
    assert issue.code == PLAN_FROM_LATER and issue.severity == "info" and issue.ref is None
    assert "W48 2026 (23 Nov 2026)" in issue.message


def test_rerun_raises_f_then_u():
    w = resolve_plan_window(
        _wctx(50), _req(plan_from_week=40, plan_until_week=45, plan_window_rerun=True)
    )
    assert (w.from_week, w.until_week) == (50, 50)
    assert [i.code for i in plan_window_issues(w)] == [PLAN_FROM_RAISED, PLAN_UNTIL_RAISED]
    # Nothing to raise: no issue.
    w = resolve_plan_window(_wctx(50), _req(plan_from_week=55, plan_window_rerun=True))
    assert (w.from_week, w.until_week) == (55, 104) and plan_window_issues(w) == [
        i for i in plan_window_issues(w) if i.code == PLAN_FROM_LATER
    ]


# --- API: parse / simulate / saved scenarios ---------------------------------------------------


@pytest.fixture(autouse=True)
def _cleanup():
    whatif_router.WHATIF_RATE_LIMIT.reset()
    yield
    whatif_router.WHATIF_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _save_body(request: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": "Window",
        "source_file_name": "plan.xlsx",
        "source_file_sha256": "c" * 64,
        "imported_at": "2026-11-19T10:00:00Z",
        "request": request,
    }


async def test_api_parse_serves_window_bounds_and_simulate_echoes(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        from tests.test_p32_whatif_import_api import parse, standard_file

        parsed = (await parse(c, standard_file())).json()
        cw = parsed["current_week"]
        assert parsed["plan_from_min_week"] == cw
        assert [x["week"] for x in parsed["plan_week_choices"]] == list(range(cw, 105))
        assert all(r["file_band"] is None for r in parsed["rows"])
        rows = parsed["rows"]
        base = (await c.post("/whatif/import/simulate", json={"rows": rows})).json()
        same = (
            await c.post("/whatif/import/simulate", json={"rows": rows, "plan_from_week": cw})
        ).json()
        f = cw + 5
        later = await c.post("/whatif/import/simulate", json={"rows": rows, "plan_from_week": f})
        too_early = await c.post(
            "/whatif/import/simulate", json={"rows": rows, "plan_from_week": cw - 1}
        )
        windowed = await c.post(
            "/whatif/import/simulate",
            json={"rows": rows, "plan_from_week": f, "plan_until_week": 72},
        )
    # f = cw (given or not) is the same response.
    assert same == base
    assert base["plan_from_week"] == cw and base["plan_from_min_week"] == cw
    assert base["plan_until_week"] == 104 and base["plan_window_label"] is None
    assert base["plan_from_label"] == plan_week_label(cw)
    assert not any(i["code"].startswith("PLAN_") for i in base["issues"])

    assert too_early.status_code == 422 and too_early.json()["code"] == "INVALID_IMPORT"
    assert later.status_code == 200, later.text
    out = later.json()
    assert out["current_week"] == cw and out["plan_from_week"] == f
    assert [i["code"] for i in out["issues"] if i["ref"] is None][:1] == [PLAN_FROM_LATER]
    assert sum("file projects start from" in w.casefold() for w in out["workings"]) == 1
    # I54: every file project books nothing before f.
    for p in out["projects"]:
        if p["source"] != "file":
            continue
        for st in p["steps"]:
            if st["start_week"] is not None and not st["done_before_import"]:
                assert st["start_week"] >= f, (p["name"], st)
    dev = next(p for p in out["projects"] if p["name"] == "Fresh Dev")
    pdd_e = next(s for s in dev["steps"] if s["step_id"] == "PDD-E")
    assert pdd_e["status"] == "In Progress" and pdd_e["start_week"] == f

    assert windowed.status_code == 200, windowed.text
    win = windowed.json()
    assert win["plan_until_week"] == 72
    assert win["plan_window_label"] == f"W{f} 2026 – W20 2027"


async def test_api_saved_scenario_stores_window_and_reads_old_rows(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        cw = (await c.post("/whatif/import/simulate", json={"rows": rows})).json()["current_week"]
        f = cw + 3
        resp = await c.post(
            "/whatif/import/scenarios",
            json=_save_body({"rows": rows, "plan_from_week": f, "plan_until_week": 80}),
        )
        assert resp.status_code == 201, resp.text
        saved = resp.json()
        plain = (await c.post("/whatif/import/scenarios", json=_save_body({"rows": rows}))).json()
        listed = (await c.get("/whatif/import/scenarios")).json()["items"]
        export = await c.get(f"/whatif/import/scenarios/{saved['id']}/export.xlsx")
    assert export.status_code == 200, export.text
    summary = {
        k: v
        for label, v in report(
            openpyxl.load_workbook(io.BytesIO(export.content))["Summary"]
        ).items()
        for k in keys_of(label)
    }
    assert summary["plan_from_week"] == f and summary["plan_until_week"] == 80
    assert (saved["plan_from_week"], saved["plan_until_week"]) == (f, 80)
    assert saved["request"]["plan_from_week"] == f and saved["request"]["plan_until_week"] == 80
    assert saved["result"]["plan_from_week"] == f
    # Unset in the request: stored resolved (never null).
    assert plain["request"]["plan_from_week"] == cw
    assert plain["request"]["plan_until_week"] == 104
    by_id = {x["id"]: x for x in listed}
    assert (by_id[saved["id"]]["plan_from_week"], by_id[saved["id"]]["plan_until_week"]) == (f, 80)

    # A row saved before P49: no window keys anywhere.
    row = (
        await db_session.execute(
            select(WhatifImportScenario).where(WhatifImportScenario.id == plain["id"])
        )
    ).scalar_one()
    old_request = {
        k: v
        for k, v in row.request.items()
        if k not in ("plan_from_week", "plan_until_week", "plan_window_rerun")
    }
    old_result = {
        k: v
        for k, v in row.result.items()
        if not k.startswith("plan_from") and k not in (
            "plan_until_week", "plan_window_label", "plan_week_choices"
        )
    }  # fmt: skip
    await db_session.execute(
        update(WhatifImportScenario)
        .where(WhatifImportScenario.id == row.id)
        .values(request=old_request, result=old_result, simulated_week=cw - 4)
    )
    await db_session.flush()
    db_session.expire_all()
    async with client_for(db_session) as c:
        got = (await c.get(f"/whatif/import/scenarios/{plain['id']}")).json()
        listed = (await c.get("/whatif/import/scenarios")).json()["items"]
        compare = await c.get(
            f"/whatif/import/scenarios/compare.xlsx?ids={saved['id']},{plain['id']}"
        )
        # "Re-run on today's plan": the stored f (cw - 4) has passed.
        rerun = await c.post(
            "/whatif/import/simulate", json={**got["request"], "plan_window_rerun": True}
        )
        no_flag = await c.post("/whatif/import/simulate", json=got["request"])
    assert (got["plan_from_week"], got["plan_until_week"]) == (cw - 4, 104)
    assert got["request"]["plan_from_week"] == cw - 4
    assert got["result"]["plan_from_week"] == cw - 4
    assert {x["id"]: x["plan_from_week"] for x in listed}[plain["id"]] == cw - 4
    assert compare.status_code == 200, compare.text
    wb = openpyxl.load_workbook(io.BytesIO(compare.content), read_only=True)
    texts = {str(v) for ws in wb.worksheets for r in ws.iter_rows(values_only=True) for v in r if v}
    assert any("Plan windows differ" in t for t in texts)
    assert any("different weeks" in t for t in texts)
    assert no_flag.status_code == 422
    assert rerun.status_code == 200, rerun.text
    out = rerun.json()
    assert out["plan_from_week"] == cw
    assert PLAN_FROM_RAISED in [i["code"] for i in out["issues"]]


async def test_api_bands_parse_through_the_endpoint(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    data = build_workbook(
        [
            _band_row(sn=1, name="Fresh Must", must_do="Yes", hub="Greece", category="C",
                      status="Que"),
            _band_row({"Good to Have (P2)": "Yes"}, sn=2, name="Fresh Good", priority=2,
                      hub="Greece", category="C", status="Que"),
        ],
        headers=HEADERS_WITH_BANDS,
    )  # fmt: skip
    async with client_for(db_session) as c:
        from tests.test_p32_whatif_import_api import parse

        resp = await parse(c, data)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        sim = await c.post("/whatif/import/simulate", json={"rows": body["rows"]})
    rows = {r["name"]: r for r in body["rows"]}
    assert (rows["Fresh Must"]["priority"], rows["Fresh Must"]["priority_source"]) == (
        "P1",
        "band",
    )
    assert rows["Fresh Must"]["file_band"] == "P1"
    good = rows["Fresh Good"]
    assert (good["priority"], good["rank"], good["file_band"]) == ("P2", 2, "P2")
    assert sim.status_code == 200, sim.text
    served = {p["name"]: p["priority"] for p in sim.json()["projects"] if p["source"] == "file"}
    assert served == {"Fresh Must": "P1", "Fresh Good": "P2"}
