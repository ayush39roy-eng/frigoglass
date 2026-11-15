"""Retired: `PATCH /projects/{project_id}/steps/{step_id}/timing`
(ADR 0048 §2; docs/API_CONTRACT_P33.md Part G, P33-T13).

Per-project step timing editing (the Gantt drag, ADR 0019; the overlap
gesture, ADR 0043) is retired: the category template is the one timing tool
(ADR 0045/0046). For one release the route answers **410** with code
`STEP_TIMING_RETIRED` to every authenticated caller, whatever the body; it
writes nothing, reads no project (so it reveals nothing about one) and
dispatches no run. Without a session it is still 401. P33-F01 removes it.
It is not kept as an internal path: the template apply writes per-project
copies through its own service.
"""

from __future__ import annotations

from typing import NoReturn

from fastapi import APIRouter, Depends, status

from api.deps import get_current_principal
from api.errors import CodedHTTPException
from core.principal import Principal
from schemas.step_timing import (
    STEP_TIMING_RETIRED,
    STEP_TIMING_RETIRED_MESSAGE,
    StepTimingRetiredError,
)

router = APIRouter(tags=["gantt"])


@router.patch(
    "/projects/{project_id}/steps/{step_id}/timing",
    status_code=status.HTTP_410_GONE,
    response_model=None,
    responses={status.HTTP_410_GONE: {"model": StepTimingRetiredError}},
    deprecated=True,
    summary="Retired (ADR 0048): always 410 STEP_TIMING_RETIRED",
)
async def set_step_timing(
    project_id: str,
    step_id: str,
    _principal: Principal = Depends(get_current_principal),
) -> NoReturn:
    raise CodedHTTPException(status.HTTP_410_GONE, STEP_TIMING_RETIRED, STEP_TIMING_RETIRED_MESSAGE)
