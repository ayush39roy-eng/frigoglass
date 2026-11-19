"""Read-only reference data: `GET /hubs`, `GET /workflow-step-templates`,
`GET /reference/categories[?hub_id=]` (P9-T03; objects from the `categories`
table since P33-T07), `GET /reference/project-types`
(P29-T04).

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

import domain_constants as dc
from api.db import get_db
from api.deps import get_current_principal
from models.enums import ProjectPriority, ProjectType
from models.hub import Hub
from models.project import workflow_id_for_hub
from models.workflow import WorkflowStepTemplate
from scheduling.weeks import queue_tier
from schemas.category import CategoryRead
from schemas.reference import (
    HubRead,
    PriorityBandRead,
    ProjectTypeRead,
    WorkflowStepTemplateRead,
)
from services.categories import load_catalog

#: P9-R02 (security S-07, carried from P3-T08 #5): any authenticated
#: principal. No surface permission: every role needs these labels.
router = APIRouter(tags=["reference"], dependencies=[Depends(get_current_principal)])


@router.get("/hubs", response_model=list[HubRead])
async def list_hubs(db: AsyncSession = Depends(get_db)) -> list[HubRead]:
    """List all six hubs. Any authenticated principal (P9-R02, S-07); no
    surface permission, since every role needs hub labels.

    P29 (ADR 0042): each hub carries `capacity_hub_id` / `capacity_hub_name`
    (R&D-Greece for OEM-HCK and OEM-Seitek, null otherwise).
    """

    hubs = list((await db.execute(select(Hub).order_by(Hub.name))).scalars().all())
    names = {h.id: h.name for h in hubs}
    return [
        HubRead(
            id=h.id,
            name=h.name,
            lab_region=h.lab_region,
            is_oem=h.is_oem,
            capacity_hub_id=h.capacity_hub_id,
            capacity_hub_name=names.get(h.capacity_hub_id) if h.capacity_hub_id else None,
        )
        for h in hubs
    ]


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


@router.get("/reference/categories", response_model=list[CategoryRead])
async def list_categories(
    hub_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
) -> list[CategoryRead]:
    """The project categories (contract P33 B1, ADR 0047), from the
    `categories` table, ordered by `rank` (scheduling order key 5): one
    `{code, label, workflow_id, rank}` object each.

    With `hub_id`: only the categories of that hub's workflow (the same rule
    as project validation, `models.project.category_allowed_for_hub`); 404
    for an unknown hub. Without it: every category. Any authenticated
    principal, like `GET /hubs`; reference data, nothing hub-scoped.

    P33-T07 breaking change: this used to be a list of code strings and
    required `hub_id`.
    """

    catalog = await load_catalog(db)
    rows = catalog.rows
    if hub_id is not None:
        hub = await db.get(Hub, hub_id)
        if hub is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown hub")
        wanted = workflow_id_for_hub(hub.is_oem)
        rows = tuple(r for r in rows if r.workflow_id == wanted)
    return [
        CategoryRead(code=r.code, label=r.label, workflow_id=r.workflow_id, rank=r.rank)
        for r in rows
    ]


@router.get("/reference/project-types", response_model=list[ProjectTypeRead])
async def list_project_types() -> list[ProjectTypeRead]:
    """P29-T04 (ADR 0038 amendment): every project type with its label, in
    `ProjectType` order. `RC` is "Regulatory / Business Compliance" (the
    client's `BC`). Any authenticated principal, like `GET /hubs`."""

    return [ProjectTypeRead(code=t, label=dc.PROJECT_TYPE_LABELS[t.value]) for t in ProjectType]


@router.get("/reference/priorities", response_model=list[PriorityBandRead])
async def list_priorities() -> list[PriorityBandRead]:
    """P42 (ADR 0056 R42-1): the five bands with their labels, in
    `PRIORITY_ORDER`. Any authenticated principal, like `GET /hubs`."""

    return [
        PriorityBandRead(
            code=ProjectPriority(code),
            label=dc.PRIORITY_LABELS[code],
            short_label=code,
            not_scheduled=code in dc.NOT_SCHEDULED_PRIORITIES,
            # P53 (R53-2): the scheduling tier (Board "Queued" badge), not
            # counting: a queued P3 counts since P53.
            queued_when_in_queue=queue_tier(code, dc.QUEUED_STATUS),
        )
        for code in dc.PRIORITY_ORDER
    ]
