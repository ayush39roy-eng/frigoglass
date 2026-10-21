"""Currency rate lookups (docs/DOMAIN_RULES.md "Currency"; P21-T01).

Rates live in the `currency_rates` config table, never in code. A row whose
`rate_to_eur` is NULL is "not configured" (EGP / ZAR / IDR are seeded that way,
no rate is invented); converting into it is a 422 `CURRENCY_NOT_CONFIGURED`.
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.errors import HTTP_422, CodedHTTPException
from models.currency import CurrencyRate
from models.enums import CurrencyCode
from schemas.currency import CurrencyRateRead

CURRENCY_NOT_CONFIGURED = "CURRENCY_NOT_CONFIGURED"


def currency_not_configured(currency: CurrencyCode) -> CodedHTTPException:
    return CodedHTTPException(
        status_code=HTTP_422,
        code=CURRENCY_NOT_CONFIGURED,
        detail=(
            f"No exchange rate is configured for {currency.value}. "
            "A Super Admin can set one under currency rates."
        ),
    )


async def rate_to_eur(db: AsyncSession, currency: CurrencyCode) -> Decimal:
    """The configured multiplier for `currency` (EUR is always 1). Raises a 422
    `CURRENCY_NOT_CONFIGURED` when the row is missing or its rate is NULL."""

    if currency == CurrencyCode.EUR:
        return Decimal("1.0")
    rate = (
        await db.execute(select(CurrencyRate).where(CurrencyRate.currency_code == currency))
    ).scalar_one_or_none()
    if rate is None or rate.rate_to_eur is None:
        raise currency_not_configured(currency)
    return Decimal(str(rate.rate_to_eur))


def currency_rate_read(rate: CurrencyRate) -> CurrencyRateRead:
    code = rate.currency_code.value
    return CurrencyRateRead(
        id=rate.id,
        currency_code=rate.currency_code,
        name=dc.CURRENCY_NAMES.get(code, code),
        rate_to_eur=float(rate.rate_to_eur) if rate.rate_to_eur is not None else None,
        configured=rate.rate_to_eur is not None,
        updated_by_user_id=rate.updated_by_user_id,
        updated_at=rate.updated_at,
    )
