"""Editable scoring rubric: dimensions, versions and per-dimension scores in tables (P26-T01)

Revision ID: p26a_scoring_rubric_tables
Revises: p24b_checkin_reset_escape
Create Date: 2026-10-22

ADR 0037. Moves the prioritization rubric out of code and the 13 fixed
`priority_scores` columns into three tables:

- `scoring_dimensions`: the 13 dimensions, with their keys (unchanged wire /
  DB keys), labels, pillars and weights as of ADR 0029, `inverted` set on
  CAPEX Investment, all active, `display_order` 1..13 in the old positional
  order.
- `rubric_versions`: version 1 = that rubric, with its JSON snapshot.
- `priority_dimension_scores`: every existing score, copied losslessly (13 rows
  per `priority_scores` row; the old columns were NOT NULL, so no score is
  null after the copy).

Then `priority_scores.rubric_version` is added (= 1), the cached
`weighted_score` / `normalized_pct` / `suggested_band` are recomputed from the
copied scores with the frozen ADR 0029 weights (identical to the stored values
whenever they were consistent; any row that was not is logged by count and
corrected), and the 13 old columns and their CHECK constraints are DROPPED
(not kept deprecated: nothing reads them any more, and keeping NOT NULL
columns that no writer fills would break every new score).

The weights are frozen into this revision on purpose (a migration must not
move when code changes later). Rounding is exact rational arithmetic, half up;
under the 295 total no score can land on .5, so this equals the old float
`round()` on every possible input.

Downgrade restores the 13 columns from `priority_dimension_scores` (by key) and
recomputes the cached fields with the frozen weights. It refuses (raises) when
any project lacks a score on one of the 13 (it would violate NOT NULL) — by
design, like `p21a`'s downgrade with a stored 0. Dimensions added after the
upgrade are dropped with the tables.

No raw SQL string interpolation of data: identifiers come from the frozen
tuple below; every value is a bound parameter.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Sequence
from fractions import Fraction

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "p26a_scoring_rubric_tables"
down_revision: str | Sequence[str] | None = "p24b_checkin_reset_escape"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_log = logging.getLogger("alembic.runtime.migration")

#: (key, label, pillar, weight, inverted), positional order, ADR 0029 / 0033.
_DIMENSIONS: tuple[tuple[str, str, str, int, bool], ...] = (
    ("strategic_project", "Strategic Project", "Strategic Alignment", 25, False),
    ("new_customer", "New Customer", "Strategic Alignment", 25, False),
    ("new_options", "New Options", "Strategic Alignment", 25, False),
    ("regulatory_compliance", "Regulatory Compliance", "Regulatory & Quality", 25, False),
    ("quality_improvements", "Quality Improvements", "Regulatory & Quality", 25, False),
    ("rm_savings", "RM Savings", "Financial Return", 25, False),
    ("total_rm_savings", "Total RM Savings", "Financial Return", 25, False),
    ("gross_margins", "Gross Profitability", "Financial Return", 25, False),
    ("profitability", "ROI", "Investment & Feasibility", 25, False),
    ("annual_volume", "Annual Volume", "Market & Volume", 15, False),
    ("three_year_volume", "3-Year Volume", "Market & Volume", 25, False),
    ("new_models", "New Models", "Market & Volume", 15, False),
    ("capex_investment", "CAPEX Investment (inverted)", "Investment & Feasibility", 15, True),
)
_TOTAL = sum(d[3] for d in _DIMENSIONS)  # 295


def _score(scores: Sequence[int]) -> tuple[Fraction, int, str]:
    raw = sum(
        (Fraction(s * d[3], 5) for s, d in zip(scores, _DIMENSIONS, strict=True)), Fraction(0)
    )
    scaled = raw * 100 / _TOTAL
    pct = int(scaled + Fraction(1, 2))  # half up; scaled >= 0
    band = "P1" if pct >= 70 else "P2" if pct >= 55 else "P3" if pct >= 40 else "P4"
    return raw, pct, band


def _cols() -> list[str]:
    return [d[0] for d in _DIMENSIONS]


def upgrade() -> None:
    op.create_table(
        "scoring_dimensions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("pillar", sa.String(length=60), nullable=False),
        sa.Column("weight", sa.Integer(), nullable=False),
        sa.Column("inverted", sa.Boolean(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("display_order", sa.Integer(), nullable=False),
        sa.Column("created_by_user_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "weight BETWEEN 1 AND 100", name=op.f("ck_scoring_dimensions_weight_range")
        ),
        sa.CheckConstraint(
            "display_order >= 1", name=op.f("ck_scoring_dimensions_display_order_positive")
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_scoring_dimensions_created_by_user_id_users"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_scoring_dimensions")),
        sa.UniqueConstraint("key", name=op.f("uq_scoring_dimensions_key")),
    )
    op.create_table(
        "rubric_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("changed_by_user_id", sa.Uuid(), nullable=True),
        sa.Column(
            "changed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("total_weight", sa.Integer(), nullable=False),
        sa.Column("dimensions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.CheckConstraint("version >= 1", name=op.f("ck_rubric_versions_version_positive")),
        sa.CheckConstraint(
            "total_weight >= 1", name=op.f("ck_rubric_versions_total_weight_positive")
        ),
        sa.ForeignKeyConstraint(
            ["changed_by_user_id"],
            ["users.id"],
            name=op.f("fk_rubric_versions_changed_by_user_id_users"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_rubric_versions")),
        sa.UniqueConstraint("version", name=op.f("uq_rubric_versions_version")),
    )
    op.create_table(
        "priority_dimension_scores",
        sa.Column("priority_score_id", sa.Uuid(), nullable=False),
        sa.Column("dimension_id", sa.Uuid(), nullable=False),
        sa.Column("score", sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "score BETWEEN 0 AND 5", name=op.f("ck_priority_dimension_scores_score_range")
        ),
        sa.ForeignKeyConstraint(
            ["priority_score_id"],
            ["priority_scores.id"],
            name=op.f("fk_priority_dimension_scores_priority_score_id_priority_scores"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["dimension_id"],
            ["scoring_dimensions.id"],
            name=op.f("fk_priority_dimension_scores_dimension_id_scoring_dimensions"),
        ),
        sa.PrimaryKeyConstraint(
            "priority_score_id", "dimension_id", name=op.f("pk_priority_dimension_scores")
        ),
    )
    op.create_index(
        op.f("ix_priority_dimension_scores_dimension_id"),
        "priority_dimension_scores",
        ["dimension_id"],
        unique=False,
    )
    op.add_column("priority_scores", sa.Column("rubric_version", sa.Integer(), nullable=True))

    bind = op.get_bind()

    # --- the 13 dimensions + version 1 ---------------------------------------
    insert_dim = sa.text(
        "INSERT INTO scoring_dimensions "
        "(id, key, label, pillar, weight, inverted, active, display_order) "
        "VALUES (:id, :key, :label, :pillar, :weight, :inverted, true, :ord)"
    )
    snapshot: list[dict[str, object]] = []
    dim_ids: dict[str, uuid.UUID] = {}
    for order, (key, label, pillar, weight, inverted) in enumerate(_DIMENSIONS, start=1):
        dim_id = uuid.uuid4()
        dim_ids[key] = dim_id
        bind.execute(
            insert_dim,
            {
                "id": dim_id,
                "key": key,
                "label": label,
                "pillar": pillar,
                "weight": weight,
                "inverted": inverted,
                "ord": order,
            },
        )
        snapshot.append(
            {
                "id": str(dim_id),
                "key": key,
                "label": label,
                "pillar": pillar,
                "weight": weight,
                "inverted": inverted,
                "active": True,
                "display_order": order,
            }
        )
    bind.execute(
        sa.text(
            "INSERT INTO rubric_versions (id, version, reason, total_weight, dimensions) "
            "VALUES (:id, 1, :reason, :total, CAST(:dims AS jsonb))"
        ),
        {
            "id": uuid.uuid4(),
            "reason": "Initial rubric: the 13 fixed dimensions of ADR 0029 / ADR 0033, "
            "migrated to tables (ADR 0037).",
            "total": _TOTAL,
            "dims": json.dumps(snapshot),
        },
    )

    # --- copy every score (13 per row) ----------------------------------------
    for key in _cols():
        bind.execute(
            sa.text(
                "INSERT INTO priority_dimension_scores (priority_score_id, dimension_id, score) "
                f"SELECT id, :dim_id, {key} FROM priority_scores"  # noqa: S608 - fixed identifier
            ),
            {"dim_id": dim_ids[key]},
        )

    # --- recompute the cached fields with the frozen weights ------------------
    cols = ", ".join(_cols())
    rows = bind.execute(
        sa.text(
            f"SELECT id, {cols}, weighted_score, normalized_pct, "  # noqa: S608
            "CAST(suggested_band AS text) FROM priority_scores"
        )
    ).all()
    update = sa.text(
        "UPDATE priority_scores SET weighted_score = :ws, normalized_pct = :pct, "
        "suggested_band = CAST(:band AS project_priority), rubric_version = 1 WHERE id = :id"
    )
    corrected = 0
    n = len(_DIMENSIONS)
    for row in rows:
        raw, pct, band = _score([row[i + 1] for i in range(n)])
        stored_ws, stored_pct, stored_band = row[n + 1], row[n + 2], row[n + 3]
        if (
            stored_ws is None
            or Fraction(str(stored_ws)) != raw
            or stored_pct != pct
            or stored_band != band
        ):
            corrected += 1
        bind.execute(update, {"ws": float(raw), "pct": pct, "band": band, "id": row[0]})
    _log.info(
        "p26a: copied %d priority_scores rows x %d dimensions; %d cached score(s) corrected",
        len(rows),
        n,
        corrected,
    )

    # --- the 13 old columns stop being a source of truth: drop them ----------
    for key in _cols():
        op.drop_constraint(
            op.f(f"ck_priority_scores_{key}_score_range"), "priority_scores", type_="check"
        )
        op.drop_column("priority_scores", key)


def downgrade() -> None:
    bind = op.get_bind()
    for key in _cols():
        op.add_column("priority_scores", sa.Column(key, sa.Integer(), nullable=True))
        bind.execute(
            sa.text(
                f"UPDATE priority_scores ps SET {key} = pds.score "  # noqa: S608
                "FROM priority_dimension_scores pds "
                "JOIN scoring_dimensions sd ON sd.id = pds.dimension_id "
                "WHERE pds.priority_score_id = ps.id AND sd.key = :key"
            ),
            {"key": key},
        )
    missing_where = " OR ".join(f"{key} IS NULL" for key in _cols())
    missing = bind.execute(
        sa.text(f"SELECT count(*) FROM priority_scores WHERE {missing_where}")  # noqa: S608
    ).scalar_one()
    if missing:
        raise RuntimeError(
            f"p26a downgrade: {missing} priority_scores row(s) lack a score on one of the 13 "
            "original dimensions; the old NOT NULL columns cannot hold them."
        )
    cols = ", ".join(_cols())
    rows = bind.execute(sa.text(f"SELECT id, {cols} FROM priority_scores")).all()  # noqa: S608
    update = sa.text(
        "UPDATE priority_scores SET weighted_score = :ws, normalized_pct = :pct, "
        "suggested_band = CAST(:band AS project_priority) WHERE id = :id"
    )
    for row in rows:
        raw, pct, band = _score(list(row[1:]))
        bind.execute(update, {"ws": float(raw), "pct": pct, "band": band, "id": row[0]})
    for key in _cols():
        op.alter_column("priority_scores", key, nullable=False)
        op.create_check_constraint(
            op.f(f"ck_priority_scores_{key}_score_range"),
            "priority_scores",
            sa.column(key).between(0, 5),
        )
    op.drop_column("priority_scores", "rubric_version")
    op.drop_index(
        op.f("ix_priority_dimension_scores_dimension_id"), table_name="priority_dimension_scores"
    )
    op.drop_table("priority_dimension_scores")
    op.drop_table("rubric_versions")
    op.drop_table("scoring_dimensions")
