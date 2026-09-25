"""Domain constants shared verbatim from ``docs/DOMAIN_RULES.md``.

This module is the single source of truth for magic numbers referenced by both the
data model (this package) and, later, `scheduling/` (algorithm-engineer's pure
functions) and the API/service layer (P3). It contains **data only** — no
scheduling logic, no DB access, no I/O — so it is safe for `scheduling/` to import
without violating its "pure function, no DB/network access" constraint (P2-T01).

Every value here must trace back to `docs/DOMAIN_RULES.md`. If DOMAIN_RULES.md
changes, update this module in the same change and record why in `docs/MEMORY.md`.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final

# --- Workflow template — 14 steps (docs/DOMAIN_RULES.md "Workflow template") ---

# (step_id, name, kind, base_weeks, sequence_order)
WORKFLOW_STEP_TEMPLATE_SEED: Final[tuple[tuple[str, str, str, int, int], ...]] = (
    ("PDD-A", "Marketing Brief", "design", 2, 1),
    ("PDD-B", "Concept Study", "design", 2, 2),
    ("PDD-C", "Feasibility & Costing", "design", 2, 3),
    ("PDD-D", "Final Tech Brief & Kick-off", "design", 1, 4),
    ("PDD-E", "Design Detailing", "design", 4, 5),
    ("PDD-F", "Proof of Concept", "lab", 3, 6),
    ("PDD-G", "Design Refinement", "design", 2, 7),
    ("PDD-H", "Certification", "lab", 4, 8),
    ("PDD-I", "Tooling & Sourcing", "design", 3, 9),
    ("PDD-J", "Pre-Pilot Validation", "lab", 2, 10),
    ("PDD-K", "TF-2", "design", 2, 11),
    ("PDD-L", "Pilot", "lab", 3, 12),
    ("PDD-M", "Buy-off", "design", 2, 13),
    ("PDD-N", "Commercialization", "design", 1, 14),
)

# --- Category multipliers ---

CATEGORY_MULTIPLIERS: Final[Mapping[str, float]] = {
    "A+": 1.0,
    "A": 0.8,
    "B": 0.5,
    "C": 0.25,
}


def duration_weeks(base_weeks: int, category: str) -> int:
    """``max(1, round(base_weeks * multiplier))`` per DOMAIN_RULES.md.

    Provided here as a convenience for seed scripts / admin tooling. The
    scheduler (`scheduling/`) must not import this module for its core loop if
    doing so would violate its "no dependency on backend/models" purity
    constraint — check with algorithm-engineer before relying on this from
    inside `scheduling/`.
    """
    multiplier = CATEGORY_MULTIPLIERS[category]
    return max(1, round(base_weeks * multiplier))


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

# --- Horizon constants ---

CURRENT_WEEK: Final[int] = 31
WITHIN_YEAR_WEEK: Final[int] = 52
HORIZON_WEEKS: Final[int] = 78

# --- Scheduling order (docs/DOMAIN_RULES.md "Scheduling order") ---

PRIORITY_ORDER: Final[tuple[str, ...]] = ("P1", "P2", "P3", "P4", "Q")

# Ordinal codes exactly as given in DOMAIN_RULES.md's status table. Only these
# four statuses participate in scheduling order; "Commercialized" and "On Hold"
# (and "Draft", a Project Registration hard-gate state not itself present in
# DOMAIN_RULES.md — see docs/MEMORY.md P1-T01 entry) are excluded from
# scheduling entirely.
SCHEDULABLE_STATUS_ORDER: Final[Mapping[str, int]] = {
    "In Buyoff": 0,
    "Under Industrialization": 1,
    "In Development": 2,
    "In Queue": 3,
}

CATEGORY_ORDER: Final[tuple[str, ...]] = ("A+", "A", "B", "C")

# --- Booking rules ---

LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK: Final[float] = 0.5

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
