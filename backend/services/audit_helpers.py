"""Shared helpers for building `models.audit.AuditLogEntry` before/after state
dicts, per CLAUDE.md's non-negotiable: "Financial columns ... use the
encrypted column type, always. Never log their values" and
`models.types.FINANCIAL_FIELD_NAMES`.

**Hard rule for every function in this module**: none of them ever call the
Python attribute getter for `customer_name` / `tcogs_eur` / `selling_price_eur`
/ `gross_margin_pct` on a `Project` ORM instance. Doing so would trigger
`EncryptedString`/`EncryptedNumeric.process_result_value` (`backend/models/
types.py`) and decrypt the value into a live Python object in this process,
however briefly. Instead, the literal string `"<redacted>"` is written
unconditionally for those four keys — never derived from the real value. This
is stronger than "redact after reading" and is the only way to guarantee these
values never appear in an audit row, a log line, or a stack trace originating
from this code path.
"""

from __future__ import annotations

import uuid
from typing import Any

from models.chamber import Chamber
from models.engineer import Engineer
from models.priority import DIMENSION_FIELD_NAMES, PriorityScore
from models.project import Project
from models.types import FINANCIAL_FIELD_NAMES

#: Sanity check: every name in FINANCIAL_FIELD_NAMES must be one this module
#: knows to redact. If a new encrypted field is ever added to `Project`
#: without updating `project_audit_state` below, this assertion catches the
#: drift at import time rather than silently leaking a value later.
_PROJECT_REDACTED_KEYS = frozenset(
    {"customer_name", "tcogs_eur", "selling_price_eur", "gross_margin_pct"}
)
assert FINANCIAL_FIELD_NAMES == _PROJECT_REDACTED_KEYS, (
    "models.types.FINANCIAL_FIELD_NAMES has drifted from "
    "services.audit_helpers._PROJECT_REDACTED_KEYS — update both together."
)


def _uuid_str(value: uuid.UUID | None) -> str | None:
    return str(value) if value is not None else None


def project_audit_state(project: Project) -> dict[str, Any]:
    """A redacted snapshot of a `Project` row, safe to store as
    `AuditLogEntry.before_state`/`after_state`. See module docstring: the four
    financial/PII fields are never read, only ever written as the literal
    string `"<redacted>"`.
    """

    return {
        "id": str(project.id),
        "name": project.name,
        "external_code": project.external_code,
        "hub_id": _uuid_str(project.hub_id),
        "leader_engineer_id": _uuid_str(project.leader_engineer_id),
        "category": project.category.value if project.category else None,
        "type": project.type.value if project.type else None,
        "status": project.status.value if project.status else None,
        "priority": project.priority.value if project.priority else None,
        "frozen": project.frozen,
        "actual_start_week": project.actual_start_week,
        "delay_weeks": project.delay_weeks,
        "reg_year": project.reg_year,
        "carry_over": project.carry_over,
        "capex_keur": float(project.capex_keur) if project.capex_keur is not None else None,
        "rm_savings_keur": (
            float(project.rm_savings_keur) if project.rm_savings_keur is not None else None
        ),
        # --- Financial/PII fields: NEVER read, always the literal string below. ---
        "customer_name": "<redacted>",
        "tcogs_eur": "<redacted>",
        "selling_price_eur": "<redacted>",
        "gross_margin_pct": "<redacted>",
    }


def engineer_audit_state(engineer: Engineer) -> dict[str, Any]:
    return {
        "id": str(engineer.id),
        "name": engineer.name,
        "hub_id": _uuid_str(engineer.hub_id),
        "fte": float(engineer.fte) if engineer.fte is not None else None,
        "allowed_categories": [c.value for c in (engineer.allowed_categories or [])],
        "user_id": _uuid_str(engineer.user_id),
    }


def chamber_audit_state(chamber: Chamber) -> dict[str, Any]:
    return {
        "id": str(chamber.id),
        "code": chamber.code,
        "lab_region": chamber.lab_region.value if chamber.lab_region else None,
        "max_concurrent": chamber.max_concurrent,
        "platforms": chamber.platforms,
        "efficiency": float(chamber.efficiency) if chamber.efficiency is not None else None,
        "weeks_per_chamber": (
            float(chamber.weeks_per_chamber) if chamber.weeks_per_chamber is not None else None
        ),
        "allowed_stages": list(chamber.allowed_stages or []),
    }


def priority_score_audit_state(score: PriorityScore) -> dict[str, Any]:
    return {
        "id": str(score.id),
        "project_id": _uuid_str(score.project_id),
        **{name: getattr(score, name) for name in DIMENSION_FIELD_NAMES},
        "hard_gates": [g.value for g in (score.hard_gates or [])],
        "weighted_score": float(score.weighted_score) if score.weighted_score is not None else None,
        "normalized_pct": score.normalized_pct,
        "suggested_band": score.suggested_band.value if score.suggested_band else None,
    }
