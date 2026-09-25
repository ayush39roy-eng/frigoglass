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
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    currency_code: CurrencyCode
    #: Multiply a EUR amount by this to get the given currency, per
    #: docs/DOMAIN_RULES.md "Currency" (`EUR = 1.0, USD = 1.08, INR = 97`).
    #: `float` here matches `CurrencyRate.rate_to_eur`'s own `Mapped[float]`
    #: annotation (backend/models/currency.py) even though the underlying
    #: column is `Numeric(10, 4)` — Pydantic v2 coerces a driver-returned
    #: `Decimal` into `float` on validation.
    rate_to_eur: float
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

    rate_to_eur: float = Field(
        gt=0,
        description="New rate: multiply a EUR amount by this to get the given currency.",
    )
