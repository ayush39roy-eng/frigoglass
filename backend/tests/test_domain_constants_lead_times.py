"""P9-T01 — `domain_constants`' workflow/lead-time seeds are a faithful,
self-consistent transcription of docs/DOMAIN_RULES.md "Workflow templates"
and "Lead times" (2026-09-27, ADR 0007/0009). Pure, DB-free.

Replaces `test_domain_constants_duration_weeks.py` (the multiplier formula it
tested is retired — DOMAIN_RULES.md: "must not be reintroduced").
"""

from __future__ import annotations

import pytest

import domain_constants as dc

# Literal copy of the DOMAIN_RULES.md "Lead times" table, row for row, so a
# reviewer diffs this against the doc — NOT derived from `domain_constants`.
DOMAIN_RULES_LEAD_TIMES = {
    ("PDD", "A+"): (1, 8, 4, 1, 6, 6, 2, 6, 2, 1, 2, 3, 1, 1),
    ("PDD", "A"): (1, 4, 4, 1, 6, 4, 2, 6, 2, 1, 2, 3, 1, 1),
    ("PDD", "B"): (1, 0, 0, 1, 4, 0, 0, 6, 0, 1, 2, 1, 1, 1),
    ("PDD", "C"): (1, 0, 0, 1, 2, 0, 0, 1, 0, 1, 1, 0, 0, 1),
    ("OEM", "A-OEM"): (1, 1, 1, 2, 2, 2, 4, 6, 0, 1, 0, 0, 0, 1),
    ("OEM", "B-OEM"): (1, 1, 1, 0, 0, 2, 2, 6, 0, 1, 0, 0, 0, 0),
    ("OEM", "C-OEM"): (0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0),
}
DOMAIN_RULES_ROW_SUMS = {
    ("PDD", "A+"): 44, ("PDD", "A"): 38, ("PDD", "B"): 18, ("PDD", "C"): 8,
    ("OEM", "A-OEM"): 21, ("OEM", "B-OEM"): 14, ("OEM", "C-OEM"): 4,
}  # fmt: skip

# Literal copy of the two DOMAIN_RULES.md workflow tables (ID, code, kind).
DOMAIN_RULES_PDD = (
    ("PDD-A", "MKTG_BRF", "design"), ("PDD-B", "FEAS_STD", "design"),
    ("PDD-C", "BUS_CASE", "elapsed"), ("PDD-D", "TECH_BRIEF", "design"),
    ("PDD-E", "DESIGN", "design"), ("PDD-F", "POC", "lab"),
    ("PDD-G", "CAPEX", "elapsed"), ("PDD-H", "CERT", "lab"),
    ("PDD-I", "TF_1", "design"), ("PDD-J", "PROD_PR", "design"),
    ("PDD-K", "TF_2", "design"), ("PDD-L", "PILOT", "elapsed"),
    ("PDD-M", "TF_3", "design"), ("PDD-N", "COMM", "elapsed"),
)  # fmt: skip
DOMAIN_RULES_OEM = (
    ("OEM-A", "COMM_BRF", "design"), ("OEM-B", "TECH_BRIEF", "design"),
    ("OEM-C", "BUS_CASE", "elapsed"), ("OEM-D", "DESIGN", "design"),
    ("OEM-E", "POC", "lab"), ("OEM-F", "CAPEX", "elapsed"),
    ("OEM-G", "TST_ANAL", "design"), ("OEM-H", "CERT", "lab"),
    ("OEM-I", "TF_1", "design"), ("OEM-J", "PROD_PR", "design"),
    ("OEM-K", "TF_2", "design"), ("OEM-L", "PILOT", "elapsed"),
    ("OEM-M", "TF_3", "design"), ("OEM-N", "COMM", "elapsed"),
)  # fmt: skip


def test_lead_time_seed_matches_domain_rules_table_verbatim() -> None:
    assert len(dc.LEAD_TIME_SEED) == 98
    seed = {(wf, cat, step): weeks for wf, cat, step, weeks in dc.LEAD_TIME_SEED}
    expected = {
        (wf, cat, f"{wf}-{letter}"): weeks
        for (wf, cat), row in DOMAIN_RULES_LEAD_TIMES.items()
        for letter, weeks in zip("ABCDEFGHIJKLMN", row, strict=True)
    }
    assert seed == expected


def test_lead_time_row_sums_match_domain_rules_sigma_column() -> None:
    for key, row in DOMAIN_RULES_LEAD_TIMES.items():
        assert sum(row) == DOMAIN_RULES_ROW_SUMS[key] == dc.LEAD_TIME_ROW_TOTALS[key]


def test_no_lead_time_is_negative_and_zero_is_allowed() -> None:
    assert all(weeks >= 0 for *_k, weeks in dc.LEAD_TIME_SEED)
    assert any(weeks == 0 for *_k, weeks in dc.LEAD_TIME_SEED)  # skipped steps exist


def test_template_seed_matches_domain_rules_workflow_tables() -> None:
    assert len(dc.WORKFLOW_STEP_TEMPLATE_SEED) == 28
    by_wf: dict[str, list[tuple[str, str, str, int]]] = {"PDD": [], "OEM": []}
    for wf, step_id, code, _name, kind, seq, _preds in dc.WORKFLOW_STEP_TEMPLATE_SEED:
        by_wf[wf].append((step_id, code, kind, seq))
    assert [t[:3] for t in by_wf["PDD"]] == list(DOMAIN_RULES_PDD)
    assert [t[:3] for t in by_wf["OEM"]] == list(DOMAIN_RULES_OEM)
    for rows in by_wf.values():
        assert [t[3] for t in rows] == list(range(1, 15))


def test_seeded_precedence_is_the_strict_chain_per_workflow() -> None:
    """ADR 0009 default: `[]` for X-A, `[X-A]` for X-B, ... within a workflow."""
    prev: dict[str, str | None] = {"PDD": None, "OEM": None}
    for wf, step_id, _code, _name, _kind, _seq, preds in dc.WORKFLOW_STEP_TEMPLATE_SEED:
        expected = () if prev[wf] is None else (prev[wf],)
        assert preds == expected, step_id
        assert all(p.startswith(f"{wf}-") for p in preds)
        prev[wf] = step_id


def test_pdd_kinds_match_the_workbook_design_and_lab_formulas() -> None:
    """ADR 0007: design = A,B,D,E,I,J,K,M; lab = F,H; elapsed = C,G,L,N."""
    kinds = {s: k for wf, s, _c, _n, k, _q, _p in dc.WORKFLOW_STEP_TEMPLATE_SEED if wf == "PDD"}
    assert {s for s, k in kinds.items() if k == "design"} == {f"PDD-{x}" for x in "ABDEIJKM"}
    assert {s for s, k in kinds.items() if k == "lab"} == {"PDD-F", "PDD-H"}
    assert {s for s, k in kinds.items() if k == "elapsed"} == {f"PDD-{x}" for x in "CGLN"}


def test_multipliers_are_retired() -> None:
    assert not hasattr(dc, "CATEGORY_MULTIPLIERS")
    assert not hasattr(dc, "duration_weeks")


def test_category_order_and_oem_categories() -> None:
    assert dc.CATEGORY_ORDER == ("A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM")
    assert dc.OEM_CATEGORIES == frozenset({"A-OEM", "B-OEM", "C-OEM"})
    assert dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK == 1.0


@pytest.mark.parametrize(
    ("hub", "weekdays", "deductions"),
    [
        ("R&D-India", 6, (13, 7, 7, 20)),
        ("PD-India", 6, (13, 7, 7, 20)),
        ("R&D-Greece", 5, (12, 0, 0, 25)),
        ("PD-Romania", 5, (13, 7, 0, 20)),
        ("OEM-HCK", 6, (13, 7, 7, 20)),
        ("OEM-Seltek", 6, (13, 7, 7, 20)),
    ],
)
def test_hub_work_calendar_seed_matches_client_formulas_2_1(
    hub: str, weekdays: int, deductions: tuple[int, ...]
) -> None:
    row = next(r for r in dc.HUB_WORK_CALENDAR_SEED if r[0] == hub)
    assert row[1] == weekdays and row[2:] == deductions


def test_hub_work_calendar_seed_reproduces_workbook_working_weeks() -> None:
    """docs/CLIENT_FORMULAS.md §2.1 under ADR 0008's normalisation (every
    deduction divided by the hub's own weekdays): India 43.93, Greece 44.60,
    Romania 44.00 — India's medical-leave row in the workbook divides by 5,
    which ADR 0008 deliberately normalises to 6 (OPEN_QUESTIONS #16), so the
    India figure here is 52 - 47/6 = 44.17, not the sheet's 43.93.
    """
    calc = {r[0]: round(52 - sum(r[2:]) / r[1], 2) for r in dc.HUB_WORK_CALENDAR_SEED}
    assert calc["R&D-Greece"] == 44.6
    assert calc["PD-Romania"] == 44.0
    assert calc["PD-India"] == calc["R&D-India"] == 44.17


def test_chamber_seed_matches_client_formulas_2_2() -> None:
    by_code = {r[0]: r for r in dc.CHAMBER_SEED}
    assert len(by_code) == 10
    # (platforms, efficiency, breakdown) per workbook row.
    expected = {
        "IN-CH1": (1, 0.7, 1), "IN-CH2": (4, 0.6, 11), "IN-CH3": (2, 0.6, 7), "IN-CH4": (1, 0.5, 2),
        "GR-CH1": (1, 0.7, 8), "GR-CH2": (2, 0.6, 8),
        "RO-CH1": (1, 0.7, 3), "RO-CH2": (4, 0.6, 3), "RO-CH3": (2, 0.6, 3), "RO-CH4": (1, 0.7, 4),
    }  # fmt: skip
    for code, (plat, eff, brk) in expected.items():
        _c, _region, platforms, efficiency, maint, breakdown, calib, stages = by_code[code]
        assert (platforms, efficiency, breakdown) == (plat, eff, brk), code
        assert (maint, calib) == (2, 1), code
        assert all(s.endswith(("-F", "-H", "-E")) for s in stages), code  # lab-kind only
    # Workbook per-region efficient lab weeks with holidays = 13/5 = 2.6:
    # India 186.22 | Greece 72.96 | Romania 216.30.
    totals: dict[str, float] = {}
    for _c, region, n_plat, efficiency, maint_w, brk_w, calib_w, _s in dc.CHAMBER_SEED:
        working = 52 - 2.6 - maint_w - brk_w - calib_w
        totals[region] = totals.get(region, 0.0) + working * efficiency * n_plat
    assert round(totals["India"], 2) == 186.22
    assert round(totals["Greece"], 2) == 72.96
    assert round(totals["Romania"], 2) == 216.30
