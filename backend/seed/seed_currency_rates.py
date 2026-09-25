"""P1-T04 — seed the three `currency_rates` rows (EUR/USD/INR) from
`domain_constants.CURRENCY_RATE_SEED`.

This is a deliberately SEPARATE, standalone seed entry point from
`backend/seed/seed_demo_data.py` (P1-T03) — that script's own module
docstring explicitly says "currency_rates — that is P1-T04's job, not this
script's," and docs/MEMORY.md's P1-T03 entry records the same boundary. This
task keeps that separation rather than retroactively folding currency
seeding into `seed_demo_data.py`.

Usage (from `backend/`, with a `.venv` that has this project's deps
installed):

    RPD_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/rpd \\
        python -m seed.seed_currency_rates [--reset]

`--reset` deletes existing `currency_rates` rows before reseeding — without
it, the script refuses to run if the table already has rows, matching
`seed_demo_data.py`'s duplicate-seed guard convention (fail loudly rather
than silently skip or silently duplicate).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Mirrors backend/alembic/env.py's / backend/seed/seed_demo_data.py's sys.path
# fallback so `import domain_constants` / `from models import ...` resolve
# regardless of the CWD this is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import domain_constants as dc  # noqa: E402
from models import CurrencyRate  # noqa: E402
from models.enums import CurrencyCode  # noqa: E402


def _database_url() -> str:
    url = os.environ.get("RPD_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "RPD_DATABASE_URL is not set (async postgresql+asyncpg:// DSN). "
            "See backend/alembic/env.py / backend/seed/seed_demo_data.py for the same convention."
        )
    return url


async def _row_count(session: AsyncSession) -> int:
    return await session.scalar(select(func.count()).select_from(CurrencyRate)) or 0


async def _guard_against_duplicate_seed(session: AsyncSession) -> None:
    count = await _row_count(session)
    if count:
        raise RuntimeError(
            f"currency_rates already has {count} row(s) — re-run with --reset "
            "to truncate first, or this script would create duplicates."
        )


async def run(reset_first: bool) -> dict:
    engine = create_async_engine(_database_url())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as session:
            if reset_first:
                await session.execute(delete(CurrencyRate))
                await session.flush()
            else:
                await _guard_against_duplicate_seed(session)

            for code, rate in dc.CURRENCY_RATE_SEED.items():
                session.add(CurrencyRate(currency_code=CurrencyCode(code), rate_to_eur=rate))

            await session.commit()

            # Post-commit verification: re-query the actual row count from the
            # DB rather than trusting the in-memory tally, matching
            # seed_demo_data.py's verification standard.
            verified = await _row_count(session)
    finally:
        await engine.dispose()
    return {
        "currency_rates": len(dc.CURRENCY_RATE_SEED),
        "_verified_from_db": {"currency_rates": verified},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Delete existing currency_rates rows before reseeding.",
    )
    args = parser.parse_args()
    counts = asyncio.run(run(reset_first=args.reset))
    print(json.dumps(counts, indent=2, default=str))


if __name__ == "__main__":
    main()
