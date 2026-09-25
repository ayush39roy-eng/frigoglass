"""Minimal async SQLAlchemy engine/session wiring for the FastAPI app.

This is the first runnable API code in the repo (P1-T04) — the pattern
established here (env-var DSN via `RPD_DATABASE_URL`, lazily-created async
engine, request-scoped `AsyncSession` FastAPI dependency) mirrors
`backend/alembic/env.py` and `backend/seed/seed_demo_data.py`'s existing
convention, and is what P3's full app is expected to build directly on top
of rather than re-inventing its own DB wiring.
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def _database_url() -> str:
    url = os.environ.get("RPD_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "RPD_DATABASE_URL is not set (async postgresql+asyncpg:// DSN). "
            "See backend/alembic/env.py / backend/seed/seed_demo_data.py for the same convention."
        )
    return url


# Module-level, lazily-initialised singletons rather than created at import
# time — importing `api.db` (e.g. for its dependency function, in a test)
# must not require RPD_DATABASE_URL to already be set.
_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(_database_url())
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _session_factory


async def get_db() -> AsyncGenerator[AsyncSession]:
    """FastAPI dependency: yields a request-scoped `AsyncSession`.

    Usage: `db: AsyncSession = Depends(get_db)` on any endpoint that touches
    the database.
    """
    session_factory = get_session_factory()
    async with session_factory() as session:
        yield session


async def dispose_engine() -> None:
    """Called from the app's lifespan shutdown so the connection pool closes
    cleanly instead of leaking connections on process exit.
    """
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None
