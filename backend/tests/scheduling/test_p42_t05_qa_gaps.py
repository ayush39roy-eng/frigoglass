"""P42-T05 (qa-inspector) — gap tests for ADR 0056 / DOMAIN_RULES "Priority band meaning".

The P42-T02 suite covers non-frozen P4/Q (VIP or not) and a frozen non-VIP P4. These add the
combinations the gate checklist names that were not asserted directly:

- R42-2 + R42-3: a frozen **Q** books its locked capacity and never counts, like a frozen P4;
  a frozen **VIP** P4/Q does the same (VIP changes nothing, I49 last bullet).
- R42-3: a started (In Development) non-frozen VIP **Q** is not scheduled (status is not an
  escape, VIP is not an escape).
- R42-4: a frozen **queued P3** (In Queue) books its locked capacity with
  `counts_toward_year = false` (frozen does not change the flag), never within year or spillover.

Both solvers, I49-I51 via `validate_invariants`. Pure, in-process; no DB.
"""

from __future__ import annotations

import pytest

from scheduling import run_cp_sat, run_greedy_sgs, validate_invariants
from scheduling._selftest_common import SELFTEST_WEEK
from tests.scheduling._fixtures import base_project, progress
from tests.scheduling.test_p42_band_meaning import CP_KW, _assert_not_scheduled, _by, _si, _step


def _solvers(si):
    return (run_greedy_sgs(si), run_cp_sat(si, **CP_KW)[0])


@pytest.mark.parametrize("band", ["P4", "Q"])
@pytest.mark.parametrize("vip", [False, True])
def test_frozen_p4_or_q_books_and_never_counts_vip_or_not(band: str, vip: bool) -> None:
    frozen = base_project(
        project_id="f",
        priority=band,
        is_vip=vip,
        frozen=True,
        actual_start_week=SELFTEST_WEEK,
    )
    p1 = base_project(project_id="p1", priority="P1")
    si = _si(frozen, p1)
    for out in _solvers(si):
        b = _by(out)
        f = b["f"]
        assert not f.excluded and not f.not_scheduled_priority
        assert not f.counts_toward_year
        assert not f.within_year and not f.spillover
        assert f.steps and f.projected_end_week is not None
        assert _step(f, "PDD-A").start_week == SELFTEST_WEEK
        # Locked design weeks are booked on eng-a: the P1 waits.
        assert _step(b["p1"], "PDD-A").start_week > _step(f, "PDD-A").end_week
        assert out.scheduling_order[0] == "f"
        assert b["p1"].counts_toward_year
        assert validate_invariants(si, out, check_determinism=False) == ()


def test_started_vip_q_is_not_scheduled() -> None:
    started = (
        progress("PDD-A", "In Progress", percent_complete=50, actual_start_week=SELFTEST_WEEK - 1),
    )
    q = base_project(
        project_id="q",
        priority="Q",
        is_vip=True,
        status="In Development",
        step_progress=started,
    )
    p2 = base_project(project_id="p2", priority="P2")
    si = _si(q, p2)
    for out in _solvers(si):
        b = _by(out)
        _assert_not_scheduled(b["q"])
        assert "q" not in out.scheduling_order
        # Its in-progress design step was not pre-booked: eng-a is free for the P2 now.
        assert _step(b["p2"], "PDD-A").start_week == SELFTEST_WEEK
        assert validate_invariants(si, out, check_determinism=False) == ()


def test_frozen_queued_p3_books_and_counts() -> None:
    """P53 (R53-2): a frozen queued P3 books first (key 1) and now counts."""

    frozen_q = base_project(
        project_id="fq",
        priority="P3",
        status="In Queue",
        frozen=True,
        actual_start_week=SELFTEST_WEEK,
    )
    p1 = base_project(project_id="p1", priority="P1")
    si = _si(frozen_q, p1)
    for out in _solvers(si):
        b = _by(out)
        fq = b["fq"]
        assert not fq.excluded and not fq.not_scheduled_priority
        assert fq.counts_toward_year
        assert fq.within_year != fq.spillover
        assert _step(fq, "PDD-A").start_week == SELFTEST_WEEK
        assert _step(b["p1"], "PDD-A").start_week > _step(fq, "PDD-A").end_week
        # Key 1 (frozen) outranks key 1a: the frozen queued P3 walks first.
        assert out.scheduling_order[0] == "fq"
        assert validate_invariants(si, out, check_determinism=False) == ()
