"""Recompute stored priority scores under the ADR 0029 weights (P16-T01).

Data-only revision (no schema change). ADR 0029 changed the 3-Year Volume
weight to 25 and CAPEX Investment to 15 and the scoring to
`points = score / 5 * weight`, `normalized_pct = round(sum / TOTAL_WEIGHT * 100)`
(TOTAL_WEIGHT 295). This rewrites `weighted_score`, `normalized_pct` and
`suggested_band` on every `priority_scores` row. It does NOT set `schedule_stale`
(the scheduler never reads `weighted_score`; P16-R01) and never recalculates a
schedule or writes `projects.priority`.

The weights are frozen into this revision on purpose (a migration must not move
when `domain_constants` changes later). Idempotent: re-running yields the same
values. No audit rows, like the earlier data migrations. Downgrade is a no-op
(the old values are not recoverable without the old weights; re-run the seed).

Revision ID: p16a_rescore_adr0029
Revises: p14b_vip_areas
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p16a_rescore_adr0029"
down_revision: str | Sequence[str] | None = "p14b_vip_areas"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: (column, weight) in positional order, ADR 0029.
_WEIGHTS: tuple[tuple[str, int], ...] = (
    ("strategic_project", 25),
    ("new_customer", 25),
    ("new_options", 25),
    ("regulatory_compliance", 25),
    ("quality_improvements", 25),
    ("rm_savings", 25),
    ("total_rm_savings", 25),
    ("gross_margins", 25),
    ("profitability", 25),
    ("annual_volume", 15),
    ("three_year_volume", 25),
    ("new_models", 15),
    ("capex_investment", 15),
)
_TOTAL = sum(w for _c, w in _WEIGHTS)


def _band(pct: int) -> str:
    return "P1" if pct >= 70 else "P2" if pct >= 55 else "P3" if pct >= 40 else "P4"


def upgrade() -> None:
    bind = op.get_bind()
    cols = ", ".join(c for c, _w in _WEIGHTS)
    rows = bind.execute(sa.text(f"SELECT id, {cols} FROM priority_scores")).all()  # noqa: S608
    update = sa.text(
        "UPDATE priority_scores SET weighted_score = :ws, normalized_pct = :pct, "
        "suggested_band = CAST(:band AS project_priority) WHERE id = :id"
    )
    for row in rows:
        raw = sum(row[i + 1] * w / 5 for i, (_c, w) in enumerate(_WEIGHTS))
        pct = round(raw / _TOTAL * 100)
        bind.execute(update, {"ws": raw, "pct": pct, "band": _band(pct), "id": row[0]})


def downgrade() -> None:
    """Data-only; nothing to undo (see module docstring)."""
