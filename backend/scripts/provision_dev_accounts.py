"""ADR 0058 L1: create or repair the two dev-mode test logins by hand.

The API already does this on startup in dev mode
(`services.dev_accounts.provision_dev_accounts_at_startup`). Run this when
the API is not restarted, for example after restoring a database:

    RPD_DEV_MODE=true RPD_DATABASE_URL=postgresql+asyncpg://... \\
        python -m scripts.provision_dev_accounts

Idempotent. Refuses to run unless `RPD_DEV_MODE` is on, like the startup hook.
Prints one line per account: `created`, `repaired` or `unchanged`.

Exit codes: 0 success, 2 not in dev mode or `RPD_DATABASE_URL` missing.
"""

from __future__ import annotations

import asyncio
import os
import sys

from api.db import dispose_engine, get_session_factory
from core.config import is_dev_mode
from services.dev_accounts import Outcome, provision_dev_accounts


async def run() -> dict[str, Outcome]:
    try:
        async with get_session_factory()() as session:
            outcomes = await provision_dev_accounts(session)
            await session.commit()
            return outcomes
    finally:
        await dispose_engine()


def main() -> int:
    if not is_dev_mode():
        print("refused: RPD_DEV_MODE is not on; the test logins exist only in dev mode")
        return 2
    if not os.environ.get("RPD_DATABASE_URL"):
        print("refused: RPD_DATABASE_URL is not set")
        return 2
    for username, outcome in asyncio.run(run()).items():
        print(f"{username}: {outcome}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
