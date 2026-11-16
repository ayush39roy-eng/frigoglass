"""Saved import scenarios: KPIs column, hub_codes backfill (P41-R01, ADR 0055)

Revision ID: p41b_scenario_kpis_and_hub_codes
Revises: p40a_step_pins
Create Date: 2026-11-17

Security gate remediation (MEMORY "P41-T04 gate — security-auditor leg: FAIL").

- M-1: `whatif_import_scenarios.kpis` JSONB NOT NULL, a copy of
  `result -> 'kpis'`, so the list endpoint never reads the result.
- H-1: rows saved before this revision had `hub_codes` taken from the served
  projects only. They are re-stamped with every hub (a frozen list), so they
  stay visible to the creator, Admin, Super Admin and all-hubs users only.
  New rows get the full union from the application (`snapshot_hub_codes`).

Downgrade drops the column; `hub_codes` stays as re-stamped (narrower
visibility is the safe side).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "p41b_scenario_kpis_and_hub_codes"
down_revision: str | Sequence[str] | None = "p40a_step_pins"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: `domain_constants.HUB_LAB_REGION` keys, frozen here.
_ALL_HUBS = ("OEM-HCK", "OEM-Seitek", "PD-India", "PD-Romania", "R&D-Greece", "R&D-India")


def upgrade() -> None:
    op.add_column(
        "whatif_import_scenarios",
        sa.Column("kpis", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.execute("UPDATE whatif_import_scenarios SET kpis = result -> 'kpis'")
    op.execute(
        sa.text("UPDATE whatif_import_scenarios SET hub_codes = :hubs").bindparams(
            sa.bindparam("hubs", value=list(_ALL_HUBS), type_=postgresql.ARRAY(sa.Text()))
        )
    )
    op.alter_column("whatif_import_scenarios", "kpis", nullable=False)


def downgrade() -> None:
    op.drop_column("whatif_import_scenarios", "kpis")
