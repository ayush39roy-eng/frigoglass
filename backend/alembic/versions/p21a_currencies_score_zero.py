"""P21-T01: EGP / ZAR / IDR currencies (no rate), and dimension score 0 (ADR 0033).

1. `currency_code` enum gains `EGP`, `ZAR`, `IDR`. `currency_rates.rate_to_eur`
   becomes nullable: NULL means "not configured". No exchange rate is invented.
   On a database whose `currency_rates` is already seeded, the three rows are
   inserted with a NULL rate. An empty table is left empty, so
   `seed.seed_currency_rates` (which refuses a non-empty table without
   `--reset`) still seeds all six on a fresh database.
2. The 13 `priority_scores` dimension CHECK constraints go from
   `BETWEEN 1 AND 5` to `BETWEEN 0 AND 5` (owner ruling 2026-10-21). Stored
   scores are not touched: every stored score is 1..5, `points = score / 5 *
   weight` is unchanged for them, so no rescore and no recalculation.

Downgrade restores `BETWEEN 1 AND 5` (fails if a 0 score has been stored),
deletes the EGP / ZAR / IDR rows and makes `rate_to_eur` NOT NULL again. The
three enum values stay (PostgreSQL cannot drop an enum value); they are unused
after the downgrade.

Revision ID: p21a_currencies_score_zero
Revises: p20a_run_step_span_fte
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p21a_currencies_score_zero"
down_revision: str | Sequence[str] | None = "p20a_run_step_span_fte"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW_CODES: tuple[str, ...] = ("EGP", "ZAR", "IDR")

#: Frozen copy of `models.priority.DIMENSION_FIELD_NAMES` (a migration must not
#: import application code that can change later).
_DIMENSIONS: tuple[str, ...] = (
    "strategic_project",
    "new_customer",
    "new_options",
    "regulatory_compliance",
    "quality_improvements",
    "rm_savings",
    "total_rm_savings",
    "gross_margins",
    "profitability",
    "annual_volume",
    "three_year_volume",
    "new_models",
    "capex_investment",
)


def _swap_score_constraints(low: int) -> None:
    for name in _DIMENSIONS:
        ck = f"ck_priority_scores_{name}_score_range"
        op.drop_constraint(op.f(ck), "priority_scores", type_="check")
        op.create_check_constraint(op.f(ck), "priority_scores", sa.column(name).between(low, 5))


def upgrade() -> None:
    # ADD VALUE must be committed before the new values can be used.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE currency_code ADD VALUE IF NOT EXISTS 'EGP'")
        op.execute("ALTER TYPE currency_code ADD VALUE IF NOT EXISTS 'ZAR'")
        op.execute("ALTER TYPE currency_code ADD VALUE IF NOT EXISTS 'IDR'")

    op.alter_column("currency_rates", "rate_to_eur", existing_type=sa.Numeric(10, 4), nullable=True)

    conn = op.get_bind()
    seeded = conn.execute(sa.text("SELECT EXISTS (SELECT 1 FROM currency_rates)")).scalar()
    if seeded:
        for code in _NEW_CODES:
            conn.execute(
                sa.text(
                    "INSERT INTO currency_rates (id, currency_code, rate_to_eur) "
                    "VALUES (:id, CAST(:code AS currency_code), NULL) "
                    "ON CONFLICT (currency_code) DO NOTHING"
                ),
                {"id": uuid.uuid4(), "code": code},
            )

    _swap_score_constraints(0)


def downgrade() -> None:
    _swap_score_constraints(1)

    conn = op.get_bind()
    for code in _NEW_CODES:
        conn.execute(
            sa.text(
                "DELETE FROM currency_rates WHERE currency_code = CAST(:code AS currency_code)"
            ),
            {"code": code},
        )
    op.alter_column(
        "currency_rates", "rate_to_eur", existing_type=sa.Numeric(10, 4), nullable=False
    )
