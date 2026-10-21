"""Pydantic request/response models for the currency-rates endpoints
(`backend/api/routers/currency_rates.py`), per CLAUDE.md's "every endpoint
gets a Pydantic request model and a Pydantic response model. No untyped
`dict` passthrough."
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.enums import CurrencyCode


class CurrencyRateRead(BaseModel):
    """Response model — one row of `backend/models/currency.py::CurrencyRate`.

    Used both for `GET /currency-rates` (a list of these) and as the
    response body of `PUT /currency-rates/{currency_code}` (the updated row).

    P21-T01 (docs/API_CONTRACT_P21.md §1): `name` and `configured` are added;
    `rate_to_eur` is nullable (`null` = not configured). The currency code is
    the existing `currency_code` field (not duplicated as `code`).
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    currency_code: CurrencyCode
    #: Display name, e.g. "Egyptian pound" (`domain_constants.CURRENCY_NAMES`).
    name: str
    #: Multiply a EUR amount by this to get the given currency, per
    #: docs/DOMAIN_RULES.md "Currency". `null` when no rate is configured.
    #: Pydantic v2 coerces a driver-returned `Decimal` into `float`.
    rate_to_eur: float | None
    #: `rate_to_eur is not None`. Converting into an unconfigured currency is a
    #: 422 `CURRENCY_NOT_CONFIGURED`.
    configured: bool
    updated_by_user_id: uuid.UUID | None
    updated_at: datetime


class CurrencyRateUpdateRequest(BaseModel):
    """Request body for `PUT /currency-rates/{currency_code}`."""

    # `extra="forbid"` for consistency with every other P3 request model
    # (the convention P3-T01 established); an unknown field in the PUT body is
    # now a 422 rather than a silent no-op. No behavioural change for any
    # current caller — the router reads `body.rate_to_eur` explicitly and
    # every test sends only that field (security finding #8, P3-T08).
    model_config = ConfigDict(extra="forbid")

    #: P21-T01: positive, bounded to the column (`Numeric(10, 4)`: at least
    #: 0.0001 so it never rounds to 0, below 1,000,000) and finite, so an
    #: out-of-range or non-finite value is a 422, never a 500 at flush.
    rate_to_eur: float = Field(
        ge=0.0001,
        lt=1_000_000,
        allow_inf_nan=False,
        description="New rate: multiply a EUR amount by this to get the given currency.",
    )
