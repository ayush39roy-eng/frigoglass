"""P32-T04: the pure capacity-planning workbook parser (ADR 0044 §4–§6, contract B2).

No database. Synthetic workbooks only (`tests.plan_import_helpers`).
"""

from __future__ import annotations

import io
from collections import Counter
from typing import Any

import openpyxl
import pytest

import domain_constants as dc
from services.plan_import_xlsx import (
    MAX_DATA_ROWS,
    ImportFormatError,
    MatchableProject,
    ParseContext,
    ParseIssue,
    ParseResult,
    RosterEntry,
    StepMeta,
    parse_plan_workbook,
)
from tests.plan_import_helpers import (
    HEADERS,
    SECRET_CAPEX,
    SECRET_CUSTOMER,
    SECRET_NOTE,
    build_workbook,
    row,
)


def _ctx(
    roster: tuple[RosterEntry, ...] | None = None,
    projects: tuple[MatchableProject, ...] = (),
) -> ParseContext:
    lt: dict[tuple[str, str], dict[str, int]] = {}
    for wf, cat, sid, w in dc.LEAD_TIME_SEED:
        lt.setdefault((wf, cat), {})[sid] = w
    if roster is None:
        roster = (
            RosterEntry("e-lok", "Lokesh", "PD-India", "PD-India", 1.0),
            RosterEntry("e-rahul", "Rahul-Contractual", "PD-India", "PD-India", 0.5),
            RosterEntry("e-stef", "Stef Marius", "PD-Romania", "PD-Romania", 1.0),
            RosterEntry("e-ash", "Ashish", "R&D-India", "R&D-India", 1.0),
            RosterEntry("e-kan", "Kanarios", "R&D-Greece", "R&D-Greece", 0.8),
            RosterEntry("e-ghost", "Ghosty", "PD-India", "PD-India", 0.0),
        )
    return ParseContext(
        roster=roster,
        projects=projects,
        steps=tuple(
            StepMeta(wf, sid, name, kind, so, preds)
            for wf, sid, _c, name, kind, so, preds in dc.WORKFLOW_STEP_TEMPLATE_SEED
        ),
        app_lead_times=lt,
        current_week=42,
    )


def _parse(rows, ctx: ParseContext | None = None, **kw) -> ParseResult:
    return parse_plan_workbook(build_workbook(rows, **kw), ctx or _ctx())


def _codes(res: ParseResult, key: str | None = None) -> Counter[str]:
    return Counter(i.code for i in res.issues if key is None or i.row_key == key)


# --- sheets and headers --------------------------------------------------------------------


def test_finds_sheets_by_content_and_reads_known_columns_only():
    res = _parse(
        [row(sn=1, code="26-00001", plant="Rom", name="Alpha", hub="PD ROM", category="A",
             stage="PDD-A", status="Que", engineer="Stef", spillover="Yes", num=2,
             must_do="Yes", complexity="M", est=" 6-12")],
        leading_sheet=True,
    )  # fmt: skip
    assert res.projects_sheet == "draft 1 291026"
    assert res.steps_sheet == "Process steps"
    (r,) = res.rows
    assert (r.key, r.file_row) == ("row-3", 3)  # stray totals row 1, header row 2
    assert (r.sn, r.code, r.plant, r.name) == ("1", "26-00001", "Rom", "Alpha")
    assert (r.hub, r.category, r.status) == ("PD-Romania", "A", "In Queue")
    assert r.stage_step_id == "PDD-A" and r.include is True
    assert r.leader.kind == "existing" and r.leader.engineer_id == "e-stef"
    assert (r.spillover_from_previous, r.must_do, r.num_projects) == (True, True, 2)
    assert (r.complexity, r.est_duration_months) == ("M", "6-12")
    assert r.lead_time_label == "A"
    assert r.step_weeks == {f"PDD-{c}": w for c, w in zip("ABCDEFGHIJKLMN",
                            (1, 4, 4, 1, 6, 4, 2, 6, 2, 1, 2, 3, 1, 1), strict=True)}  # fmt: skip
    blob = repr(res)
    for secret in (SECRET_CUSTOMER, SECRET_NOTE, str(SECRET_CAPEX), "secret business case"):
        assert secret not in blob


def test_header_variants_are_tolerated():
    rename = {
        "Project description": "  project   DESCRIPTION ",
        "Status": "STATUS",
        "Recommended Design Engineer ": "Recommended design engineer (name)",
        "Spillover from 2026": "Spillover from 2027",
        "Est. Dur. (Months)": "Est. Dur (months)",
        "RPD HUB": "rpd hub",
    }
    res = _parse(
        [row(name="Beta", hub="Greece", category="B", status="Development", engineer="Kanarios",
             spillover="no", est="<3")],
        rename=rename,
    )  # fmt: skip
    (r,) = res.rows
    assert (r.name, r.hub, r.status) == ("Beta", "R&D-Greece", "In Development")
    assert r.leader.engineer_id == "e-kan"
    assert r.spillover_from_previous is False and r.est_duration_months == "<3"


def test_no_header_is_import_format_naming_the_headers():
    with pytest.raises(ImportFormatError) as exc:
        _parse([row(name="x")], headers=("Foo", "Bar"))
    assert "Project description" in str(exc.value) and "RPD HUB" in str(exc.value)


def test_header_beyond_60_columns_is_not_scanned():
    headers = tuple(f"Col {i}" for i in range(60)) + HEADERS
    with pytest.raises(ImportFormatError):
        _parse([row(name="x", status="Que")], headers=headers)


def test_rows_without_description_are_skipped():
    res = _parse([row(name="A1", status="Que"), row(name=None, status="Que"),
                  row(name="  ", status="Que"), row(name="A2", status="Que")])  # fmt: skip
    assert [r.name for r in res.rows] == ["A1", "A2"]


def test_too_many_rows_is_rejected():
    rows = [row(name=f"P{i}", status="Que", hub="Greece") for i in range(MAX_DATA_ROWS + 1)]
    with pytest.raises(ImportFormatError, match="more than 2000"):
        _parse(rows)


def test_exactly_the_row_cap_is_accepted():
    rows = [row(name=f"P{i}", status="Que", hub="Greece") for i in range(MAX_DATA_ROWS)]
    assert len(_parse(rows).rows) == MAX_DATA_ROWS


def test_not_a_workbook_and_oversize():
    with pytest.raises(ImportFormatError):
        parse_plan_workbook(b"PK\x03\x04 not really a zip", _ctx())
    with pytest.raises(ImportFormatError):
        parse_plan_workbook(b"hello", _ctx())
    with pytest.raises(ImportFormatError, match="5 MB"):
        parse_plan_workbook(b"x" * (5 * 1024 * 1024 + 1), _ctx())


def test_formulas_are_read_as_cached_values_never_evaluated():
    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.append(["Project description", "Status", "PRIORITY"])
    ws.append(["Formula row", "Que", "=1+1"])  # openpyxl writes no cached value
    buf = io.BytesIO()
    wb.save(buf)
    res = parse_plan_workbook(buf.getvalue(), _ctx())
    (r,) = res.rows
    assert r.rank is None and r.priority == "P3"


# --- process steps -----------------------------------------------------------------------------


def test_process_steps_rows_special_cplus_d_blank_zero_sum_ignored():
    res = _parse([row(name="x", status="Que", hub="Greece", category="A")])
    lt = {(r.workflow, r.label): r.weeks for r in res.lead_times}
    assert set(lt) == {("PDD", "Special Category"), ("PDD", "A+"), ("PDD", "A"), ("PDD", "B"),
                       ("PDD", "C+"), ("PDD", "D"), ("OEM", "A-OEM"), ("OEM", "B-OEM"),
                       ("OEM", "C-OEM")}  # fmt: skip
    assert lt[("PDD", "Special Category")]["PDD-B"] == 9
    assert lt[("PDD", "B")]["PDD-F"] == 0  # blank = 0
    assert lt[("PDD", "D")]["PDD-K"] == 0
    assert all(len(w) == 14 for w in lt.values())
    assert 999 not in lt[("PDD", "A")].values()  # the Sum column is ignored
    assert "LEAD_TIME_VALUE" not in _codes(res)


def test_bad_lead_time_cells_are_coerced_with_a_warning():
    pdd = (("A", (1, "abc", 4, 1, 6, -2, 2, 6, 2.5, 1, 2, 3, 1, 500)),)
    res = _parse([row(name="x", status="Que", hub="Greece", category="A")], pdd=pdd, oem=None)
    w = res.rows[0].step_weeks
    assert (w["PDD-B"], w["PDD-F"], w["PDD-N"]) == (0, 0, 104)
    assert w["PDD-I"] in (2, 3)
    assert _codes(res)["LEAD_TIME_VALUE"] == 4


def test_missing_steps_sheet_uses_the_app_table():
    res = _parse([row(name="x", status="Que", hub="Greece", category="B")], steps=False)
    assert res.steps_sheet is None and res.lead_times == ()
    assert _codes(res)["NO_PROCESS_STEPS"] == 1
    r = res.rows[0]
    assert r.lead_time_label == "app"
    app_b = {sid: w for wf, cat, sid, w in dc.LEAD_TIME_SEED if (wf, cat) == ("PDD", "B")}
    assert r.step_weeks == app_b


# --- column mapping ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Que", "In Queue"), ("In Que", "In Queue"), ("queue", "In Queue"),
        ("Development", "In Development"), ("Industrialization", "Under Industrialization"),
        ("On Hold", "On Hold"), ("On HOld", "On Hold"), ("ON HOld", "On Hold"),
        ("In Buyoff", "In Buyoff"), ("Under Industrialization", "Under Industrialization"),
        (None, "In Queue"), ("Weird", "In Queue"),
    ],
)  # fmt: skip
def test_status_mapping(raw, expected):
    res = _parse([row(name="x", status=raw, hub="Greece", category="A")])
    assert res.rows[0].status == expected
    codes = _codes(res)
    assert ("STATUS_DEFAULTED" in codes) == (raw in (None, "Weird"))
    assert ("STATUS_NOT_SCHEDULED" in codes) == (expected == "On Hold")
    # Owner rule 2026-11-04: On Hold rows are not mapped (include=false).
    assert res.rows[0].include is (expected != "On Hold")


def test_hub_mapping_and_fallbacks():
    res = _parse(
        [
            row(name="g", hub="Greece", category="A", status="Que"),
            row(name="r1", hub="PD ROM", category="A", status="Que"),
            row(name="r2", hub="ROM", category="A", status="Que"),
            row(name="i1", hub="India", category="A", status="Que", engineer="Lokesh Sharma"),
            row(name="i2", hub="India", category="A", status="Que", engineer="Ashish Kumar"),
            row(name="i3", hub="SAF", category="A", status="Que"),
            row(name="o1", hub="OEM-HCK", category="A-OEM", status="Que"),
            row(name="o2", hub="OEM-Seitek", category="B-OEM", status="Que"),
            row(name="o3", hub="OEM-NSR", category="B-OEM", status="Que"),
            row(name="e1", hub=None, expenses="OEM/Seitek-HCK", category="B-OEM", status="Que"),
            row(name="p1", hub=None, expenses="industrialization", plant="Egypt", category="A",
                status="Que"),
            row(name="c1", hub="ROM", plant="Consumer appl.", category="B-OEM", stage="OEM-B",
                status="Que"),
            row(name="c2", hub="ROM", expenses="OEM/Seitek", category="C-OEM", status="Que"),
            row(name="n1", hub=None, plant="Mars", category="A", status="Que"),
            row(name="n2", hub=None, category="A", status="Que", engineer="Stef"),
        ]
    )  # fmt: skip
    hubs = {r.name: r.hub for r in res.rows}
    assert hubs == {
        "g": "R&D-Greece", "r1": "PD-Romania", "r2": "PD-Romania", "i1": "PD-India",
        "i2": "R&D-India", "i3": "PD-India", "o1": "OEM-HCK", "o2": "OEM-Seitek",
        "o3": "OEM-HCK", "e1": "OEM-Seitek", "p1": "PD-India", "c1": "OEM-HCK",
        "c2": "OEM-Seitek", "n1": "R&D-Greece", "n2": "PD-Romania",
    }  # fmt: skip
    key = {r.name: r.key for r in res.rows}
    assert _codes(res, key["o3"])["HUB_OEM_DEFAULTED"] == 1
    assert _codes(res, key["c1"])["HUB_OEM_DEFAULTED"] == 1
    assert _codes(res, key["e1"])["HUB_DEFAULTED"] == 1  # info: taken from Expenses
    assert _codes(res, key["n1"])["HUB_DEFAULTED"] == 1
    sev = {(i.row_key, i.code): i.severity for i in res.issues}
    assert sev[(key["e1"], "HUB_DEFAULTED")] == "info"
    assert sev[(key["n1"], "HUB_DEFAULTED")] == "warning"
    # The OEM rows follow the OEM workflow.
    assert set(res.rows[6].step_weeks) == {f"OEM-{c}" for c in "ABCDEFGHIJKLMN"}


def test_category_mapping_and_lead_time_rows():
    res = _parse(
        [
            row(name="ap", hub="Greece", category="A+", status="Que"),
            row(name="cp", hub="Greece", category="C+", status="Que"),
            row(name="d", hub="Greece", category="D", status="Que"),
            row(name="c", hub="Greece", category="C", status="Que"),
            row(name="blank", hub="Greece", category=None, status="Que"),
            row(name="sp1", code="Special Category", hub="Greece", category="A", status="Que"),
            row(name="sp2", hub="Greece", category="Special Category", status="Que"),
            row(name="oemb", hub="OEM-HCK", category="B", status="Que"),
            row(name="oblank", hub="OEM-HCK", category=None, status="Que"),
        ]
    )  # fmt: skip
    got = {r.name: (r.category, r.lead_time_label) for r in res.rows}
    assert got == {
        "ap": ("A+", "A+"), "cp": ("C", "C+"), "d": ("C", "D"), "c": ("C", "app"),
        "blank": ("B", "B"), "sp1": ("A", "Special Category"),
        "sp2": ("A+", "Special Category"), "oemb": ("B-OEM", "B-OEM"),
        "oblank": ("B-OEM", "B-OEM"),
    }  # fmt: skip
    by = {r.name: r for r in res.rows}
    assert by["sp1"].code is None  # "Special Category" in the code column is not a code
    assert by["sp1"].step_weeks["PDD-B"] == 9
    assert by["d"].step_weeks["PDD-E"] == 1
    assert _codes(res, by["blank"].key)["CATEGORY_DEFAULTED"] == 1
    assert _codes(res, by["c"].key)["LEAD_TIME_ROW_MISSING"] == 1
    assert _codes(res, by["oemb"].key)["CATEGORY_MAPPED"] == 1


def test_stage_mapping():
    res = _parse(
        [
            row(name="a", hub="Greece", category="A", stage="PDD-E", status="Development"),
            row(name="b", hub="OEM-HCK", category="A-OEM", stage="PDD-D", status="Que"),
            row(name="c", hub="Greece", category="A", stage="Phase 3", status="Que"),
            row(name="d", hub="Greece", category="A", stage=None, status="Que"),
            row(name="e", hub="Greece", category="A", stage=" pdd-h ", status="Que"),
        ]
    )  # fmt: skip
    by = {r.name: r for r in res.rows}
    assert by["a"].stage_step_id == "PDD-E"
    assert by["b"].stage_step_id == "OEM-D"
    assert _codes(res, by["b"].key)["STAGE_WORKFLOW_MISMATCH"] == 1
    assert by["c"].stage_step_id is None and _codes(res, by["c"].key)["STAGE_UNKNOWN"] == 1
    assert by["d"].stage_step_id is None and "STAGE_UNKNOWN" not in _codes(res, by["d"].key)
    assert by["e"].stage_step_id == "PDD-H"


def test_engineer_matching_full_first_surname_fte0_tbc_unknown():
    roster = (
        RosterEntry("e-lok", "Lokesh", "PD-India", "PD-India", 1.0),
        RosterEntry("e-rahul", "Rahul-Contractual", "PD-India", "PD-India", 0.5),
        RosterEntry("e-stef", "Stef Marius", "PD-Romania", "PD-Romania", 1.0),
        RosterEntry("e-alin", "Alin Boboc", "PD-Romania", "PD-Romania", 1.0),
        RosterEntry("e-alin2", "Alin Other", "PD-Romania", "PD-Romania", 1.0),
        RosterEntry("e-ghost", "Ghosty", "PD-India", "PD-India", 0.0),
    )
    res = _parse(
        [
            row(name="1", hub="India", category="A", status="Que", engineer="Lokesh Sharma"),
            row(name="2", hub="ROM", category="A", status="Que", engineer="stef"),
            row(name="3", hub="India", category="A", status="Que", engineer="Rahul Bhardwaj"),
            row(name="4", hub="ROM", category="A", status="Que", engineer="Mr Boboc"),
            row(name="5", hub="ROM", category="A", status="Que", engineer="Alin"),
            row(name="6", hub="India", category="A", status="Que", engineer="Ghosty"),
            row(name="7", hub="India", category="A", status="Que", engineer="TBC"),
            row(name="8", hub="India", category="A", status="Que", engineer=None),
            row(name="9", hub="Greece", category="A", status="Que", engineer="Vasilis L"),
            row(name="10", hub="Greece", category="A", status="Que", engineer="STEF  MARIUS"),
        ],
        _ctx(roster=roster),
    )  # fmt: skip
    lead = {r.name: (r.leader.kind, r.leader.engineer_id, r.leader.name) for r in res.rows}
    assert lead["1"] == ("existing", "e-lok", "Lokesh")
    assert lead["2"] == ("existing", "e-stef", "Stef Marius")
    assert lead["3"] == ("existing", "e-rahul", "Rahul-Contractual")
    assert lead["4"] == ("existing", "e-alin", "Alin Boboc")  # unique surname
    assert lead["5"] == ("new", None, "Alin")  # first name not unique, no surname match
    assert lead["6"] == ("new", None, "Ghosty")  # FTE 0 is never matched
    assert lead["7"][0] == "auto" and lead["8"][0] == "auto"
    assert lead["9"] == ("new", None, "Vasilis L")
    assert lead["10"] == ("existing", "e-stef", "Stef Marius")
    assert res.counts.auto_assign == 2
    assert res.counts.new_designers == 3  # Alin (PD-Romania), Ghosty (PD-India), Vasilis L
    codes = _codes(res)
    assert codes["ENGINEER_MISSING"] == 2 and codes["ENGINEER_UNKNOWN"] == 3


def test_project_matching_by_name_then_code():
    projects = (
        MatchableProject("p-alpha", "Alpha  Cooler", "26-00001", "R&D-Greece", "P2"),
        MatchableProject("p-beta", "Beta", "26-00002", "PD-India", "P4"),
        MatchableProject("p-dup1", "Twin", None, "R&D-Greece", "P1"),
        MatchableProject("p-dup2", "twin", None, "R&D-Greece", "P1"),
        MatchableProject("p-gamma", "Gamma", "26-00003", "R&D-Greece", None),
    )
    res = _parse(
        [
            row(name="alpha\tcooler", code="NEW", hub="Greece", category="A", status="Que"),
            row(name="Beta renamed", code="26-00002 ", hub="India", category="A", status="Que"),
            row(name="Twin", hub="Greece", category="A", status="Que"),
            row(name="Gamma 2", code="TBA", hub="Greece", category="A", status="Que"),
            row(name="Gamma 3", code="26-00003", hub="Greece", category="A", status="Que"),
            row(name="Gamma 4", code="26-00003", hub="Greece", category="A", status="Que"),
        ],
        _ctx(projects=projects),
    )  # fmt: skip
    rows = list(res.rows)
    assert (rows[0].matched_project_id, rows[0].match_by) == ("p-alpha", "name")
    assert rows[0].matched_project_name == "Alpha  Cooler"
    assert (rows[1].matched_project_id, rows[1].match_by) == ("p-beta", "code")
    assert rows[2].matched_project_id is None  # two plan projects share the name
    assert _codes(res, rows[2].key)["MATCH_AMBIGUOUS"] == 1
    assert rows[3].matched_project_id is None  # TBA is not a code
    # The same real code twice in the file: neither row matches.
    assert rows[4].matched_project_id is None and rows[5].matched_project_id is None
    assert res.counts.matched == 2 and res.counts.new == 4
    assert _codes(res)["MATCHED"] == 2


def test_duplicate_rows_flagged_and_not_matched():
    projects = (MatchableProject("p-a", "Same", None, "R&D-Greece", "P2"),)
    res = _parse(
        [row(name="Same", hub="Greece", category="A", status="Que"),
         row(name="same ", hub="Greece", category="A", status="Que")],
        _ctx(projects=projects),
    )  # fmt: skip
    assert [r.matched_project_id for r in res.rows] == [None, None]
    assert _codes(res)["DUPLICATE_ROW"] == 1


def test_priority_rank_matched_band_default():
    projects = (
        MatchableProject("p-a", "Matched", None, "R&D-Greece", "P2"),
        MatchableProject("p-b", "Ranked match", None, "R&D-Greece", "P4"),
    )
    res = _parse(
        [
            row(name="Ranked", priority=3, hub="Greece", category="A", status="Que"),
            row(name="Ranked match", priority="1", hub="Greece", category="A", status="Que"),
            row(name="Matched", hub="Greece", category="A", status="Que"),
            row(name="New", hub="Greece", category="A", status="Que"),
            row(name="Bad", priority="high", hub="Greece", category="A", status="Que"),
            row(name="Zero", priority=0, hub="Greece", category="A", status="Que"),
            row(name="Float", priority=2.0, hub="Greece", category="A", status="Que"),
        ],
        _ctx(projects=projects),
    )  # fmt: skip
    got = {r.name: (r.rank, r.priority, r.priority_source) for r in res.rows}
    assert got == {
        "Ranked": (3, "P1", "rank"), "Ranked match": (1, "P1", "rank"),
        "Matched": (None, "P2", "matched"), "New": (None, "P3", "default"),
        "Bad": (None, "P3", "default"), "Zero": (None, "P3", "default"),
        "Float": (2, "P1", "rank"),
    }  # fmt: skip
    assert _codes(res)["RANK_INVALID"] == 2


def test_counts():
    res = _parse(
        [
            row(name="a", hub="Greece", category="A", status="Que", engineer="Kanarios"),
            row(name="b", hub="Greece", category="A", status="On Hold"),
            row(name="c", hub="Greece", category="A", status="Development", engineer="Zed"),
            row(name="d", hub="Greece", category="A", status="Development", engineer="zed"),
        ]
    )  # fmt: skip
    c = res.counts
    assert (c.rows, c.schedulable, c.not_scheduled, c.matched, c.new) == (4, 3, 1, 0, 4)
    assert (c.auto_assign, c.new_designers) == (1, 1)  # "Zed" / "zed" is one designer
    assert c.projects_after_expansion == 3


# Owner rule 2026-11-04: Num of Projects blank / 1 is one project, n >= 2 is n;
# anything else is read as 1 with a warning.
@pytest.mark.parametrize(
    "raw,expected,warned",
    [
        (None, None, False),
        ("", None, False),
        ("   ", None, False),
        (1, 1, False),
        ("2", 2, False),
        (2.0, 2, False),
        (" 3 ", 3, False),
        ("4.0", 4, False),
        (100, 100, False),
        ("x", None, True),
        (0, None, True),
        (-2, None, True),
        ("-2", None, True),
        (101, None, True),
        (2.5, None, True),
        ("2.5", None, True),
        (True, None, True),
    ],
)
def test_num_projects_parsing(raw, expected, warned):
    res = _parse([row(name="a", hub="Greece", category="A", status="Que", num=raw)])
    (r,) = res.rows
    assert r.num_projects == expected
    assert (_codes(res)["NUM_PROJECTS_INVALID"] == 1) is warned
    if warned:
        (i,) = [i for i in res.issues if i.code == "NUM_PROJECTS_INVALID"]
        assert (i.severity, i.field, i.row_key) == ("warning", "num_projects", r.key)
        assert "read as 1 project" in i.message
    assert res.counts.projects_after_expansion == (expected or 1)


def test_projects_after_expansion_counts_schedulable_included_rows_only():
    res = _parse(
        [
            row(name="a", hub="Greece", category="A", status="Que", num=5),
            row(name="b", hub="Greece", category="A", status="Que", num=1),
            row(name="c", hub="Greece", category="A", status="Que"),
            row(name="d", hub="Greece", category="A", status="On Hold", num=7),
            row(name="e", hub="Greece", category="A", status="Que", num="lots"),
        ]
    )  # fmt: skip
    assert res.counts.schedulable == 4
    assert res.counts.projects_after_expansion == 5 + 1 + 1 + 1


def test_blank_engineer_on_a_matched_row_keeps_the_plan_leader():
    """ADR 0044 §5 (amended 2026-11-04): blank / TBC on a matched row takes the
    plan project's leader; auto-assign only when neither has one (or the plan
    leader cannot lead: FTE 0 / not counted, i.e. not on the roster)."""

    projects = (
        MatchableProject("p-1", "Kept", None, "PD-India", "P2", leader_engineer_id="e-ash"),
        MatchableProject("p-2", "Leaderless", None, "PD-India", "P2"),
        MatchableProject("p-3", "Ghost led", None, "PD-India", "P2", leader_engineer_id="e-ghost"),
        MatchableProject("p-4", "Named", None, "PD-India", "P2", leader_engineer_id="e-ash"),
    )
    res = _parse(
        [
            row(name="Kept", hub="India", category="A", status="Que", engineer="TBC"),
            row(name="Leaderless", hub="India", category="A", status="Que"),
            row(name="Ghost led", hub="India", category="A", status="Que"),
            row(name="Named", hub="India", category="A", status="Que", engineer="Lokesh"),
        ],
        _ctx(projects=projects),
    )
    by = {r.name: r for r in res.rows}
    assert (by["Kept"].leader.kind, by["Kept"].leader.engineer_id) == ("existing", "e-ash")
    assert by["Kept"].hub == "R&D-India"  # India + the (plan) leader's R&D-India hub
    assert _codes(res, by["Kept"].key)["ENGINEER_FROM_PLAN"] == 1
    assert "ENGINEER_MISSING" not in _codes(res, by["Kept"].key)
    assert by["Leaderless"].leader.kind == "auto"
    assert by["Ghost led"].leader.kind == "auto"  # an FTE-0 leader is never kept
    assert by["Named"].leader.engineer_id == "e-lok"  # the file's name wins
    assert res.counts.auto_assign == 2


# --- P32-R06: the 2026-11-05 "priorities" workbook (no Status, Num of Models) ------------------


def _plan_projects() -> tuple[MatchableProject, ...]:
    return (
        MatchableProject("p-alpha", "Plan Alpha", None, "PD-India", "P2",
                         leader_engineer_id="e-lok", status="In Development", category="A",
                         current_step_id="PDD-E"),
        MatchableProject("p-hold", "Plan Hold", None, "R&D-Greece", "P3", status="On Hold",
                         category="B", current_step_id="PDD-A"),
        MatchableProject("p-run", "Plan Running", None, "PD-Romania", "P4", status="In Queue",
                         category="B", current_step_id="PDD-A"),
        MatchableProject("p-oemcat", "Plan OEM on Rom", None, "OEM-HCK", "P2",
                         status="In Queue", category="B-OEM", current_step_id="OEM-C"),
        MatchableProject("p-romoem", "Plan Rom OEM", None, "PD-Romania", "P3",
                         status="Under Industrialization", category="A",
                         current_step_id="PDD-H"),
        MatchableProject("p-code", "Old Name", "26-00077", "PD-India", "P2", status="In Buyoff",
                         category="C", current_step_id="PDD-K"),
    )  # fmt: skip


BUDGET_NAMES = (
    "Provision for alternative & RM saving 2027",
    "provision for RM saving (India)",
    "Update Certification",
    "PDD Europe CAPEX Romania",
    "R&D CAPEX",
    "PDD Europe Certification program",
    "PDD India CAPEX",
)


def _priorities_rows() -> list[dict[str, Any]]:
    return [
        row(name="Running Chiller", priority="Running", hub="Rom", spillover="No"),
        row(name="Unbound Cooler", priority=2, hub="Rom/Unbound", category="A+", engineer="Stef"),
        row(name="OEM Bottle", priority=1, hub="Rom/OEM", category="B"),
        row(name="OEM Seitek", priority=3, hub="Rom/OEM", expenses="OEM/Seitek"),
        *[row(name=n) for n in BUDGET_NAMES],
        row(name="Alt Compressor[BIS] Certification Coke 400L", hub="India"),
        row(name="Coke EC28 migration feasibility", hub="India"),
        row(name="Capex tooling cooler", priority=5, hub="Rom"),
        row(name="Feasibility to define cost & capex for a new cooler", hub="Rom"),
        row(name="Spill Freezer", hub="India", spillover="Yes"),
        row(name="Plan Alpha", spillover="Yes"),
        row(name="Plan Hold", spillover="Yes"),
        row(name="Plan Running", priority="RUNNING ", hub="Rom"),
        row(name="Plan OEM on Rom", priority=4, hub="Rom"),
        row(name="Plan Rom OEM", priority=6, hub="Rom/OEM"),
        row(name="New Name", code="26-00077", hub="India", category="B", num=3),
        row(name="Consumer thing", plant="Consumer appl."),
    ]  # fmt: skip


def _priorities_parse() -> ParseResult:
    from tests.plan_import_helpers import build_priorities_workbook

    return parse_plan_workbook(
        build_priorities_workbook(_priorities_rows()), _ctx(projects=_plan_projects())
    )


def test_priorities_workbook_header_and_status_column_absent():
    res = _priorities_parse()
    assert len(res.rows) == 23 and res.rows[0].file_row == 3  # header on row 2
    file_level = [i for i in res.issues if i.row_key is None and i.code == "STATUS_NOT_IN_FILE"]
    assert len(file_level) == 1 and file_level[0].severity == "info"
    assert "no Status column" in file_level[0].message
    codes = _codes(res)
    assert "STATUS_DEFAULTED" not in codes  # the whole column is absent: no per-row warning
    assert all(r.status_raw is None for r in res.rows)
    by = {r.name: r for r in res.rows}
    assert by["New Name"].num_projects == 3  # "Num of Models"


def test_priorities_status_derivation_first_match_wins():
    res = _priorities_parse()
    by = {r.name: r for r in res.rows}

    def st(name: str) -> tuple[str, set[str]]:
        r = by[name]
        return r.status, {i.code for i in res.issues if i.row_key == r.key and
                          i.field == "status"}  # fmt: skip

    assert st("Running Chiller") == ("In Development", {"STATUS_FROM_RUNNING"})
    assert st("Plan Running") == ("In Development", {"STATUS_FROM_RUNNING"})  # before the plan
    assert st("Plan Alpha") == ("In Development", {"STATUS_FROM_PLAN"})
    assert st("Plan Hold") == ("On Hold", {"STATUS_FROM_PLAN", "STATUS_NOT_SCHEDULED"})
    assert by["Plan Hold"].include is False  # the not-mapped rule, before Spillover
    assert st("Plan OEM on Rom") == ("In Queue", {"STATUS_FROM_PLAN"})
    assert st("Plan Rom OEM") == ("Under Industrialization", {"STATUS_FROM_PLAN"})
    assert st("New Name") == ("In Buyoff", {"STATUS_FROM_PLAN"})
    assert st("Spill Freezer") == ("In Development", {"STATUS_FROM_SPILLOVER"})
    assert st("Unbound Cooler") == ("In Queue", set())  # no per-row issue
    assert st("Consumer thing") == ("In Queue", set())
    sev = {i.severity for i in res.issues if i.code.startswith("STATUS_FROM_")}
    assert sev == {"info"}
    assert res.counts.derived_status == 8


def test_priorities_running_rank_and_priority_sources():
    res = _priorities_parse()
    got = {r.name: (r.rank, r.priority, r.priority_source) for r in res.rows}
    assert got["Running Chiller"] == (0, "P1", "running")
    assert got["Plan Running"] == (0, "P1", "running")  # "RUNNING " any case
    assert got["Unbound Cooler"] == (2, "P1", "rank")
    assert got["Plan Alpha"] == (None, "P2", "matched")
    assert got["Spill Freezer"] == (None, "P3", "default")
    assert "RANK_INVALID" not in _codes(res)


def test_priorities_hub_rules():
    res = _priorities_parse()
    by = {r.name: r for r in res.rows}
    hubs = {n: r.hub for n, r in by.items()}
    assert hubs["Running Chiller"] == "PD-Romania"
    assert hubs["Unbound Cooler"] == "PD-Romania"
    assert hubs["OEM Bottle"] == "OEM-HCK"
    assert hubs["OEM Seitek"] == "OEM-Seitek"
    assert hubs["Plan Alpha"] == "PD-India"  # blank hub -> the plan's
    assert hubs["Plan Rom OEM"] == "OEM-HCK"
    assert hubs["Consumer thing"] == "R&D-Greece"  # the existing fallback
    assert hubs["Spill Freezer"] == "PD-India"

    def iss(name: str, code: str) -> list[ParseIssue]:
        return [i for i in res.issues if i.row_key == by[name].key and i.code == code]

    (m,) = iss("Unbound Cooler", "HUB_MAPPED")
    assert m.severity == "info" and "Unbound" in m.message
    assert iss("OEM Bottle", "HUB_MAPPED") and iss("OEM Bottle", "HUB_OEM_DEFAULTED")
    assert iss("OEM Seitek", "HUB_MAPPED") and not iss("OEM Seitek", "HUB_OEM_DEFAULTED")
    (hp,) = iss("Plan Alpha", "HUB_FROM_PLAN")
    assert hp.severity == "info"
    assert not iss("Plan Alpha", "HUB_DEFAULTED")
    (hd,) = iss("Consumer thing", "HUB_DEFAULTED")
    assert hd.severity == "warning"
    assert set(by["OEM Bottle"].step_weeks) == {f"OEM-{c}" for c in "ABCDEFGHIJKLMN"}


def test_priorities_category_stage_engineer_from_plan():
    res = _priorities_parse()
    by = {r.name: r for r in res.rows}

    def codes(name: str) -> Counter[str]:
        return _codes(res, by[name].key)

    a = by["Plan Alpha"]
    assert (a.category, a.lead_time_label) == ("A", "A")
    assert a.stage_step_id == "PDD-E"
    assert (a.leader.kind, a.leader.engineer_id) == ("existing", "e-lok")
    c = codes("Plan Alpha")
    for code in ("CATEGORY_FROM_PLAN", "STAGE_FROM_PLAN", "ENGINEER_FROM_PLAN", "HUB_FROM_PLAN"):
        assert c[code] == 1, code
    assert "CATEGORY_DEFAULTED" not in c and "ENGINEER_MISSING" not in c
    # A plan OEM category on a PDD hub -> its base; the plan's OEM step is not used.
    o = by["Plan OEM on Rom"]
    assert o.category == "B" and o.stage_step_id is None
    assert codes("Plan OEM on Rom")["CATEGORY_FROM_PLAN"] == 1
    assert codes("Plan OEM on Rom")["CATEGORY_MAPPED"] == 1
    assert "STAGE_FROM_PLAN" not in codes("Plan OEM on Rom")
    # Rom/OEM + a plan PDD category -> the OEM category.
    r = by["Plan Rom OEM"]
    assert (r.category, r.lead_time_label, r.stage_step_id) == ("A-OEM", "A-OEM", None)
    assert codes("Plan Rom OEM")["CATEGORY_MAPPED"] == 1
    # Rom/OEM + a file "B" -> B-OEM.
    assert by["OEM Bottle"].category == "B-OEM"
    assert codes("OEM Bottle")["CATEGORY_MAPPED"] == 1
    # The file's category wins over the plan's; the plan's stage fills the blank.
    n = by["New Name"]
    assert (n.matched_project_id, n.match_by) == ("p-code", "code")
    assert n.category == "B" and n.stage_step_id == "PDD-K"
    assert "CATEGORY_FROM_PLAN" not in codes("New Name")
    # Not matched: the existing defaults.
    rc = by["Running Chiller"]
    assert rc.category == "B" and codes("Running Chiller")["CATEGORY_DEFAULTED"] == 1
    assert rc.stage_step_id is None and rc.leader.kind == "auto"
    assert by["OEM Seitek"].category == "B-OEM"
    sev = {i.severity for i in res.issues if i.code in ("CATEGORY_FROM_PLAN", "STAGE_FROM_PLAN")}
    assert sev == {"info"}


def test_priorities_budget_lines_are_excluded():
    res = _priorities_parse()
    by = {r.name: r for r in res.rows}
    for n in BUDGET_NAMES:
        r = by[n]
        assert r.include is False and r.status == "In Queue", n
        (i,) = [i for i in res.issues if i.row_key == r.key and i.code == "NOT_A_PROJECT"]
        assert i.severity == "info" and "budget line" in i.message
    for n in (
        "Alt Compressor[BIS] Certification Coke 400L",
        "Coke EC28 migration feasibility",
        "Capex tooling cooler",
        "Feasibility to define cost & capex for a new cooler",
    ):
        assert by[n].include is True, n
        assert "NOT_A_PROJECT" not in _codes(res, by[n].key)
    assert _codes(res)["NOT_A_PROJECT"] == 7


def test_priorities_counts():
    c = _priorities_parse().counts
    assert (c.rows, c.schedulable, c.not_scheduled, c.matched, c.new) == (23, 22, 1, 6, 17)
    assert (c.derived_status, c.not_a_project) == (8, 7)
    # 23 rows - 7 budget lines - 1 On Hold = 15 included rows; "New Name" is 3.
    assert c.projects_after_expansion == 17
    assert c.auto_assign == 21  # all but Stef and the kept plan leader


@pytest.mark.parametrize(
    "name,budget",
    [
        ("Provision for alternative & RM saving", True),
        ("  PROVISION for x", True),
        ("Update certification 2027", True),
        ("PDD Europe CAPEX Romania", True),
        ("R&D Capex", True),
        ("PDD India Certification Program", True),
        ("Alt Compressor[BIS] Certification Coke 400L", False),
        ("Coke EC28 migration feasibility", False),
        ("Provisional cooler", False),
        ("Capexless cooler", False),
        ("PDD India CAPEX", True),
        ("Feasibility to define cost & capex for a new cooler", False),
        ("Certification update for door", False),
    ],
)
def test_budget_line_patterns(name, budget):
    from services.plan_import_xlsx import is_budget_line

    assert is_budget_line(name) is budget


@pytest.mark.parametrize("header", ["Num of Models", "Num of Model(s)", "No. of models",
                                    "NUM OF MODELS "])  # fmt: skip
def test_num_of_models_header_aliases(header):
    res = _parse([row(name="a", hub="Greece", category="A", status="Que", num=4)],
                 rename={"Num of Projects": header})  # fmt: skip
    assert res.rows[0].num_projects == 4


def test_old_format_blank_status_cell_is_derived_or_defaulted():
    """The Status column exists (first format): a blank cell is derived like
    an absent column; a blank cell with nothing to derive from stays the
    STATUS_DEFAULTED warning; no file-level STATUS_NOT_IN_FILE."""

    res = _parse(
        [
            row(name="Plan Alpha", hub="India", category="A", status=None),
            row(name="Spilled", hub="Greece", category="A", status=None, spillover="Yes"),
            row(name="Runner", hub="Greece", category="A", status=None, priority="Running"),
            row(name="Nothing", hub="Greece", category="A", status=None),
            row(name="Given", hub="Greece", category="A", status="Que", spillover="Yes",
                priority="Running"),
        ],
        _ctx(projects=_plan_projects()),
    )  # fmt: skip
    by = {r.name: r for r in res.rows}
    assert by["Plan Alpha"].status == "In Development"
    assert _codes(res, by["Plan Alpha"].key)["STATUS_FROM_PLAN"] == 1
    assert by["Spilled"].status == "In Development"
    assert _codes(res, by["Spilled"].key)["STATUS_FROM_SPILLOVER"] == 1
    assert by["Runner"].status == "In Development"
    assert by["Nothing"].status == "In Queue"
    (d,) = [i for i in res.issues if i.code == "STATUS_DEFAULTED"]
    assert d.row_key == by["Nothing"].key and d.severity == "warning"
    assert by["Given"].status == "In Queue"  # a status cell is never overridden
    assert by["Given"].priority_source == "running" and by["Given"].rank == 0
    assert "STATUS_NOT_IN_FILE" not in _codes(res)
    assert res.counts.derived_status == 3
