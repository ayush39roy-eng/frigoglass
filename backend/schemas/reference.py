"""Read-only response models for reference/lookup data (`Hub`,
`WorkflowStepTemplate`) — seeded once (P1-T03), not user-editable in v1.
Shared across every surface's dropdowns/labels (hub pickers on Project
Registration and Capacity Planning; step names on the Gantt).
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict

from models.enums import HubName, LabRegion, ProjectType, WorkflowStepKind


class HubRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: HubName
    lab_region: LabRegion
    is_oem: bool
    #: P29 (ADR 0042): the hub whose engineers, calendar and design supply
    #: serve this hub (R&D-Greece for OEM-HCK and OEM-Seitek); null when the
    #: hub is its own capacity hub.
    capacity_hub_id: uuid.UUID | None
    #: The name of that capacity hub; null with `capacity_hub_id`.
    capacity_hub_name: HubName | None


class WorkflowStepTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    #: 2026-09-27 (ADR 0007/0009): two workflows, client codes, three kinds,
    #: configurable predecessors. Durations are not on the template any more —
    #: they come from the lead-time table (Workflow Settings, P9-T03).
    id: str
    workflow_id: str
    code: str
    name: str
    kind: WorkflowStepKind
    sequence_order: int
    predecessor_ids: list[str]


class ProjectTypeRead(BaseModel):
    """P29-T04 (ADR 0038 amendment 2026-10-22): one project type and its
    display label, from `domain_constants.PROJECT_TYPE_LABELS` (`RC` reads
    "Regulatory / Business Compliance")."""

    code: ProjectType
    label: str
