"""Project Registration's "leave Draft" hard-gate check.

Per `docs/PROJECT_AND_STACK.md` §2 (Project Registration): "Create/edit
projects: assign leader, category (A+/A/B/C), type, hub, actual start date,
financial fields (TCOGS, gross margin, selling price ...). Hard gates enforce
required fields before a project can leave draft status."

`docs/DOMAIN_RULES.md` does not itself enumerate this field list (it is
silent on Project Registration specifically) — the six fields checked below
are read directly from that PROJECT_AND_STACK.md §2 sentence. **Flagged
interpretation**: `hub` is checked implicitly (it is a DB `NOT NULL` column on
`Project`, required even to create a Draft row, so it can never be the reason
a project fails this gate) and `customer_name` is deliberately NOT included
here — PROJECT_AND_STACK.md's sentence names TCOGS/gross margin/selling price
explicitly as "financial fields" but does not name customer name among them,
even though `customer_name` is encrypted the same way. If the client intends
customer name to also be a hard gate, that is a scope clarification for
`docs/OPEN_QUESTIONS.md`, not assumed silently here.
"""

from __future__ import annotations

from models.project import Project

#: (field_name, human-readable label) pairs checked before a project may leave
#: `ProjectStatus.DRAFT`. Order matches the PROJECT_AND_STACK.md §2 sentence.
HARD_GATE_FIELDS: tuple[tuple[str, str], ...] = (
    ("leader_engineer_id", "leader"),
    ("category", "category"),
    ("type", "type"),
    ("actual_start_week", "actual start date"),
    ("tcogs_eur", "TCOGS"),
    ("selling_price_eur", "selling price"),
    ("gross_margin_pct", "gross margin"),
)


def missing_hard_gate_fields(project: Project) -> list[str]:
    """Human-readable labels of every required field still missing.

    Empty list => the project may leave Draft. Deliberately reads
    `tcogs_eur`/`selling_price_eur`/`gross_margin_pct` (financial/encrypted
    fields) only for an `is None` presence check, never logging or otherwise
    surfacing the decrypted value — the caller (the router) must not put the
    return value of this function, nor these three attributes, into an audit
    row or log line.
    """

    missing: list[str] = []
    for field_name, label in HARD_GATE_FIELDS:
        if getattr(project, field_name) is None:
            missing.append(label)
    return missing
