"""P37-T05 (built at P53-T03): the Celery beat entry of the weekly rollover
(DOMAIN_RULES "Weekly rollover run", R37-9). The 15-minute entry is the
guarantee; Mondays 00:05 Europe/Athens is the prompt one. The decision lives
in `services.week_rollover.ensure_week_rollover` (idempotent, under the
dispatch lock), shared with the in-app ticker. Never CP-SAT.
"""

from __future__ import annotations

import asyncio
import logging
import os

from celery import Task
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from services.week_rollover import ensure_week_rollover
from workers.worker_app import worker_app

logger = logging.getLogger(__name__)

TASK_NAME = "workers.week_rollover_tasks.ensure_week_rollover_task"


async def _run() -> str:
    url = os.environ.get("RPD_DATABASE_URL")
    if not url:
        raise RuntimeError("RPD_DATABASE_URL is not set (async postgresql+asyncpg:// DSN).")
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            return await ensure_week_rollover(db)
    finally:
        await engine.dispose()


@worker_app.task(bind=True, name=TASK_NAME)
def ensure_week_rollover_task(self: Task) -> str:
    _ = self
    outcome = asyncio.run(_run())
    if outcome != "not_needed":
        logger.info("week rollover (beat): %s", outcome)
    return outcome
