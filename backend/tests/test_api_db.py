"""Direct coverage of `api/db.py`'s DB-wiring helpers
(`_database_url`, `get_engine`, `get_session_factory`, `get_db`,
`dispose_engine`) — not one of the 9 numbered scenarios, but part of
`backend/api/` (P1-T04 scope) and easy to exercise directly rather than only
incidentally via the currency-rates API tests (which override `get_db`
entirely and so never touch this module's own engine/session creation path).
"""

from __future__ import annotations

import importlib

import pytest


def test_database_url_raises_when_env_var_unset(monkeypatch):
    monkeypatch.delenv("RPD_DATABASE_URL", raising=False)
    import api.db as api_db

    with pytest.raises(RuntimeError, match="RPD_DATABASE_URL"):
        api_db._database_url()


async def test_get_engine_get_session_factory_get_db_and_dispose_round_trip(
    database_url, _apply_migrations, monkeypatch
):
    monkeypatch.setenv("RPD_DATABASE_URL", database_url)
    import api.db as api_db

    # Fresh module-level singleton state for this test.
    importlib.reload(api_db)
    try:
        engine = api_db.get_engine()
        assert engine is api_db.get_engine()  # lazy singleton, not re-created

        factory = api_db.get_session_factory()
        assert factory is api_db.get_session_factory()

        gen = api_db.get_db()
        session = await gen.__anext__()
        try:
            from sqlalchemy import text

            result = await session.execute(text("SELECT 1"))
            assert result.scalar_one() == 1
        finally:
            # Drain the generator so its own cleanup (`async with ... yield`)
            # runs, mirroring how FastAPI's dependency-injection teardown
            # would exhaust it after a request.
            try:
                await gen.__anext__()
            except StopAsyncIteration:
                pass
    finally:
        await api_db.dispose_engine()
        assert api_db._engine is None
        assert api_db._session_factory is None
