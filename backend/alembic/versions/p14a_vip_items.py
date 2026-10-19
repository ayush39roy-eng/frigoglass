"""Curated VIP board tables (ADR 0027; docs/API_CONTRACT_P14.md §2).

- `vip_items`: one row per slide bullet. `area`, `pillar` and `status_tag`
  are VARCHAR with CHECK constraints (no native enum types). `parent_id`
  gives one level of sub-items and cascades on delete.
- `vip_item_projects(item_id, project_id)`: links; cascades on both sides.

Schema only. The three slides are seeded by `seed/seed_vip_board.py`
(idempotent), which the client-2026 demo seed also calls.

Revision ID: p14a_vip_items
Revises: p13a_oem_lab_region
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p14a_vip_items"
down_revision: str | Sequence[str] | None = "p13a_oem_lab_region"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Literal copies of models/vip.py's CHECK expressions: a migration must not
# change meaning if the model's enums change later.
_AREA_CHECK = "area IN ('OEM', 'Europe', 'India')"
_PILLAR_CHECK = "pillar IN ('INNOVATION', 'MARKET_EXPANSION', 'PERFORMANCE')"
_STATUS_TAG_CHECK = (
    "status_tag IS NULL OR status_tag IN ('ON_TRACK', 'DELAYED', 'HIGH_RISK', "
    "'COMMERCIALIZED', 'IMPLEMENTED', 'TBD', 'UNDER_INVESTIGATION', 'AWAITING_APPROVAL')"
)


def upgrade() -> None:
    op.create_table(
        "vip_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("area", sa.String(length=20), nullable=False),
        sa.Column("pillar", sa.String(length=30), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("status_tag", sa.String(length=30), nullable=True),
        sa.Column("status_note", sa.String(length=200), nullable=True),
        sa.Column("highlighted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(_AREA_CHECK, name=op.f("ck_vip_items_area_valid")),
        sa.CheckConstraint(_PILLAR_CHECK, name=op.f("ck_vip_items_pillar_valid")),
        sa.CheckConstraint(_STATUS_TAG_CHECK, name=op.f("ck_vip_items_status_tag_valid")),
        sa.CheckConstraint(
            "parent_id IS NULL OR parent_id <> id", name=op.f("ck_vip_items_parent_not_self")
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"], ["vip_items.id"],
            name=op.f("fk_vip_items_parent_id_vip_items"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_vip_items")),
    )
    op.create_index(op.f("ix_vip_items_parent_id"), "vip_items", ["parent_id"])
    op.create_table(
        "vip_item_projects",
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["item_id"], ["vip_items.id"],
            name=op.f("fk_vip_item_projects_item_id_vip_items"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"],
            name=op.f("fk_vip_item_projects_project_id_projects"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("item_id", "project_id", name=op.f("pk_vip_item_projects")),
    )
    op.create_index(
        op.f("ix_vip_item_projects_project_id"), "vip_item_projects", ["project_id"]
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_vip_item_projects_project_id"), table_name="vip_item_projects")
    op.drop_table("vip_item_projects")
    op.drop_index(op.f("ix_vip_items_parent_id"), table_name="vip_items")
    op.drop_table("vip_items")
