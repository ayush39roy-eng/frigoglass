"""stage_checkins: DELETE escape hatch for the demo reseed only (P24-T01)

Revision ID: p24b_checkin_reset_escape
Revises: p24a_project_charter_fields
Create Date: 2026-10-21

`seed_demo_data --reset` deletes and recreates every project. `stage_checkins`
rows reference `projects.id` (NOT NULL, no ON DELETE action), and
`p12b_vip_checkins` made them append-only with no escape hatch. So on any live
database that holds a single check-in, the reset could not delete the
projects. The live dev DB of 2026-10-21 hit the same class of failure
through `notifications`.

This revision gives `stage_checkins` the same escape hatch that
`project_comments` has had since P9-T01 (`rpd.allow_comment_delete`):

- DELETE is allowed only when the transaction has run
  `SET LOCAL rpd.allow_checkin_delete = 'on'`. Only the admin reseed script
  does that; the API never does.
- UPDATE is still rejected unconditionally, for any role.
- TRUNCATE is still rejected unconditionally (that statement-level trigger is
  untouched).

`audit_log_entries` is untouched and keeps no escape hatch at all.

No raw SQL string interpolation of data: the DDL below uses fixed
identifiers only.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "p24b_checkin_reset_escape"
down_revision: str | Sequence[str] | None = "p24a_project_charter_fields"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_MUTATION_FN = "stage_checkins_reject_mutation"


def upgrade() -> None:
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION {_MUTATION_FN}() RETURNS trigger AS $$
        BEGIN
            IF TG_OP = 'DELETE'
               AND current_setting('rpd.allow_checkin_delete', true) = 'on' THEN
                RETURN OLD;  -- admin reseed script only (SET LOCAL), never the API
            END IF;
            RAISE EXCEPTION
                'stage_checkins is append-only: % is not permitted (row id=%)',
                TG_OP, COALESCE(OLD.id, NULL)
                USING ERRCODE = '23001';
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
        """
    )


def downgrade() -> None:
    # Back to p12b_vip_checkins' body: no escape hatch.
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION {_MUTATION_FN}() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION
                'stage_checkins is append-only: % is not permitted (row id=%)',
                TG_OP, COALESCE(OLD.id, NULL)
                USING ERRCODE = '23001';
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
        """
    )
