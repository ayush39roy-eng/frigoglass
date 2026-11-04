"""P32-T04: the pure capacity-planning workbook parser (ADR 0044 §4–§6, contract B2).

No database. Synthetic workbooks only (`tests.plan_import_helpers`).
"""

from __future__ import annotations

import io
from collections import Counter

import openpyxl
import pytest

import domain_constants as dc
from services.plan_import_xlsx import (
    MAX_DATA_ROWS,
    ImportFormatError,
    MatchableProject,
    ParseContext,
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
