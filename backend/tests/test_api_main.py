"""Direct coverage of `api/main.py`'s app-level wiring: the `/healthz`
endpoint and the lifespan shutdown hook (which calls `dispose_engine`).
"""

from __future__ import annotations

from httpx import ASGITransport, AsyncClient

from api.main import app


async def test_healthz_returns_ok():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


async def test_app_lifespan_disposes_engine_on_shutdown(
    monkeypatch, database_url, _apply_migrations
):
    """Running the ASGI app through a full startup/shutdown cycle (via
    `AsyncClient`'s `lifespan="on"` transport... httpx's `ASGITransport`
    doesn't run lifespan by default, so this drives it directly) exercises
    `api/main.py`'s `lifespan()` context manager, in particular its shutdown
    call to `dispose_engine()`.
    """
    monkeypatch.setenv("RPD_DATABASE_URL", database_url)
    import api.db as api_db

    async with app.router.lifespan_context(app):
        # Touch the engine so there's something real to dispose.
        api_db.get_engine()
    assert api_db._engine is None
