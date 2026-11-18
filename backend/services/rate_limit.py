"""A small in-process token bucket, per key (security S-02, P9-R02).

Used to rate-limit comment creation per user. The repo has Redis, but no
Redis-backed rate-limit pattern existed, and adding a Redis round-trip (and a
Redis dependency) to every comment write was judged heavier than the risk.

**Documented limitation.** The buckets live in the API worker process:
- each gunicorn worker keeps its own buckets, so the effective limit is up to
  `workers × capacity` per window;
- a restart resets them.
That bounds a single user's burst, which is the S-02 concern (one account
posting hundreds of large comments). It is not a global quota. If one is ever
needed, replace this with a Redis `INCR`/`EXPIRE` counter behind the same
`allow()` call.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass


@dataclass
class _Bucket:
    tokens: float
    updated: float


class TokenBucketLimiter:
    """`capacity` tokens, refilled at `refill_per_second`. `allow(key)`
    spends one token and returns `(allowed, retry_after_seconds)`.

    `max_keys` (optional, P46-R01): keep at most that many buckets, evicting
    the least recently used one. For limiters keyed on something a caller
    controls (a client address), so the dict cannot grow without bound. An
    evicted key starts again with a full bucket. `None` (the default) keeps
    the previous unbounded behaviour.
    """

    def __init__(
        self, capacity: int, refill_per_second: float, max_keys: int | None = None
    ) -> None:
        self.capacity = float(capacity)
        self.refill_per_second = refill_per_second
        self.max_keys = max_keys
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def __len__(self) -> int:
        return len(self._buckets)

    def allow(self, key: str, now: float | None = None) -> tuple[bool, float]:
        t = time.monotonic() if now is None else now
        with self._lock:
            bucket = self._buckets.pop(key, None) if self.max_keys else self._buckets.get(key)
            if bucket is None:
                bucket = _Bucket(tokens=self.capacity, updated=t)
            if self.max_keys:
                # Re-inserted at the end: dict order is the recency order.
                while len(self._buckets) >= self.max_keys:
                    del self._buckets[next(iter(self._buckets))]
            self._buckets[key] = bucket
            elapsed = max(0.0, t - bucket.updated)
            bucket.tokens = min(self.capacity, bucket.tokens + elapsed * self.refill_per_second)
            bucket.updated = t
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True, 0.0
            return False, (1.0 - bucket.tokens) / self.refill_per_second

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()
