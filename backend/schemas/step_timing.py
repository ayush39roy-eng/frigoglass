"""Retired: per-project step timing (ADR 0019 / ADR 0043 editing, retired by
ADR 0048; docs/API_CONTRACT_P33.md Part G).

`PATCH /projects/{project_id}/steps/{step_id}/timing` answers 410
`STEP_TIMING_RETIRED` for one release (P33-T13), then is removed (P33-F01).
The request and response models of the old endpoint are gone. The What-if
and plan-import scenarios keep their own timing fields
(`schemas.whatif_import`), which are never persisted.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

#: The code of the 410 answer (contract P33 Part H).
STEP_TIMING_RETIRED = "STEP_TIMING_RETIRED"

#: The 410 message (contract P33 Part G, verbatim).
STEP_TIMING_RETIRED_MESSAGE = (
    "Per-project step timing was retired; edit the category template on Workflow templates."
)


class StepTimingRetiredError(BaseModel):
    """The 410 body: the coded error envelope (`api.errors`)."""

    detail: str
    code: Literal["STEP_TIMING_RETIRED"]
