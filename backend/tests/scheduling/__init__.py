"""P2-T05 — permanent golden-file / invariant-negative-path pytest suite for
`backend/scheduling/`.

Replaces `tests/oracle/` (the temporary P2-T02/T03 differential-oracle
scaffolding, deleted as part of this task per `docs/IMPLEMENTATION_PLAN.md`)
as the permanent correctness test suite for the scheduling engine.

Owned by `qa-inspector` by convention (pytest test files under
`backend/tests/` are qa-inspector's territory), even though this particular
suite was authored by `algorithm-engineer` per this task's explicit
delegation — see `docs/MEMORY.md`'s P2-T05 entry.

Structure:
  - `test_golden_files.py` — one test function per named `docs/DOMAIN_RULES.md`
    rule, each a small (2-3 project, 1-2 step) hand-constructed scenario
    asserting both (a) the scheduler produces the documented outcome and
    (b) `validate_invariants` reports zero violations on that output.
  - `test_invariants_negative.py` — one test per invariant (I1-I10) confirming
    `validate_invariants` catches a deliberately-broken hand-crafted
    `ScheduleOutput`, adapted from `scheduling/_selftest_invariants.py`'s
    "Direction 2" library.

Adapted from (not re-derived from scratch): `backend/scheduling/_selftest.py`
(P2-T01) and `backend/scheduling/_selftest_invariants.py` (P2-T04), both of
which remain in place as informal engineering self-tests — this package is
the formal, CI-run replacement for `tests/oracle/`'s role, not a replacement
for those two scripts.
"""
