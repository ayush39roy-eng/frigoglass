"""projects.band_rank: rank within a priority band (P36-T03, ADR 0050)

Revision ID: p36a_project_band_rank
Revises: p33a_categories
Create Date: 2026-11-15

ADR 0050 as ruled by the workflow-auditor (MEMORY "[2026-11-15] P36-T01",
R36-1 and R36-8). DOMAIN_RULES "Scheduling order" key 3a.

Upgrade:

- `projects.band_rank` INTEGER NULL: the project's position inside its
  committed `priority` band, dense 1..n per band.
- Backfill (R36-1): every *band member* (status in the four schedulable
  statuses and `priority` set, frozen and VIP included) is ranked inside its
  priority by the scheduling order's old keys 4–5 + id: the status ordinal
  (a frozen copy of `SCHEDULABLE_STATUS_ORDER`), the LIVE `categories.rank`
  (never the constant: ADR 0047 categories may sit anywhere), then
  `project_id` (Postgres uuid order equals Python `str(uuid)` order, checked
  in R36-1). A member with no category cannot run today
  (`validate_schedulable_project` raises), so it is ranked after every
  categorised member of its band, by id; their count is logged. Every
  non-member stays NULL. The first run after the migration therefore gives
  the identical order and schedule for every project (R36-1 proof).
- Constraints (R36-8):
  - `ck_projects_band_rank_positive`: `band_rank IS NULL OR band_rank >= 1`;
  - `ck_projects_band_rank_membership`: `band_rank` is set iff the project is
    a band member (I37b);
  - `uq_projects_priority_band_rank`: UNIQUE `(priority, band_rank)`
    DEFERRABLE INITIALLY DEFERRED, so a band can be renumbered row by row in
    one transaction. A UNIQUE constraint treats NULLs as distinct, so it is
    exactly the ruled partial unique index `WHERE band_rank IS NOT NULL`
    (Postgres cannot defer a unique *index*; a constraint can be deferred).

Downgrade drops the three constraints and the column (the order falls back to
status / category / id, which is the backfilled order of an untouched DB).
"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p36a_project_band_rank"
down_revision: str | Sequence[str] | None = "p33a_categories"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger("alembic.runtime.migration")

_TABLE = "projects"
_CK_POSITIVE = "ck_projects_band_rank_positive"
_CK_MEMBERSHIP = "ck_projects_band_rank_membership"
_UQ = "uq_projects_priority_band_rank"

#: `domain_constants.SCHEDULABLE_STATUS_ORDER`, frozen here (R36-1(b)): a
#: migration must not change meaning when the constant does.
_STATUS_ORDINAL: tuple[tuple[str, int], ...] = (
    ("In Buyoff", 0),
    ("Under Industrialization", 1),
    ("In Development", 2),
    ("In Queue", 3),
)
_SCHEDULABLE_SQL = ", ".join(f"'{name}'" for name, _ in _STATUS_ORDINAL)
_STATUS_CASE = (
    "CASE p.status::text "
    + " ".join(f"WHEN '{name}' THEN {ordinal}" for name, ordinal in _STATUS_ORDINAL)
    + " END"
)
_MEMBER_SQL = f"priority IS NOT NULL AND status::text IN ({_SCHEDULABLE_SQL})"

#: R36-1: per band, categorised members by (status ordinal, live category
#: rank, id); members with no category after them, by id. Constant SQL, no
#: interpolated values.
_BACKFILL_SQL = f"""
UPDATE projects SET band_rank = ranked.r
FROM (
    SELECT p.id,
           ROW_NUMBER() OVER (
               PARTITION BY p.priority
               ORDER BY (c.rank IS NULL),
                        CASE WHEN c.rank IS NULL THEN 0 ELSE {_STATUS_CASE} END,
                        c.rank,
                        p.id
           ) AS r
    FROM projects p
    LEFT JOIN categories c ON c.code = p.category
    WHERE p.priority IS NOT NULL AND p.status::text IN ({_SCHEDULABLE_SQL})
) AS ranked
WHERE projects.id = ranked.id
"""

_UNCATEGORISED_SQL = f"SELECT count(*) FROM projects WHERE category IS NULL AND {_MEMBER_SQL}"


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column("band_rank", sa.Integer(), nullable=True))
    bind = op.get_bind()
    bind.execute(sa.text(_BACKFILL_SQL))
    uncategorised: int = bind.execute(sa.text(_UNCATEGORISED_SQL)).scalar_one()
    if uncategorised:
        logger.warning(
            "p36a: %d schedulable project(s) with a priority but no category were "
            "ranked last in their band, by id (R36-1(d))",
            uncategorised,
        )
    op.create_check_constraint(op.f(_CK_POSITIVE), _TABLE, "band_rank IS NULL OR band_rank >= 1")
    op.create_check_constraint(
        op.f(_CK_MEMBERSHIP), _TABLE, f"(band_rank IS NOT NULL) = ({_MEMBER_SQL})"
    )
    op.create_unique_constraint(
        op.f(_UQ), _TABLE, ["priority", "band_rank"], deferrable=True, initially="DEFERRED"
    )


def downgrade() -> None:
    op.drop_constraint(op.f(_UQ), _TABLE, type_="unique")
    op.drop_constraint(op.f(_CK_MEMBERSHIP), _TABLE, type_="check")
    op.drop_constraint(op.f(_CK_POSITIVE), _TABLE, type_="check")
    op.drop_column(_TABLE, "band_rank")
