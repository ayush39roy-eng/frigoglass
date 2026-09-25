"""Framework-agnostic backend infrastructure shared across the FastAPI app and
(eventually) Celery workers — settings, OIDC token verification, and the RBAC
role/permission table. Deliberately kept independent of `api/` (no FastAPI
imports in this package) so `backend/scheduling/`-adjacent worker processes
(P3-T06) can reuse `core.oidc`/`core.rbac` without importing the ASGI app.
"""

from __future__ import annotations
