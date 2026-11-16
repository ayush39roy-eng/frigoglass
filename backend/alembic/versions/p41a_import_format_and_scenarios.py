"""Import format settings and saved What-if import scenarios (P41-T02, ADR 0055)

Revision ID: p41a_import_format_and_scenarios
Revises: p33c_clear_step_timing
Create Date: 2026-11-17

ADR 0055 D1 and D3, docs/API_CONTRACT_P41.md C.

Upgrade creates two tables. No existing row is touched.

- `import_format_settings`: a single row (`id = 1`, CHECK) holding the header
  aliases of the What-if workbook parser, with an optimistic `version`. No
  row is inserted: no row means the built-in aliases (version 0).
- `whatif_import_scenarios`: saved import scenarios, frozen records of a
  server-recomputed simulate request and response (JSONB), with the week and
  plan version they were simulated from and the hubs they touch. `created_by`
  is `ON DELETE SET NULL`. Indexes on `created_by`, `source_file_sha256` and
  `created_at DESC`.

Downgrade drops both tables (saved scenarios are lost, by design: they never
feed the live plan).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "p41a_import_format_and_scenarios"
down_revision: str | Sequence[str] | None = "p33c_clear_step_timing"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "import_format_settings",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("field_aliases", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("id = 1", name=op.f("ck_import_format_settings_single_row")),
        sa.CheckConstraint("version >= 1", name=op.f("ck_import_format_settings_version_positive")),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
            name=op.f("fk_import_format_settings_updated_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_import_format_settings")),
    )
    op.create_table(
        "whatif_import_scenarios",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("source_file_name", sa.String(length=200), nullable=False),
        sa.Column("source_file_sha256", sa.String(length=64), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("plan_year_end_week", sa.Integer(), nullable=False),
        sa.Column("simulated_week", sa.Integer(), nullable=False),
        sa.Column("plan_version", sa.Integer(), nullable=True),
        sa.Column("hub_codes", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("request", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "mode IN ('merge', 'file_only')", name=op.f("ck_whatif_import_scenarios_mode_valid")
        ),
        sa.CheckConstraint(
            "plan_year_end_week IN (52, 104)",
            name=op.f("ck_whatif_import_scenarios_plan_year_end_valid"),
        ),
        sa.CheckConstraint(
            "char_length(name) BETWEEN 1 AND 120",
            name=op.f("ck_whatif_import_scenarios_name_length"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_whatif_import_scenarios_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_whatif_import_scenarios")),
    )
    op.create_index(
        "ix_whatif_import_scenarios_created_by", "whatif_import_scenarios", ["created_by"]
    )
    op.create_index(
        "ix_whatif_import_scenarios_source_file_sha256",
        "whatif_import_scenarios",
        ["source_file_sha256"],
    )
    op.create_index(
        "ix_whatif_import_scenarios_created_at",
        "whatif_import_scenarios",
        [sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_whatif_import_scenarios_created_at", table_name="whatif_import_scenarios")
    op.drop_index(
        "ix_whatif_import_scenarios_source_file_sha256", table_name="whatif_import_scenarios"
    )
    op.drop_index("ix_whatif_import_scenarios_created_by", table_name="whatif_import_scenarios")
    op.drop_table("whatif_import_scenarios")
    op.drop_table("import_format_settings")
