from __future__ import annotations

import uuid

from sqlalchemy import Enum, ForeignKey, Numeric
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import CurrencyCode


class CurrencyRate(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Currency conversion rates, base EUR, per docs/DOMAIN_RULES.md
    "Currency": "Rates must be configurable at runtime, not hardcoded constants
    — store them in a config table, not in code." This table is that config
    table; `domain_constants.CURRENCY_RATE_SEED` holds only the documented v1
    seed values for P1-T03/P1-T04 to load, not a runtime source of truth.

    Full P1-T04 scope (Admin-role update endpoint, seeding) is a separate task;
    this model just needs to exist so P1-T02's migration can create the table
    and P1-T04 has something to seed/expose.
    """

    __tablename__ = "currency_rates"

    currency_code: Mapped[CurrencyCode] = mapped_column(
        Enum(
            CurrencyCode,
            name="currency_code",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        unique=True,
        nullable=False,
    )
    #: Multiply a EUR amount by this to get the given currency, per
    #: DOMAIN_RULES.md's `EUR = 1.0, USD = 1.08, INR = 97` convention.
    rate_to_eur: Mapped[float] = mapped_column(Numeric(10, 4), nullable=False)

    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        code = self.currency_code.value if self.currency_code else None
        return f"<CurrencyRate {code}={self.rate_to_eur}>"
