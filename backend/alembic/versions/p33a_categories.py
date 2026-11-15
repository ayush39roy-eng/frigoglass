"""categories table; category columns become text + FK (P33-T07, ADR 0047)

Revision ID: p33a_categories
Revises: p35a_project_actual_end_week
Create Date: 2026-11-13

ADR 0047 §1, DOMAIN_RULES "Category templates" §E, contract P33 Part B.

Upgrade:

- `categories` (`models.category.Category`): `code` text PK (the wire value),
  `label`, `workflow_id` FK `workflows.id`, `rank` (UNIQUE, DEFERRABLE
  INITIALLY IMMEDIATE so a renumbering UPDATE is checked at statement end),
  `template_version`, `copied_from_code`, `active`, `created_at`,
  `created_by`. CHECKs on the code format (1..16 of `[A-Za-z0-9+\\- ]`, not
  `OEM`), the label length and positive rank / version; a unique index on
  `lower(code)`.
- Seeded with the seven codes of today's order at ranks 1..7 (A+, A, B, C on
  `PDD`; A-OEM, B-OEM, C-OEM on `OEM`), label = code.
- `projects.category` and `workflow_lead_times.category` become `text`
  (`USING category::text`: every stored value is kept as-is, the code is the
  key) with an FK to `categories.code`, ON UPDATE / ON DELETE RESTRICT.
- `engineers.allowed_categories` becomes `text[]` (`USING ...::text[]`, order
  and duplicates kept). Trigger `trg_engineers_allowed_categories_known`
  rejects any element that is not a category code or the reserved `OEM`
  (SQLSTATE 23514, constraint name `ck_engineers_allowed_categories_known`).
- `trg_projects_category_matches_hub` is rewritten to compare
  `categories.workflow_id` with the hub's workflow (`hubs.is_oem` -> `OEM`,
  else `PDD`). Same name, SQLSTATE, constraint name and messages; identical
  behaviour on the seven seeded codes. An unknown code passes the trigger
  and is reported by the FK.
- The `project_category` and `engineer_allowed_category` enum types are
  dropped.

Downgrade restores the enums, the old trigger body and the enum-typed
columns. It **refuses** (raises, nothing changed) when any project, template
row or engineer uses a code outside the seeded seven (+ `OEM` for
engineers): those values have no enum label to go back to. A category added
later (P33-T11) always has template rows, so a downgrade after one refuses.

No scheduler input changes: the codes, the lead times and the engineers'
lists are byte-identical, so the live input hash, a fresh run and every
stored run are unchanged (P33-T07 acceptance).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p33a_categories"
down_revision: str | Sequence[str] | None = "p35a_project_actual_end_week"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Today's order (`domain_constants.CATEGORY_ORDER`), frozen here: a migration
#: must not change meaning when the constant does.
_SEED: tuple[tuple[str, str], ...] = (
    ("A+", "PDD"),
    ("A", "PDD"),
    ("B", "PDD"),
    ("C", "PDD"),
    ("A-OEM", "OEM"),
    ("B-OEM", "OEM"),
    ("C-OEM", "OEM"),
)
_FK_PROJECTS = "fk_projects_category_categories"
_FK_LEAD_TIMES = "fk_workflow_lead_times_category_categories"

_PROJECTS_TRIGGER_FN = """
CREATE OR REPLACE FUNCTION rpd_projects_category_matches_hub() RETURNS trigger AS $$
DECLARE
    hub_is_oem boolean;
    category_workflow text;
BEGIN
    IF NEW.category IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT is_oem INTO hub_is_oem FROM hubs WHERE id = NEW.hub_id;
    IF hub_is_oem IS NULL THEN
        RETURN NEW;  -- the FK on hub_id reports the missing hub
    END IF;
    SELECT workflow_id INTO category_workflow FROM categories WHERE code = NEW.category;
    IF category_workflow IS NULL THEN
        RETURN NEW;  -- the FK on category reports the unknown code
    END IF;
    IF hub_is_oem AND category_workflow <> 'OEM' THEN
        RAISE EXCEPTION 'project on an OEM hub must carry an OEM category (A-OEM/B-OEM/C-OEM), got %',
            NEW.category
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'ck_projects_category_matches_hub';
    END IF;
    IF NOT hub_is_oem AND category_workflow <> 'PDD' THEN
        RAISE EXCEPTION 'project on a non-OEM hub must carry A+/A/B/C, got %',
            NEW.category
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'ck_projects_category_matches_hub';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

#: The P9-T01 body, restored verbatim by the downgrade.
_PROJECTS_TRIGGER_FN_P9 = """
CREATE OR REPLACE FUNCTION rpd_projects_category_matches_hub() RETURNS trigger AS $$
DECLARE
    hub_is_oem boolean;
BEGIN
    IF NEW.category IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT is_oem INTO hub_is_oem FROM hubs WHERE id = NEW.hub_id;
    IF hub_is_oem IS NULL THEN
        RETURN NEW;  -- the FK on hub_id reports the missing hub
    END IF;
    IF hub_is_oem AND NEW.category::text NOT IN ('A-OEM', 'B-OEM', 'C-OEM') THEN
        RAISE EXCEPTION 'project on an OEM hub must carry an OEM category (A-OEM/B-OEM/C-OEM), got %',
            NEW.category
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'ck_projects_category_matches_hub';
    END IF;
    IF NOT hub_is_oem AND NEW.category::text IN ('A-OEM', 'B-OEM', 'C-OEM') THEN
        RAISE EXCEPTION 'project on a non-OEM hub must carry A+/A/B/C, got %',
            NEW.category
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'ck_projects_category_matches_hub';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

_PROJECTS_TRIGGER = """
CREATE TRIGGER trg_projects_category_matches_hub
BEFORE INSERT OR UPDATE OF category, hub_id ON projects
FOR EACH ROW EXECUTE FUNCTION rpd_projects_category_matches_hub();
"""

_ENGINEERS_TRIGGER_FN = """
CREATE OR REPLACE FUNCTION rpd_engineers_allowed_categories_known() RETURNS trigger AS $$
DECLARE
    bad text;
BEGIN
    SELECT e INTO bad
      FROM unnest(NEW.allowed_categories) AS e
     WHERE e IS NULL
        OR (e <> 'OEM' AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.code = e))
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'allowed_categories element % is not a category code or OEM', bad
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'ck_engineers_allowed_categories_known';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

_ENGINEERS_TRIGGER = """
CREATE TRIGGER trg_engineers_allowed_categories_known
BEFORE INSERT OR UPDATE OF allowed_categories ON engineers
FOR EACH ROW EXECUTE FUNCTION rpd_engineers_allowed_categories_known();
"""


def upgrade() -> None:
    op.create_table(
        "categories",
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("workflow_id", sa.String(length=10), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column("template_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("copied_from_code", sa.Text(), nullable=True),
        sa.Column("active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.CheckConstraint(
            "char_length(code) BETWEEN 1 AND 16 AND code ~ '^[A-Za-z0-9+\\- ]+$' "
            "AND upper(code) <> 'OEM'",
            name=op.f("ck_categories_code_format"),
        ),
        sa.CheckConstraint(
            "char_length(label) BETWEEN 1 AND 60", name=op.f("ck_categories_label_length")
        ),
        sa.CheckConstraint("rank >= 1", name=op.f("ck_categories_rank_positive")),
        sa.CheckConstraint(
            "template_version >= 1", name=op.f("ck_categories_template_version_positive")
        ),
        sa.ForeignKeyConstraint(
            ["workflow_id"], ["workflows.id"], name=op.f("fk_categories_workflow_id_workflows")
        ),
        sa.ForeignKeyConstraint(
            ["copied_from_code"],
            ["categories.code"],
            name=op.f("fk_categories_copied_from_code_categories"),
            onupdate="RESTRICT",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_categories_created_by_users")
        ),
        sa.PrimaryKeyConstraint("code", name=op.f("pk_categories")),
        sa.UniqueConstraint(
            "rank", name=op.f("uq_categories_rank"), deferrable=True, initially="IMMEDIATE"
        ),
    )
    op.execute("CREATE UNIQUE INDEX ux_categories_code_lower ON categories (lower(code))")

    seed = sa.table(
        "categories",
        sa.column("code", sa.Text()),
        sa.column("label", sa.Text()),
        sa.column("workflow_id", sa.String()),
        sa.column("rank", sa.Integer()),
    )
    op.bulk_insert(
        seed,
        [
            {"code": code, "label": code, "workflow_id": wf, "rank": rank}
            for rank, (code, wf) in enumerate(_SEED, start=1)
        ],
    )

    # The trigger is declared `UPDATE OF category`, which blocks a type change.
    op.execute("DROP TRIGGER IF EXISTS trg_projects_category_matches_hub ON projects")

    op.execute("ALTER TABLE projects ALTER COLUMN category TYPE text USING category::text")
    op.execute(
        "ALTER TABLE workflow_lead_times ALTER COLUMN category TYPE text USING category::text"
    )
    op.execute(
        "ALTER TABLE engineers ALTER COLUMN allowed_categories TYPE text[] "
        "USING allowed_categories::text[]"
    )

    op.create_foreign_key(
        _FK_PROJECTS,
        "projects",
        "categories",
        ["category"],
        ["code"],
        onupdate="RESTRICT",
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        _FK_LEAD_TIMES,
        "workflow_lead_times",
        "categories",
        ["category"],
        ["code"],
        onupdate="RESTRICT",
        ondelete="RESTRICT",
    )

    op.execute("DROP TYPE project_category")
    op.execute("DROP TYPE engineer_allowed_category")

    op.execute(_PROJECTS_TRIGGER_FN)
    op.execute(_PROJECTS_TRIGGER)
    op.execute(_ENGINEERS_TRIGGER_FN)
    op.execute(_ENGINEERS_TRIGGER)


#: Refuse before changing anything (the whole migration is one transaction).
_DOWNGRADE_GUARD = """
DO $$
DECLARE
    n_projects integer;
    n_lead_times integer;
    n_engineers integer;
BEGIN
    SELECT count(*) INTO n_projects FROM projects
     WHERE category IS NOT NULL
       AND category NOT IN ('A+', 'A', 'B', 'C', 'A-OEM', 'B-OEM', 'C-OEM');
    SELECT count(*) INTO n_lead_times FROM workflow_lead_times
     WHERE category NOT IN ('A+', 'A', 'B', 'C', 'A-OEM', 'B-OEM', 'C-OEM');
    SELECT count(*) INTO n_engineers FROM engineers
     WHERE EXISTS (
        SELECT 1 FROM unnest(allowed_categories) AS e
         WHERE e IS NULL
            OR e NOT IN ('A+', 'A', 'B', 'C', 'OEM', 'A-OEM', 'B-OEM', 'C-OEM'));
    IF n_projects + n_lead_times + n_engineers > 0 THEN
        RAISE EXCEPTION
            'p33a_categories downgrade refused: non-seeded categories in use '
            '(projects %, workflow_lead_times rows %, engineers %)',
            n_projects, n_lead_times, n_engineers;
    END IF;
END
$$;
"""


def downgrade() -> None:
    op.execute(_DOWNGRADE_GUARD)

    op.execute("DROP TRIGGER IF EXISTS trg_engineers_allowed_categories_known ON engineers")
    op.execute("DROP FUNCTION IF EXISTS rpd_engineers_allowed_categories_known()")
    op.execute("DROP TRIGGER IF EXISTS trg_projects_category_matches_hub ON projects")

    op.drop_constraint(_FK_LEAD_TIMES, "workflow_lead_times", type_="foreignkey")
    op.drop_constraint(_FK_PROJECTS, "projects", type_="foreignkey")

    op.execute(
        "CREATE TYPE project_category AS ENUM "
        "('A+', 'A', 'B', 'C', 'A-OEM', 'B-OEM', 'C-OEM')"
    )
    op.execute(
        "CREATE TYPE engineer_allowed_category AS ENUM "
        "('A+', 'A', 'B', 'C', 'OEM', 'A-OEM', 'B-OEM', 'C-OEM')"
    )
    op.execute(
        "ALTER TABLE projects ALTER COLUMN category TYPE project_category "
        "USING category::project_category"
    )
    op.execute(
        "ALTER TABLE workflow_lead_times ALTER COLUMN category TYPE project_category "
        "USING category::project_category"
    )
    op.execute(
        "ALTER TABLE engineers ALTER COLUMN allowed_categories TYPE engineer_allowed_category[] "
        "USING allowed_categories::engineer_allowed_category[]"
    )

    op.execute(_PROJECTS_TRIGGER_FN_P9)
    op.execute(_PROJECTS_TRIGGER)

    op.execute("DROP INDEX IF EXISTS ux_categories_code_lower")
    op.drop_table("categories")
