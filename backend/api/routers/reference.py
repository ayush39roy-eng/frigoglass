"""Read-only reference data: `GET /hubs`, `GET /workflow-step-templates`,
`GET /reference/categories?hub_id=` (P9-T03).

Both tables are seeded once (P1-T03) and are not user-editable in v1 — no
CRUD here on purpose, just the two GETs every surface's dropdowns/labels need
(hub pickers on Project Registration/Capacity Planning; the 14 PDD step
names/kinds on the Gantt).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import get_current_principal
from models.enums import ProjectCategory
from models.hub import Hub
from models.project import category_allowed_for_hub
from models.workflow import WorkflowStepTemplate
from schemas.reference import HubRead, WorkflowStepTemplateRead

#: P9-R02 (security S-07, carried from P3-T08 #5): any authenticated
#: principal. No surface permission: every role needs these labels.
router = APIRouter(tags=["reference"], dependencies=[Depends(get_current_principal)])


@router.get("/hubs", response_model=list[HubRead])
async def list_hubs(db: AsyncSession = Depends(get_db)) -> list[Hub]:
    """List all six hubs. Any authenticated principal (P9-R02, S-07); no
    surface permission, since every role needs hub labels.
    """

    result = await db.execute(select(Hub).order_by(Hub.name))
    return list(result.scalars().all())


@router.get("/workflow-step-templates", response_model=list[WorkflowStepTemplateRead])
async def list_workflow_step_templates(
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowStepTemplate]:
    """List the workflow step templates of both workflows (28 rows since
    P9-T01), ordered by workflow and then sequence order.
    """

    result = await db.execute(
        select(WorkflowStepTemplate).order_by(
            WorkflowStepTemplate.workflow_id, WorkflowStepTemplate.sequence_order
        )
    )
    return list(result.scalars().all())


@router.get("/reference/categories", response_model=list[ProjectCategory])
async def list_categories_for_hub(
    hub_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[ProjectCategory]:
    """The project categories valid for this hub's workflow (docs/API_CONTRACT_P9.md
    §6): `A+/A/B/C` for a PDD hub, `A-OEM/B-OEM/C-OEM` for an OEM hub, in the
    scheduling order of DOMAIN_RULES "Scheduling order". Uses the same rule as
    project validation (`models.project.category_allowed_for_hub`). Any
    authenticated principal, like `GET /hubs`. 404 for an unknown hub.
    """

    hub = await db.get(Hub, hub_id)
    if hub is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown hub")
    return [c for c in ProjectCategory if category_allowed_for_hub(hub.is_oem, c)]
