"""Domain constants shared verbatim from ``docs/DOMAIN_RULES.md``.

This module is the single source of truth for magic numbers referenced by both the
data model (this package) and `scheduling/` (algorithm-engineer's pure functions)
and the API/service layer. It contains **data only** — no scheduling logic, no DB
access, no I/O — so it is safe for `scheduling/` to import without violating its
"pure function, no DB/network access" constraint (P2-T01).

Every value here must trace back to `docs/DOMAIN_RULES.md`. If DOMAIN_RULES.md
changes, update this module in the same change and record why in `docs/MEMORY.md`.

**Revised 2026-09-27 (P9-T01, ADR 0007/0009):** the prototype-era
`CATEGORY_MULTIPLIERS` / `duration_weeks()` are gone — durations come from the
per-(workflow, category, step) lead-time table (`LEAD_TIME_SEED`, seeded into the
`workflow_lead_times` table and editable on Workflow Settings). The template seed
now carries both workflows (PDD and OEM), the client's step codes/names, the
three-way `kind` (design | lab | elapsed) and the seeded strict-chain
`predecessor_ids`.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final

# --- Workflows (docs/DOMAIN_RULES.md "Workflow templates — two workflows") ---

#: (workflow_id, name)
WORKFLOW_SEED: Final[tuple[tuple[str, str], ...]] = (
    ("PDD", "Product Development & Design (non-OEM hubs)"),
    ("OEM", "OEM workflow (OEM-HCK, OEM-Seltek)"),
)

# (workflow_id, step_id, code, name, kind, sequence_order, predecessor_ids)
#
# `predecessor_ids` is the seeded strict chain (ADR 0009): `[]` for the first
# step of each workflow, `[previous step]` for every other. Super Admin may edit
# it on Workflow Settings; this tuple is only the seed.
WORKFLOW_STEP_TEMPLATE_SEED: Final[
    tuple[tuple[str, str, str, str, str, int, tuple[str, ...]], ...]
] = (
    # --- PDD workflow — every non-OEM hub -----------------------------------
    ("PDD", "PDD-A", "MKTG_BRF", "Marketing Brief", "design", 1, ()),
    ("PDD", "PDD-B", "FEAS_STD", "Feasibility Study (Conceptual Design)", "design", 2, ("PDD-A",)),
    ("PDD", "PDD-C", "BUS_CASE", "Business Case Approval", "elapsed", 3, ("PDD-B",)),
    (
        "PDD",
        "PDD-D",
        "TECH_BRIEF",
        "Final Technical Brief & Project Kick-off",
        "design",
        4,
        ("PDD-C",),
    ),
    ("PDD", "PDD-E", "DESIGN", "Design Detailing", "design", 5, ("PDD-D",)),
    ("PDD", "PDD-F", "POC", "Proof of Concept", "lab", 6, ("PDD-E",)),
    ("PDD", "PDD-G", "CAPEX", "Online CAPEX Approval", "elapsed", 7, ("PDD-F",)),
    ("PDD", "PDD-H", "CERT", "Certification Testing & Compliance", "lab", 8, ("PDD-G",)),
    ("PDD", "PDD-I", "TF_1", "TF-1", "design", 9, ("PDD-H",)),
    ("PDD", "PDD-J", "PROD_PR", "Pre-Production (Pr. Pr)", "design", 10, ("PDD-I",)),
    ("PDD", "PDD-K", "TF_2", "TF-2", "design", 11, ("PDD-J",)),
    ("PDD", "PDD-L", "PILOT", "Pilot", "elapsed", 12, ("PDD-K",)),
    ("PDD", "PDD-M", "TF_3", "TF-3", "design", 13, ("PDD-L",)),
    ("PDD", "PDD-N", "COMM", "Commercialization", "elapsed", 14, ("PDD-M",)),
    # --- OEM workflow — hubs OEM-HCK, OEM-Seltek -----------------------------
    ("OEM", "OEM-A", "COMM_BRF", "Commercial Brief", "design", 1, ()),
    (
        "OEM",
        "OEM-B",
        "TECH_BRIEF",
        "Final Technical Brief & Project Kick-off",
        "design",
        2,
        ("OEM-A",),
    ),
    ("OEM", "OEM-C", "BUS_CASE", "Business Case Approval", "elapsed", 3, ("OEM-B",)),
    ("OEM", "OEM-D", "DESIGN", "Design Detailing", "design", 4, ("OEM-C",)),
    ("OEM", "OEM-E", "POC", "Proof of Concept", "lab", 5, ("OEM-D",)),
    ("OEM", "OEM-F", "CAPEX", "Online CAPEX Approval", "elapsed", 6, ("OEM-E",)),
    ("OEM", "OEM-G", "TST_ANAL", "Test Results Analysis", "design", 7, ("OEM-F",)),
    ("OEM", "OEM-H", "CERT", "Certification Testing & Compliance", "lab", 8, ("OEM-G",)),
    ("OEM", "OEM-I", "TF_1", "TF-1", "design", 9, ("OEM-H",)),
    ("OEM", "OEM-J", "PROD_PR", "Pre-Production (Pr. Pr)", "design", 10, ("OEM-I",)),
    ("OEM", "OEM-K", "TF_2", "TF-2", "design", 11, ("OEM-J",)),
    ("OEM", "OEM-L", "PILOT", "Pilot", "elapsed", 12, ("OEM-K",)),
    ("OEM", "OEM-M", "TF_3", "TF-3", "design", 13, ("OEM-L",)),
    ("OEM", "OEM-N", "COMM", "Commercialization", "elapsed", 14, ("OEM-M",)),
)

STEPS_PER_WORKFLOW: Final[int] = 14

# --- Lead times (docs/DOMAIN_RULES.md "Lead times", ADR 0007) ---------------
#
# Transcribed verbatim from the DOMAIN_RULES.md table (itself from the client
# workbook's `Final RPD` sheet, docs/CLIENT_FORMULAS.md §1). Row order is the
# table's row order; column order is step A..N. A `0` means the step is skipped
# for that category (no calendar time, no capacity — never floored to 1).
_LEAD_TIME_ROWS: Final[tuple[tuple[str, str, tuple[int, ...]], ...]] = (
    ("PDD", "A+", (1, 8, 4, 1, 6, 6, 2, 6, 2, 1, 2, 3, 1, 1)),
    ("PDD", "A", (1, 4, 4, 1, 6, 4, 2, 6, 2, 1, 2, 3, 1, 1)),
    ("PDD", "B", (1, 0, 0, 1, 4, 0, 0, 6, 0, 1, 2, 1, 1, 1)),
    ("PDD", "C", (1, 0, 0, 1, 2, 0, 0, 1, 0, 1, 1, 0, 0, 1)),
    ("OEM", "A-OEM", (1, 1, 1, 2, 2, 2, 4, 6, 0, 1, 0, 0, 0, 1)),
    ("OEM", "B-OEM", (1, 1, 1, 0, 0, 2, 2, 6, 0, 1, 0, 0, 0, 0)),
    ("OEM", "C-OEM", (0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0)),
)

_STEP_LETTERS: Final[str] = "ABCDEFGHIJKLMN"

#: (workflow_id, category, step_id, weeks) — 7 rows × 14 steps = 98 tuples.
LEAD_TIME_SEED: Final[tuple[tuple[str, str, str, int], ...]] = tuple(
    (workflow_id, category, f"{workflow_id}-{letter}", weeks)
    for workflow_id, category, row in _LEAD_TIME_ROWS
    for letter, weeks in zip(_STEP_LETTERS, row, strict=True)
)

#: The Σ column of the DOMAIN_RULES.md lead-time table, kept here so a seed /
#: settings-load can self-check against the contract.
LEAD_TIME_ROW_TOTALS: Final[Mapping[tuple[str, str], int]] = {
    ("PDD", "A+"): 44,
    ("PDD", "A"): 38,
    ("PDD", "B"): 18,
    ("PDD", "C"): 8,
    ("OEM", "A-OEM"): 21,
    ("OEM", "B-OEM"): 14,
    ("OEM", "C-OEM"): 4,
}

assert len(LEAD_TIME_SEED) == 98, "LEAD_TIME_SEED must be 7 categories × 14 steps"
for _wf, _cat, _row in _LEAD_TIME_ROWS:
    assert sum(_row) == LEAD_TIME_ROW_TOTALS[(_wf, _cat)], (
        f"lead-time row {_wf}/{_cat} does not sum to the DOMAIN_RULES.md Σ column"
    )

# --- Hubs and lab-region mapping ---

HUB_LAB_REGION: Final[Mapping[str, str]] = {
    "R&D-Greece": "Greece",
    "R&D-India": "India",
    "PD-India": "India",
    "PD-Romania": "Romania",
    "OEM-HCK": "India",
    "OEM-Seltek": "India",
}

OEM_HUBS: Final[frozenset[str]] = frozenset({"OEM-HCK", "OEM-Seltek"})

#: Which workflow a hub's projects follow (docs/DOMAIN_RULES.md: "A project's
#: workflow is a function of its hub (`Hub.is_oem`)").
WORKFLOW_ID_FOR_OEM_HUB: Final[str] = "OEM"
WORKFLOW_ID_FOR_NON_OEM_HUB: Final[str] = "PDD"

# --- Categories ---

#: Categories an OEM-hub project must carry; non-OEM hubs use A+/A/B/C.
OEM_CATEGORIES: Final[frozenset[str]] = frozenset({"A-OEM", "B-OEM", "C-OEM"})
NON_OEM_CATEGORIES: Final[frozenset[str]] = frozenset({"A+", "A", "B", "C"})

# --- Horizon constants ---

CURRENT_WEEK: Final[int] = 31
WITHIN_YEAR_WEEK: Final[int] = 52
HORIZON_WEEKS: Final[int] = 78

# --- Scheduling order (docs/DOMAIN_RULES.md "Scheduling order") ---

PRIORITY_ORDER: Final[tuple[str, ...]] = ("P1", "P2", "P3", "P4", "Q")

# Ordinal codes exactly as given in DOMAIN_RULES.md's status table. Only these
# four statuses participate in scheduling order; "Commercialized", "On Hold",
# "Cancelled" (2026-09-27) and "Draft" (a Project Registration hard-gate state
# not itself present in DOMAIN_RULES.md — see docs/MEMORY.md P1-T01 entry) are
# excluded from scheduling entirely.
SCHEDULABLE_STATUS_ORDER: Final[Mapping[str, int]] = {
    "In Buyoff": 0,
    "Under Industrialization": 1,
    "In Development": 2,
    "In Queue": 3,
}

CATEGORY_ORDER: Final[tuple[str, ...]] = ("A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM")

# --- Booking rules ---

#: ADR 0007: one platform-week per project-week (the prototype's 0.5 is retired).
LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK: Final[float] = 1.0

# --- Capacity supply (docs/DOMAIN_RULES.md "Capacity supply", ADR 0008) ---

#: (hub_name, weekdays_per_week, national_holiday_days, medical_leave_days,
#:  casual_leave_days, annual_leave_days) — docs/CLIENT_FORMULAS.md §2.1. The
#: two OEM hubs are not in the workbook; they are seeded with India's calendar
#: (they share the India lab region and are administered from India) — see
#: docs/MEMORY.md P9-T01.
HUB_WORK_CALENDAR_SEED: Final[tuple[tuple[str, int, int, int, int, int], ...]] = (
    ("R&D-Greece", 5, 12, 0, 0, 25),
    ("R&D-India", 6, 13, 7, 7, 20),
    ("PD-India", 6, 13, 7, 7, 20),
    ("PD-Romania", 5, 13, 7, 0, 20),
    ("OEM-HCK", 6, 13, 7, 7, 20),
    ("OEM-Seltek", 6, 13, 7, 7, 20),
)

WEEKS_IN_YEAR: Final[int] = 52

# --- Prioritization scoring — 13 dimensions ---
# (pillar, dimension_name, snake_case_field, weight)
PRIORITIZATION_DIMENSIONS: Final[tuple[tuple[str, str, str, int], ...]] = (
    ("Strategic Alignment", "Strategic Project", "strategic_project", 25),
    ("Strategic Alignment", "New Customer", "new_customer", 25),
    ("Strategic Alignment", "New Options", "new_options", 25),
    ("Regulatory & Quality", "Regulatory Compliance", "regulatory_compliance", 25),
    ("Regulatory & Quality", "Quality Improvements", "quality_improvements", 25),
    ("Financial Return", "RM Savings", "rm_savings", 25),
    ("Financial Return", "Total RM Savings", "total_rm_savings", 25),
    ("Financial Return", "Gross Margins", "gross_margins", 25),
    ("Financial Return", "Profitability", "profitability", 25),
    ("Market & Volume", "Annual Volume", "annual_volume", 15),
    ("Market & Volume", "3-Year Volume", "three_year_volume", 15),
    ("Market & Volume", "New Models", "new_models", 15),
    ("Investment & Feasibility", "CAPEX Investment (inverted)", "capex_investment", 10),
)

TOTAL_WEIGHT: Final[int] = sum(w for *_rest, w in PRIORITIZATION_DIMENSIONS)
assert TOTAL_WEIGHT == 280, "PRIORITIZATION_DIMENSIONS weights must sum to 280 per DOMAIN_RULES.md"

DIMENSION_SCORE_MIN: Final[int] = 1
DIMENSION_SCORE_MAX: Final[int] = 5

# Band thresholds on normalised_pct = round(weighted_score / (280 * 5) * 100)
PRIORITY_BAND_THRESHOLDS: Final[tuple[tuple[int, str], ...]] = (
    (70, "P1"),
    (55, "P2"),
    (40, "P3"),
    (0, "P4"),
)

HARD_GATE_REASONS: Final[tuple[str, ...]] = (
    "Regulatory deadline within 6 months",
    "Customer certification at risk (Coke/Pepsi)",
    "Active safety non-compliance",
)

# --- Currency ---
# Rates are configurable at runtime (CurrencyRate table, backend/models/currency.py)
# per DOMAIN_RULES.md — these are only the documented v1 seed values, not hardcoded
# runtime constants.
CURRENCY_RATE_SEED: Final[Mapping[str, float]] = {
    "EUR": 1.0,
    "USD": 1.08,
    "INR": 97.0,
}

# --- Outcome flags (docs/DOMAIN_RULES.md booking rules / invariants) ---
SCHEDULE_OUTCOME_FLAGS: Final[tuple[str, ...]] = (
    "ENG_CONFLICT",
    "OVERLAP",
    "LEFT_OUT",
    "CAT_NOT_ALLOWED",
    "SPILLOVER",
)

# --- Chamber seed (docs/CLIENT_FORMULAS.md §2.2, ADR 0008) --------------------
#
# (code, lab_region, platforms, efficiency, maintenance_weeks, breakdown_weeks,
#  calibration_weeks, allowed_stages). `max_concurrent` is seeded equal to
# `platforms` (ADR 0007). Codes keep the prototype-era `<REGION>-CH<n>` form
# and are mapped onto the workbook's per-region CH-1..CH-n rows (the mapping
# is recorded in docs/MEMORY.md P9-T01). `allowed_stages` carries only lab-kind
# step IDs (PDD-F/PDD-H; plus OEM-E/OEM-H for the India region, which serves the
# two OEM hubs). India CH-4 is "only for industrialization / reliability —
# non-calibrated" in the workbook, so it books no POC/CERT step but still
# contributes its efficient lab weeks to supply, exactly as the workbook does.
CHAMBER_SEED: Final[
    tuple[tuple[str, str, int, float, float, float, float, tuple[str, ...]], ...]
] = (
    ("IN-CH1", "India", 1, 0.7, 2, 1, 1, ("PDD-F", "PDD-H", "OEM-E", "OEM-H")),
    ("IN-CH2", "India", 4, 0.6, 2, 11, 1, ("PDD-F", "OEM-E")),
    ("IN-CH3", "India", 2, 0.6, 2, 7, 1, ("PDD-F", "PDD-H", "OEM-E", "OEM-H")),
    ("IN-CH4", "India", 1, 0.5, 2, 2, 1, ()),
    ("GR-CH1", "Greece", 1, 0.7, 2, 8, 1, ("PDD-F", "PDD-H")),
    ("GR-CH2", "Greece", 2, 0.6, 2, 8, 1, ("PDD-F",)),
    ("RO-CH1", "Romania", 1, 0.7, 2, 3, 1, ("PDD-F", "PDD-H")),
    ("RO-CH2", "Romania", 4, 0.6, 2, 3, 1, ("PDD-F",)),
    ("RO-CH3", "Romania", 2, 0.6, 2, 3, 1, ("PDD-F", "PDD-H")),
    ("RO-CH4", "Romania", 1, 0.7, 2, 4, 1, ("PDD-F", "PDD-H")),
)
