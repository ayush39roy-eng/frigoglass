"""FastAPI routers. One module per resource, mirroring the pattern set in
`backend/api/routers/currency_rates.py` (P1-T04) — a Pydantic request model
and a Pydantic response model per endpoint, DB access via
`api.db.get_db`, every mutation writes a `models.audit.AuditLogEntry`.
"""
