"""Redis pub/sub publisher for solver-run progress. **This module defines the
exact contract P3-T05's SSE endpoint subscribes to — read this whole
docstring before touching either side of it. If this contract changes, both
this module and P3-T05's consumer must change together.**

Per `docs/PROJECT_AND_STACK.md` §4: "Solver progress (queued -> running ->
progress % -> done/failed) is published to Redis pub/sub by the worker."

CHANNEL NAMING
--------------
    schedule-run-progress:{schedule_run_id}

One channel per `ScheduleRun` row (its UUID, string form, e.g.
`"550e8400-e29b-41d4-a716-446655440000"`). Redis pub/sub channels need no
explicit creation/teardown — `PUBLISH` to a channel with zero subscribers is
a harmless no-op, and a channel with zero remaining subscribers simply stops
existing. There is no fan-in/"all runs" broadcast channel — a client must
already know which `schedule_run_id` it cares about (returned by `POST
/schedule-runs/cp-sat-dispatch`) before subscribing.

MESSAGE SCHEMA (one JSON object per PUBLISH call, UTF-8 encoded)
------------------------------------------------------------------
```
{
  "schedule_run_id": "<uuid str>",
  "status": "queued" | "running" | "completed" | "failed" | "cancelled",
  "timestamp": "<ISO-8601 UTC, e.g. '2026-08-31T12:00:00.000000+00:00'>",
  "percent": <float 0-100>,   # OPTIONAL key, present only alongside "completed"
  "message": "<str>",         # OPTIONAL key, human-readable detail
  "error": "<str>"            # OPTIONAL key, present only alongside "failed"
}
```
`status` values are exactly `models.enums.ScheduleRunStatus`'s member
*values* (lowercase strings) — a consumer can cross-reference directly
against the `ScheduleRun.status` DB column's own vocabulary rather than
maintaining a second one. Optional keys are omitted (not sent as `null`)
when not applicable, so a naive `"percent" in payload` check is a reliable
presence test.

WHAT IS, AND ISN'T, A REAL "PERCENT" — read before building a progress bar
----------------------------------------------------------------------------
`scheduling.cp_sat.run_cp_sat` (the pure function `workers/schedule_tasks.py`
calls) exposes NO progress-callback / solution-callback hook of its own — it
is one single blocking `solver.Solve(model)` call, with no intermediate
observation point this module is permitted to instrument
(`backend/scheduling/` is algorithm-engineer's package; CLAUDE.md forbids
editing it, and this task confirmed no such hook exists by reading
`run_cp_sat`'s actual signature/docstring, not by assuming). This means this
publisher can genuinely observe and publish only THREE real transition
points: "queued" (before dispatch), "running" (the instant the Celery task
starts, before the blocking solve call), and "completed"/"failed"/
"cancelled" (after the blocking solve call returns, errors, or is found to
have been cancelled). **There is no genuine "percent complete" during the
solve itself** — `"percent"` is only ever published as the literal value
`100` alongside `"completed"`, never as a running estimate. A fake
wall-clock-based percent guess was considered and rejected: `run_cp_sat`'s
`max_time_in_seconds` is a search-time *ceiling*, not a promise of how long
the solve will actually take (OPTIMAL is frequently reached in well under a
second on the real dataset — see `scheduling/cp_sat.py`'s own module
docstring) — a wall-clock-fraction percent would be actively misleading
("stuck at 3%" while actually already done). P3-T05's SSE endpoint and any
frontend progress bar built on top of it must render "queued" / "running
(indeterminate)" / "completed" / "failed" / "cancelled" as discrete states,
not a continuous progress bar, for CP-SAT runs specifically.

SYNC, NOT ASYNC
----------------
Celery tasks execute as plain synchronous functions (Celery has no native
`async def` task support) — this module's `publish_progress` is a blocking
call using the sync `redis-py` client (`redis.Redis`), not
`redis.asyncio.Redis`. Callers already inside an `asyncio.run(...)`-wrapped
async context (see `workers/schedule_tasks.py`) call this function as an
ordinary (non-awaited) function from synchronous code paths within that
wrapper — never `await`ed.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Literal

import redis

from core.celery_config import get_redis_settings

ProgressStatus = Literal["queued", "running", "completed", "failed", "cancelled"]

_CHANNEL_PREFIX = "schedule-run-progress"


def channel_name(schedule_run_id: str | uuid.UUID) -> str:
    """`schedule-run-progress:{schedule_run_id}` — the single source of truth
    for the channel-naming convention; both this module and P3-T05's
    subscriber must derive the channel name via this function, never by
    re-formatting the f-string independently, so the two can never drift.
    """

    return f"{_CHANNEL_PREFIX}:{schedule_run_id}"


#: Lazily-constructed, module-level singleton `redis.Redis` client — mirrors
#: `api/db.py`'s "module-level, lazily-initialised singleton" convention for
#: the async DB engine, so importing this module (e.g. in a test) never
#: requires `RPD_REDIS_URL` to already be set.
_redis_client: redis.Redis | None = None


def _client() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis.from_url(get_redis_settings().redis_url)
    return _redis_client


def publish_progress(
    schedule_run_id: str | uuid.UUID,
    *,
    status: ProgressStatus,
    percent: float | None = None,
    message: str | None = None,
    error: str | None = None,
) -> None:
    """`PUBLISH` one progress message to `channel_name(schedule_run_id)`. See
    module docstring for the exact schema. Never raises on "zero
    subscribers" (that is normal, expected Redis pub/sub behaviour, not an
    error this function needs to handle specially) — a genuine Redis
    connection failure DOES propagate to the caller (deliberately: silently
    swallowing a broken progress channel would leave `workers/
    schedule_tasks.py`'s caller unaware that no client will ever see the
    "completed"/"failed" terminal event, which is worse than a loud task
    failure).
    """

    payload: dict[str, str | float] = {
        "schedule_run_id": str(schedule_run_id),
        "status": status,
        "timestamp": datetime.now(UTC).isoformat(),
    }
    if percent is not None:
        payload["percent"] = percent
    if message is not None:
        payload["message"] = message
    if error is not None:
        payload["error"] = error
    _client().publish(channel_name(schedule_run_id), json.dumps(payload))
