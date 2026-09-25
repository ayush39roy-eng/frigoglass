"""Read-only reference data: `GET /hubs`, `GET /workflow-step-templates`.

Both tables are seeded once (P1-T03) and are not user-editable in v1 — no
CRUD here on purpose, just the two GETs every surface's dropdowns/labels need
(hub pickers on Project Registration/Capacity Planning; the 14 PDD step
names/kinds on the Gantt).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from models.hub import Hub
from models.workflow import WorkflowStepTemplate
from schemas.reference import HubRead, WorkflowStepTemplateRead

router = APIRouter(tags=["reference"])


@router.get("/hubs", response_model=list[HubRead])
async def list_hubs(db: AsyncSession = Depends(get_db)) -> list[Hub]:
    """List all six hubs. Public within the app, no auth — same rationale as
    `GET /currency-rates` (P1-T04): reference/lookup data, not the
    project/financial data RBAC actually needs to gate (P3-T02/T03).
    """

    result = await db.execute(select(Hub).order_by(Hub.name))
    return list(result.scalars().all())


@router.get("/workflow-step-templates", response_model=list[WorkflowStepTemplateRead])
async def list_workflow_step_templates(
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowStepTemplate]:
    """List the 14 PDD workflow step templates, in sequence order."""

    result = await db.execute(
        select(WorkflowStepTemplate).order_by(WorkflowStepTemplate.sequence_order)
    )
    return list(result.scalars().all())
