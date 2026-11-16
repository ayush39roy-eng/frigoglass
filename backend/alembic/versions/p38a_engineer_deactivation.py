"""Engineer deactivation (P38-T04, ADR 0053 as ruled at P38-T01, R38-1..R38-9)

Revision ID: p38a_engineer_deactivation
Revises: p41b_scenario_kpis_and_hub_codes
Create Date: 2026-11-17

docs/DOMAIN_RULES.md "Engineer deactivation", docs/API_CONTRACT_P38.md.

Upgrade, additive only. Every existing engineer is backfilled **active** with
no inactive period, so every supply figure, the live input hash and every
stored run read exactly as before (I43, R38-9).

- `engineers.active` (NOT NULL, default true) and the deactivation fields
  `deactivated_at`, `deactivated_week` (1..52, the calendar week),
  `deactivated_plan_year`, `deactivated_by_user_id` (FK users) and
  `deactivation_reason` (a fixed code, never free text, OQ #97).
  CHECK `deactivation_fields`: an active engineer has every field null; an
  inactive one has at, week, plan year and reason set (the actor may be null
  only if the user row ever goes away).
- `engineer_inactive_periods`: one row per deactivation, closed by a
  reactivation (`to_plan_year` / `to_week`, both null while open). A partial
  unique index allows at most one open period per engineer (I42).
- `project_leader_history`: one append-only row per leader change from P38
  on (R38-6), no backfill. `engineer_id` is the leader the project had before
  the change (null when it had none), `new_engineer_id` the one after (null
  = cleared), `from_week` the calendar week that former leader's tenure began
  if recorded here, `to_week` / `plan_year` the calendar week of the change.
  UPDATE is always rejected; DELETE only inside the admin reseed
  (`SET LOCAL rpd.allow_leader_history_delete = 'on'`), the same escape
  hatch `stage_checkins` has (p24b).
- I42 as deferred constraint triggers (checked at COMMIT, so the
  deactivation's one transaction may pass through intermediate states):
  `engineers.active = false` iff exactly one open period, and no project whose
  status is not Commercialized / Cancelled is led by an inactive engineer.
  The API checks first and answers coded 4xx; the triggers are the last line
  for every other writer (seed, scripts, client re-import).

Downgrade drops the triggers, both tables and the engineer columns (the
deactivation state is lost; every engineer is then simply present again).

No raw SQL string interpolation of data: the DDL below uses fixed
identifiers only.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "p38a_engineer_deactivation"
down_revision: str | Sequence[str] | None = "p41b_scenario_kpis_and_hub_codes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ENG = "engineers"
_PERIODS = "engineer_inactive_periods"
_HISTORY = "project_leader_history"

_CK_FIELDS = "ck_engineers_deactivation_fields"
_CK_WEEK = "ck_engineers_deactivated_week_range"
_CK_REASON = "ck_engineers_deactivation_reason"

#: Constant SQL. 52 = WITHIN_YEAR_WEEK, frozen here.
_REASONS = "('left_company', 'changed_role', 'long_absence', 'other')"
_FIELDS_CHECK = (
    "(active AND deactivated_at IS NULL AND deactivated_week IS NULL "
    "AND deactivated_plan_year IS NULL AND deactivation_reason IS NULL "
    "AND deactivated_by_user_id IS NULL) OR "
    "(NOT active AND deactivated_at IS NOT NULL AND deactivated_week IS NOT NULL "
    "AND deactivated_plan_year IS NOT NULL AND deactivation_reason IS NOT NULL)"
)

_HISTORY_CAUSES = "('registration', 'project_update', 'register_edit', 'engineer_deactivated')"

_HISTORY_MUTATION_FN = "project_leader_history_reject_mutation"
_PERIOD_CHECK_FN = "engineer_inactive_period_consistency"
_LEADER_CHECK_FN = "project_leader_active_check"


def upgrade() -> None:
    # --- engineers ----------------------------------------------------------------
    op.add_column(_ENG, sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column(_ENG, sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(_ENG, sa.Column("deactivated_week", sa.SmallInteger(), nullable=True))
    op.add_column(_ENG, sa.Column("deactivated_plan_year", sa.Integer(), nullable=True))
    op.add_column(
        _ENG,
        sa.Column(
            "deactivated_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_engineers_deactivated_by_user_id_users"),
            nullable=True,
        ),
    )
    op.add_column(_ENG, sa.Column("deactivation_reason", sa.String(20), nullable=True))
    op.create_check_constraint(op.f(_CK_FIELDS), _ENG, _FIELDS_CHECK)
    op.create_check_constraint(
        op.f(_CK_WEEK),
        _ENG,
        "deactivated_week IS NULL OR (deactivated_week >= 1 AND deactivated_week <= 52)",
    )
    op.create_check_constraint(
        op.f(_CK_REASON),
        _ENG,
        f"deactivation_reason IS NULL OR deactivation_reason IN {_REASONS}",
    )
    op.create_index("ix_engineers_active", _ENG, ["active"])

    # --- engineer_inactive_periods --------------------------------------------------
    op.create_table(
        _PERIODS,
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "engineer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "engineers.id", name="fk_engineer_inactive_periods_engineer_id_engineers"
            ),
            nullable=False,
        ),
        sa.Column("from_plan_year", sa.Integer(), nullable=False),
        sa.Column("from_week", sa.SmallInteger(), nullable=False),
        sa.Column("to_plan_year", sa.Integer(), nullable=True),
        sa.Column("to_week", sa.SmallInteger(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "from_week >= 1 AND from_week <= 52", name="ck_engineer_inactive_periods_from_week"
        ),
        sa.CheckConstraint(
            "(to_plan_year IS NULL AND to_week IS NULL AND closed_at IS NULL) OR "
            "(to_plan_year IS NOT NULL AND to_week IS NOT NULL AND closed_at IS NOT NULL "
            "AND to_week >= 1 AND to_week <= 52 "
            "AND (to_plan_year > from_plan_year "
            "OR (to_plan_year = from_plan_year AND to_week >= from_week)))",
            name="ck_engineer_inactive_periods_closed",
        ),
    )
    op.create_index("ix_engineer_inactive_periods_engineer_id", _PERIODS, ["engineer_id"])
    op.create_index(
        "uq_engineer_inactive_periods_one_open",
        _PERIODS,
        ["engineer_id"],
        unique=True,
        postgresql_where=sa.text("to_week IS NULL"),
    )

    # --- project_leader_history -----------------------------------------------------
    op.create_table(
        _HISTORY,
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", name="fk_project_leader_history_project_id_projects"),
            nullable=False,
        ),
        sa.Column(
            "engineer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("engineers.id", name="fk_project_leader_history_engineer_id_engineers"),
            nullable=True,
        ),
        sa.Column(
            "new_engineer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "engineers.id", name="fk_project_leader_history_new_engineer_id_engineers"
            ),
            nullable=True,
        ),
        sa.Column("plan_year", sa.Integer(), nullable=False),
        sa.Column("from_week", sa.SmallInteger(), nullable=True),
        sa.Column("to_week", sa.SmallInteger(), nullable=False),
        sa.Column("cause", sa.String(40), nullable=False),
        sa.Column(
            "changed_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_project_leader_history_changed_by_user_id_users"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "to_week >= 1 AND to_week <= 52 "
            "AND (from_week IS NULL OR (from_week >= 1 AND from_week <= 52))",
            name="ck_project_leader_history_weeks",
        ),
        sa.CheckConstraint(f"cause IN {_HISTORY_CAUSES}", name="ck_project_leader_history_cause"),
        sa.CheckConstraint(
            "engineer_id IS DISTINCT FROM new_engineer_id",
            name="ck_project_leader_history_is_change",
        ),
    )
    op.create_index("ix_project_leader_history_project_id", _HISTORY, ["project_id", "created_at"])
    op.create_index("ix_project_leader_history_engineer_id", _HISTORY, ["engineer_id"])

    # Append-only (I44), with the reseed escape hatch for DELETE only.
    op.execute(
        f"""
        CREATE FUNCTION {_HISTORY_MUTATION_FN}() RETURNS trigger AS $$
        BEGIN
            IF TG_OP = 'DELETE'
               AND current_setting('rpd.allow_leader_history_delete', true) = 'on' THEN
                RETURN OLD;  -- admin reseed script only (SET LOCAL), never the API
            END IF;
            RAISE EXCEPTION
                'project_leader_history is append-only: % is not permitted', TG_OP
                USING ERRCODE = '23001';
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER trg_project_leader_history_append_only
        BEFORE UPDATE OR DELETE ON {_HISTORY}
        FOR EACH ROW EXECUTE FUNCTION {_HISTORY_MUTATION_FN}()
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER trg_project_leader_history_no_truncate
        BEFORE TRUNCATE ON {_HISTORY}
        FOR EACH STATEMENT EXECUTE FUNCTION {_HISTORY_MUTATION_FN}()
        """
    )

    # I42 (a): active = false iff exactly one open period (deferred to COMMIT).
    op.execute(
        f"""
        CREATE FUNCTION {_PERIOD_CHECK_FN}() RETURNS trigger AS $$
        DECLARE
            eid uuid;
            is_active boolean;
            open_count integer;
        BEGIN
            IF TG_TABLE_NAME = 'engineers' THEN
                eid := NEW.id;
            ELSIF TG_OP = 'DELETE' THEN
                eid := OLD.engineer_id;
            ELSE
                eid := NEW.engineer_id;
            END IF;
            SELECT e.active INTO is_active FROM engineers e WHERE e.id = eid;
            IF NOT FOUND THEN
                RETURN NULL;  -- the engineer row itself was removed (reseed)
            END IF;
            SELECT count(*) INTO open_count
              FROM engineer_inactive_periods p
             WHERE p.engineer_id = eid AND p.to_week IS NULL;
            IF (is_active AND open_count <> 0) OR (NOT is_active AND open_count <> 1) THEN
                RAISE EXCEPTION
                    'I42: engineer % has active=% with % open inactive period(s)',
                    eid, is_active, open_count
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        f"""
        CREATE CONSTRAINT TRIGGER trg_engineers_period_consistency
        AFTER INSERT OR UPDATE OF active ON {_ENG}
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION {_PERIOD_CHECK_FN}()
        """
    )
    op.execute(
        f"""
        CREATE CONSTRAINT TRIGGER trg_engineer_inactive_periods_consistency
        AFTER INSERT OR UPDATE OR DELETE ON {_PERIODS}
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION {_PERIOD_CHECK_FN}()
        """
    )

    # I42 (b): no open project is led by an inactive engineer (deferred).
    op.execute(
        f"""
        CREATE FUNCTION {_LEADER_CHECK_FN}() RETURNS trigger AS $$
        DECLARE
            bad uuid;
        BEGIN
            IF TG_TABLE_NAME = 'projects' THEN
                SELECT p.id INTO bad
                  FROM projects p JOIN engineers e ON e.id = p.leader_engineer_id
                 WHERE p.id = NEW.id
                   AND NOT e.active
                   AND p.status NOT IN ('Commercialized', 'Cancelled')
                 LIMIT 1;
            ELSE
                SELECT p.id INTO bad
                  FROM projects p JOIN engineers e ON e.id = p.leader_engineer_id
                 WHERE e.id = NEW.id
                   AND NOT e.active
                   AND p.status NOT IN ('Commercialized', 'Cancelled')
                 LIMIT 1;
            END IF;
            IF bad IS NOT NULL THEN
                RAISE EXCEPTION
                    'I42: open project % is led by an inactive engineer', bad
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        f"""
        CREATE CONSTRAINT TRIGGER trg_projects_leader_active
        AFTER INSERT OR UPDATE OF leader_engineer_id, status ON projects
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION {_LEADER_CHECK_FN}()
        """
    )
    op.execute(
        f"""
        CREATE CONSTRAINT TRIGGER trg_engineers_leader_active
        AFTER UPDATE OF active ON {_ENG}
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION {_LEADER_CHECK_FN}()
        """
    )


def downgrade() -> None:
    op.execute(f"DROP TRIGGER IF EXISTS trg_engineers_leader_active ON {_ENG}")
    op.execute("DROP TRIGGER IF EXISTS trg_projects_leader_active ON projects")
    op.execute(f"DROP FUNCTION IF EXISTS {_LEADER_CHECK_FN}()")
    op.execute(f"DROP TRIGGER IF EXISTS trg_engineer_inactive_periods_consistency ON {_PERIODS}")
    op.execute(f"DROP TRIGGER IF EXISTS trg_engineers_period_consistency ON {_ENG}")
    op.execute(f"DROP FUNCTION IF EXISTS {_PERIOD_CHECK_FN}()")
    op.drop_table(_HISTORY)  # its triggers go with it
    op.execute(f"DROP FUNCTION IF EXISTS {_HISTORY_MUTATION_FN}()")
    op.drop_table(_PERIODS)
    op.drop_index("ix_engineers_active", table_name=_ENG)
    op.drop_constraint(op.f(_CK_REASON), _ENG, type_="check")
    op.drop_constraint(op.f(_CK_WEEK), _ENG, type_="check")
    op.drop_constraint(op.f(_CK_FIELDS), _ENG, type_="check")
    op.drop_column(_ENG, "deactivation_reason")
    op.drop_column(_ENG, "deactivated_by_user_id")
    op.drop_column(_ENG, "deactivated_plan_year")
    op.drop_column(_ENG, "deactivated_week")
    op.drop_column(_ENG, "deactivated_at")
    op.drop_column(_ENG, "active")
