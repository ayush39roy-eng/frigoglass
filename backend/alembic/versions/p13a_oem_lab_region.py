"""OEM hubs run from Greece, not India (client correction, 2026-10-13).

Data-only migration for databases seeded before the correction. Fresh seeds
get the same values from `domain_constants.HUB_LAB_REGION` / `CHAMBER_SEED`.

- `hubs.lab_region` becomes `Greece` for `OEM-HCK` and `OEM-Seltek`. The
  OEM hubs therefore book Greece chambers and count in the Europe area.
- OEM lab-step eligibility moves with them. Greece chambers gain `OEM-E`
  where they host `PDD-F` (POC) and `OEM-H` where they host `PDD-H` (CERT).
  India chambers lose `OEM-E`/`OEM-H`, because no India hub follows the OEM
  workflow any more. Without this, an OEM lab step would have no eligible
  chamber and the project would be LEFT_OUT.
- Every schedulable OEM-hub project gets `schedule_stale = true`. Its input
  changed (ADR 0006), and as always nothing is re-solved automatically.

Like the earlier data migrations (P9-T01), this writes no audit rows. The
change is recorded in docs/MEMORY.md. Downgrade restores the India mapping
by the same analogy rule.

Revision ID: p13a_oem_lab_region
Revises: p12b_vip_checkins
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "p13a_oem_lab_region"
down_revision: str | Sequence[str] | None = "p12b_vip_checkins"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OEM_HUBS = "('OEM-HCK', 'OEM-Seltek')"
_SCHEDULABLE = "('In Buyoff', 'Under Industrialization', 'In Development', 'In Queue')"


def _move_oem_stages(to_region: str, from_region: str) -> None:
    op.execute(
        f"""
        UPDATE chambers
        SET allowed_stages = array_remove(array_remove(allowed_stages, 'OEM-E'), 'OEM-H')
        WHERE lab_region = '{from_region}'
        """
    )
    op.execute(
        f"""
        UPDATE chambers
        SET allowed_stages = array_append(allowed_stages, 'OEM-E')
        WHERE lab_region = '{to_region}'
          AND 'PDD-F' = ANY(allowed_stages)
          AND NOT ('OEM-E' = ANY(allowed_stages))
        """
    )
    op.execute(
        f"""
        UPDATE chambers
        SET allowed_stages = array_append(allowed_stages, 'OEM-H')
        WHERE lab_region = '{to_region}'
          AND 'PDD-H' = ANY(allowed_stages)
          AND NOT ('OEM-H' = ANY(allowed_stages))
        """
    )


def _set_oem_region(region: str) -> None:
    op.execute(f"UPDATE hubs SET lab_region = '{region}' WHERE name IN {_OEM_HUBS}")
    op.execute(
        f"""
        UPDATE projects SET schedule_stale = true
        WHERE status IN {_SCHEDULABLE}
          AND hub_id IN (SELECT id FROM hubs WHERE name IN {_OEM_HUBS})
        """
    )


def upgrade() -> None:
    _set_oem_region("Greece")
    _move_oem_stages(to_region="Greece", from_region="India")


def downgrade() -> None:
    _set_oem_region("India")
    _move_oem_stages(to_region="India", from_region="Greece")
