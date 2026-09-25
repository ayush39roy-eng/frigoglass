"""First runnable FastAPI application code in this repo (P1-T04).

Everything in this package is intentionally minimal — a stub scoped to
P1-T04's acceptance criteria ("an Admin-role endpoint can update
[currency rates] (a stub endpoint is acceptable at this phase, full
RBAC/auth API arrives in P3-T02/T03)"). No OIDC, no RBAC middleware, no
hub-scoped row filtering, no SSE exist yet — those are P3's job
(`docs/IMPLEMENTATION_PLAN.md` P3-T02/T03 onward). The patterns established
here (env-var DSN, async engine, request-scoped `AsyncSession` dependency,
one Pydantic request/response model pair per endpoint, audit-log write on
every mutation) are what P3 builds directly on top of — see
`backend/api/db.py` and `backend/api/routers/currency_rates.py`.
"""
