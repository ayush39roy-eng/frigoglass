"""Read-only response models for reference/lookup data (`Hub`,
`WorkflowStepTemplate`) — seeded once (P1-T03), not user-editable in v1.
Shared across every surface's dropdowns/labels (hub pickers on Project
Registration and Capacity Planning; step names on the Gantt).
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict

from models.enums import HubName, LabRegion, WorkflowStepKind


class HubRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: HubName
    lab_region: LabRegion
    is_oem: bool


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
