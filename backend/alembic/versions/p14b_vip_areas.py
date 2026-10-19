"""VIP areas become lab regions (ADR 0027 amendment, OQ #39 answered).

`vip_items.area` changes from OEM | Europe | India to Greece | India | Romania
(the hub's `lab_region`; OEM hubs count as Greece). A follow-up revision
because `p14a_vip_items` was already applied to the live dev DB.

Data: the OEM slide → Greece, the Europe slide → Romania, India unchanged.
Downgrade maps back (Greece → OEM, Romania → Europe). Like the earlier data
migrations, no audit rows (recorded in docs/MEMORY.md, P14-T02).

`projects.is_vip` is not touched here; `seed/seed_vip_board.py` recomputes it
under the amended "highlighted items only" rule.

Revision ID: p14b_vip_areas
Revises: p14a_vip_items
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p14b_vip_areas"
down_revision: str | Sequence[str] | None = "p14a_vip_items"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CK = "ck_vip_items_area_valid"
_OLD_CHECK = "area IN ('OEM', 'Europe', 'India')"
_NEW_CHECK = "area IN ('Greece', 'India', 'Romania')"
_vip_items = sa.table("vip_items", sa.column("area", sa.String))


def _remap(pairs: tuple[tuple[str, str], ...]) -> None:
    for old, new in pairs:
        op.execute(_vip_items.update().where(_vip_items.c.area == old).values(area=new))


def upgrade() -> None:
    op.drop_constraint(op.f(_CK), "vip_items", type_="check")
    _remap((("OEM", "Greece"), ("Europe", "Romania")))
    op.create_check_constraint(op.f(_CK), "vip_items", _NEW_CHECK)


def downgrade() -> None:
    op.drop_constraint(op.f(_CK), "vip_items", type_="check")
    _remap((("Greece", "OEM"), ("Romania", "Europe")))
    op.create_check_constraint(op.f(_CK), "vip_items", _OLD_CHECK)
