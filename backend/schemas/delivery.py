"""Delivery by year on the wire (P53, ADR 0063 R53-3 / R53-9,
docs/API_CONTRACT_P53.md §4). Built only by `services.delivery_serving` from
`scheduling.delivery.delivery_by_year`; the browser derives nothing (I59)."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel

DeliveryRowKind = Literal["by_end_of_year", "year", "not_placed", "blocked"]
LeftOutReason = Literal["no_leader", "no_chamber", "data_error", "beyond_horizon"]
DeliveryUnavailable = Literal["pre_p53_run", "no_active_run"]


class LeftOutReasonCounts(BaseModel):
    no_leader: int
    no_chamber: int
    data_error: int
    beyond_horizon: int


class DeliveryRowOut(BaseModel):
    kind: DeliveryRowKind
    #: The calendar year; null on `not_placed` / `blocked`.
    year: int | None
    label: str
    #: `year > Y0 + 1` ("indicative").
    indicative: bool
    p1: int
    p2: int
    p3: int
    #: A counting project with another band (a Commercialized project
    #: delivered in Y0 whose band is P4 / Q / none). `p1 + p2 + p3 + other =
    #: total` in every row.
    other: int
    total: int
    #: Running totals from Y0 to this year; null on `not_placed` / `blocked`.
    cum_p1: int | None
    cum_p2: int | None
    cum_p3: int | None
    cum_other: int | None
    cum_total: int | None
    #: On `not_placed` only.
    left_out_reasons: LeftOutReasonCounts | None = None


class DeliveryByYearOut(BaseModel):
    #: The run's (or simulation's) input week.
    run_week: int
    #: Y0 = `year_of(run_week)`.
    base_year: int
    #: `year_end(Y0)` for live / What-if, u for a plan import.
    within_year_week: int
    horizon_weeks: int
    #: N; null when it cannot be derived (`horizon_weeks − run_week` not a
    #: positive multiple of 52).
    horizon_years: int | None
    rows: list[DeliveryRowOut]


class TailWarningsOut(BaseModel):
    """R53-9 counts only (Dashboard / Executive): no engineer names (OQ #8)."""

    far_finish_count: int
    leader_overloaded_count: int


class DeliveryDrillRow(BaseModel):
    project_id: uuid.UUID
    project_name: str
    hub: str
    band: str | None
    completion_week: int | None
    delivery_year: int | None
    far_finish: bool
    left_out_reason: LeftOutReason | None


class DeliveryDrillResponse(BaseModel):
    schedule_run_version: int | None
    kind: DeliveryRowKind
    year: int | None
    band: Literal["P1", "P2", "P3"] | None
    delivery_by_year_unavailable: DeliveryUnavailable | None = None
    rows: list[DeliveryDrillRow]
