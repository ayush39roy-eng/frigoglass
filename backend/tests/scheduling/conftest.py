"""Fixtures for the `backend/scheduling/` pytest suite (P2-T05 golden files +
P2-T09 ported self-tests).

Two things happen here:

1. `_apply_migrations` (a session-scoped autouse fixture defined in the parent
   `tests/conftest.py`, which spins up a `testcontainers` Postgres) is
   overridden with a no-op for this subpackage. The scheduling engine is a
   pure `dataclass -> dataclass` function with no DB/network/filesystem access
   (see `backend/scheduling/__init__.py`'s purity contract), so these tests
   must not require Docker/Postgres. In the full `pytest` run the parent
   fixture still starts the container for the DB-backed tests elsewhere; this
   override only affects tests collected under `tests/scheduling/`.

2. `drive_selftest` — the adapter that runs one `scenario_*` / `direction*_*`
   function from a `backend/scheduling/_selftest*` module as a real pytest
   assertion. Those informal scripts accumulate failures into a module-level
   `FAILURES` list via a `check(label, condition)` helper instead of raising;
   this fixture clears that list, runs the scenario, and fails the test with
   the collected labels if any check returned False. This is how P2-T09 ports
   the five `_selftest_*` scripts into pytest without rewriting several hundred
   hand-verified `check(...)` calls into `assert` statements (which would risk
   silently dropping assertion coverage). The `_selftest_*` scripts are kept
   in place as `python -m scheduling._selftest*` entry points — other agents
   and MEMORY.md entries reference them — and are the single source of the
   scenario bodies these tests drive.
"""

from __future__ import annotations

from collections.abc import Callable
from types import ModuleType

import pytest


@pytest.fixture(scope="session", autouse=True)
def _apply_migrations() -> None:  # noqa: PT004 - overrides parent tests/conftest.py fixture
    """No-op override: scheduling tests are pure and need no Postgres."""
    return None


@pytest.fixture
def drive_selftest() -> Callable[[ModuleType, Callable[[], None]], None]:
    def _run(module: ModuleType, scenario: Callable[[], None]) -> None:
        module.FAILURES.clear()
        try:
            scenario()
            failed = list(module.FAILURES)
        finally:
            module.FAILURES.clear()
        assert not failed, (
            f"{module.__name__}.{scenario.__name__} — "
            f"{len(failed)} check(s) failed:\n  - " + "\n  - ".join(failed)
        )

    return _run
