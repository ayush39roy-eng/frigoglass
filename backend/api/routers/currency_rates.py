"""`GET /currency-rates` and `PUT /currency-rates/{currency_code}` — the
config-table-backed currency rate endpoints from
`docs/IMPLEMENTATION_PLAN.md` P1-T04, per `docs/DOMAIN_RULES.md` "Currency"
("Rates must be configurable at runtime, not hardcoded constants — store
them in a config table, not in code").

Rows come from `models.currency.CurrencyRate` (the config table; created by
P1-T02's migration, seeded by `backend/seed/seed_currency_rates.py`).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_roles
from core.principal import Principal
from models.audit import AuditLogEntry
from models.currency import CurrencyRate
from models.enums import CurrencyCode, RoleName
from schemas.currency import CurrencyRateRead, CurrencyRateUpdateRequest

router = APIRouter(prefix="/currency-rates", tags=["currency-rates"])

_admin_only = require_roles(RoleName.ADMIN)


@router.get("", response_model=list[CurrencyRateRead])
async def list_currency_rates(db: AsyncSession = Depends(get_db)) -> list[CurrencyRate]:
    """List all currency rates. Public within the app — reading currency
    rates needs no auth per P1-T04's acceptance criteria (only the *update*
    endpoint below needs an Admin-role gate, and that gate doesn't exist yet
    either — see its docstring). Real API-wide auth (OIDC login flow) is
    P3-T02; RBAC + hub-scoped row filtering is P3-T03.
    """
    result = await db.execute(select(CurrencyRate).order_by(CurrencyRate.currency_code))
    return list(result.scalars().all())


@router.put("/{currency_code}", response_model=CurrencyRateRead)
async def update_currency_rate(
    currency_code: CurrencyCode,
    body: CurrencyRateUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_admin_only),
) -> CurrencyRate:
    """Update `rate_to_eur` for one currency.

    **RBAC (P3-T02)**: requires a validated OIDC token (401) and
    `RoleName.ADMIN` (403 otherwise) — fulfils this endpoint's own
    `docs/MEMORY.md` P1-T04 note ("MUST-FIX BEFORE P3 CLOSES: wire real
    Admin-role enforcement"). Currency rates are a portfolio-wide config
    value with no natural hub owner and no dedicated matrix row (they aren't
    one of `docs/PROJECT_AND_STACK.md` §5's eight surfaces), so Admin-only —
    not hub-scoped, since there is no hub to scope it to — is the correct
    (and the already-documented) target, not an interpretation made fresh
    here.
    """
    result = await db.execute(
        select(CurrencyRate).where(CurrencyRate.currency_code == currency_code)
    )
    rate = result.scalar_one_or_none()
    if rate is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No currency_rates row for currency_code={currency_code.value!r}",
        )

    before_state = {"currency_code": rate.currency_code.value, "rate_to_eur": str(rate.rate_to_eur)}
    rate.rate_to_eur = body.rate_to_eur
    # `CurrencyRate.updated_by_user_id` (P1-T02 model) was never set by
    # P1-T04's original stub endpoint (no authenticated actor existed yet).
    # Now that one does, wire it up alongside the audit row — the column was
    # clearly modelled for exactly this, not left permanently null.
    rate.updated_by_user_id = current_user.user_id
    after_state = {"currency_code": rate.currency_code.value, "rate_to_eur": str(rate.rate_to_eur)}

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="currency_rate.update",
            entity_type="CurrencyRate",
            entity_id=str(rate.id),
            hub_id=None,
            before_state=before_state,
            after_state=after_state,
        )
    )
    await db.commit()
    await db.refresh(rate)
    return rate
