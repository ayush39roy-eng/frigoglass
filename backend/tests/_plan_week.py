"""The test suite's plan week (P37-T04, ADR 0052 §3).

`tests/conftest.py` pins `RPD_CURRENT_WEEK=31` before anything is imported, so
`services.plan_clock.now().week` is 31 in every test that does not inject its
own clock. Fixtures that need the week as a value (a solver input, a hand-
worked figure) use `TEST_WEEK` instead of the retired `domain_constants.
CURRENT_WEEK`. `tests/test_p37_plan_clock.py` asserts the two agree.
"""

from __future__ import annotations

from typing import Final

TEST_WEEK: Final[int] = 31
