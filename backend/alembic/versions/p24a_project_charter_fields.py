"""Projects carry the client's plant, requesting department and product type
(ADR 0035, P24-T01).

Three nullable `String(100)` columns on `projects`: `plant`,
`requesting_department` and `product_type`. They hold the client workbook's
values as written (`Plant/OEM`, `Requesting Department`, `Product Type`;
controlled lists in `domain_constants.PLANT_OPTIONS`, ...). Not financial
fields, so not encrypted. Read-only in the API for now (served on
`ProjectRead` and the Dashboard register row); `GET
/planning/resource-load` filters on `requesting_department`.

No data backfill: existing rows keep NULL; the client_2026 seed fills them.

Revision ID: p24a_project_charter_fields
Revises: p21a_currencies_score_zero
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p24a_project_charter_fields"
down_revision: str | Sequence[str] | None = "p21a_currencies_score_zero"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = ("plant", "requesting_department", "product_type")


def upgrade() -> None:
    for name in _COLUMNS:
        op.add_column("projects", sa.Column(name, sa.String(100), nullable=True))


def downgrade() -> None:
    for name in reversed(_COLUMNS):
        op.drop_column("projects", name)
