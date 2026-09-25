"""audit log truncate protection

Revision ID: ba3881d85b55
Revises: 419f196fd00b
Create Date: 2026-08-30 03:40:21.857007

P1-T07 remediation for the security-auditor's P1-T06 High finding: Postgres
row-level triggers (`BEFORE UPDATE OR DELETE ... FOR EACH ROW`, added by
419f196fd00b) do **not** fire on `TRUNCATE` -- `TRUNCATE` is a distinct
statement-level operation with its own trigger event type
(`BEFORE TRUNCATE ... FOR EACH STATEMENT`). Verified live before this fix:
against a fresh postgres:17 container, as the same DB role the app/migrations
use (not a more-privileged one), `UPDATE`/`DELETE` against `audit_log_entries`
were correctly rejected by the existing trigger, but
`TRUNCATE audit_log_entries;` succeeded unblocked and wiped the table to zero
rows. This migration closes that gap with a second, statement-level trigger.

Reuse-vs-sibling-function decision (per the orchestrator's explicit framing
of this task): a **sibling function** (`audit_log_entries_reject_truncate`)
is used here rather than reusing/overloading the existing
`audit_log_entries_reject_mutation()` function. Reasoning: a `TRUNCATE`
trigger fires with no `OLD`/`NEW` row bound at all -- those aren't merely
NULL, they are not available in a statement-level trigger context. The
existing function's message references `COALESCE(OLD.id, NULL)`, which would
need to become conditional on `TG_OP` to avoid touching `OLD` when invoked
from a statement-level context. That's possible in PL/pgSQL (`OLD` is only
evaluated if the branch referencing it actually executes, so an
`IF TG_OP = 'TRUNCATE' THEN ... ELSE ... OLD.id ... END IF` guard would work),
but it means one function silently serving two structurally different
trigger kinds (row-level vs statement-level), which is harder to audit at a
glance and easier to break by accident in a future edit (e.g. someone moves
the `OLD.id` reference outside the guard without realizing the function is
shared). A small, single-purpose sibling function -- doing exactly one thing,
with no `OLD`/`NEW` reference to reason about at all -- is safer and more
auditable, at the cost of two short functions instead of one. Both functions
still share the same design property that made a trigger the right primary
mechanism over a REVOKE in 419f196fd00b: enforcement holds for any DB role
that can reach the table, including the table owner, not just roles a GRANT/
REVOKE policy happens to have been kept in sync with.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ba3881d85b55'
down_revision: Union[str, Sequence[str], None] = '419f196fd00b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_AUDIT_TRUNCATE_TRIGGER_FN = "audit_log_entries_reject_truncate"
_AUDIT_TRUNCATE_TRIGGER_NAME = "trg_audit_log_entries_append_only_truncate"


def upgrade() -> None:
    """Upgrade schema."""
    # Statement-level trigger: rejects TRUNCATE unconditionally, for any role
    # that can reach this table, mirroring 419f196fd00b's UPDATE/DELETE
    # trigger's "regardless of DB role" design property. No OLD/NEW row
    # context exists for a statement-level TRUNCATE trigger, so this function
    # is deliberately self-contained rather than sharing
    # `audit_log_entries_reject_mutation()` -- see this file's module
    # docstring for the reuse-vs-sibling reasoning.
    op.execute(
        f"""
        CREATE FUNCTION {_AUDIT_TRUNCATE_TRIGGER_FN}() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION
                'audit_log_entries is append-only: TRUNCATE is not permitted'
                USING ERRCODE = '23001';
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER {_AUDIT_TRUNCATE_TRIGGER_NAME}
        BEFORE TRUNCATE ON audit_log_entries
        FOR EACH STATEMENT EXECUTE FUNCTION {_AUDIT_TRUNCATE_TRIGGER_FN}()
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(f"DROP TRIGGER IF EXISTS {_AUDIT_TRUNCATE_TRIGGER_NAME} ON audit_log_entries")
    op.execute(f"DROP FUNCTION IF EXISTS {_AUDIT_TRUNCATE_TRIGGER_FN}()")
