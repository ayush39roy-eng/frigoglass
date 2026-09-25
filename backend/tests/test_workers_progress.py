"""`workers/progress.py` — the Redis pub/sub progress-publish contract P3-T05
depends on. Spins up its own dedicated, throwaway `redis:7` container (not
the shared session-scoped Postgres container in `tests/conftest.py`) using
`testcontainers`' generic `DockerContainer` — mirroring
`tests/test_migrations.py`'s "own dedicated throwaway container" pattern,
since this is genuinely different infrastructure (Redis, not Postgres) that
the rest of the suite doesn't otherwise need.

This is a REAL integration test against a real running Redis server — not a
mock — confirming `publish_progress` actually PUBLISHes an observable
message with the documented schema to the documented channel name. Full
end-to-end verification (a real Celery worker dispatching a real CP-SAT run
and publishing real "running"/"completed" events observed by a plain
`redis-cli SUBSCRIBE`) is performed separately as this task's live smoke
test (see `docs/MEMORY.md`'s P3-T06 entry) — this file's job is fast,
hermetic, CI-friendly regression coverage of the publisher's own logic and
message shape.
"""

from __future__ import annotations

import json
import time
import uuid

import pytest
import redis
from testcontainers.core.container import DockerContainer
from testcontainers.core.waiting_utils import wait_for_logs

import workers.progress as progress_module
from core.celery_config import get_redis_settings
from workers.progress import channel_name, publish_progress


@pytest.fixture(scope="module")
def redis_url():
    container = DockerContainer("redis:7").with_exposed_ports(6379)
    container.start()
    try:
        wait_for_logs(container, "Ready to accept connections", timeout=30)
        host = container.get_container_host_ip()
        port = container.get_exposed_port(6379)
        yield f"redis://{host}:{port}/0"
    finally:
        container.stop()


@pytest.fixture
def _point_at_real_redis(redis_url, monkeypatch):
    """Override `RPD_REDIS_URL` + reset every module-level cache/singleton
    that could otherwise still be pointing at `conftest.py`'s inert
    placeholder value, so `publish_progress` genuinely talks to THIS test's
    disposable container. Restores everything after the test.
    """

    monkeypatch.setenv("RPD_REDIS_URL", redis_url)
    get_redis_settings.cache_clear()
    original_client = progress_module._redis_client
    progress_module._redis_client = None
    yield
    progress_module._redis_client = original_client
    get_redis_settings.cache_clear()


def _subscribe(redis_url: str, channel: str) -> redis.client.PubSub:
    """Subscribe and block until the subscription is actually confirmed
    established (reads/discards `get_message()` calls until a
    `"subscribe"`-type confirmation for THIS channel is seen).

    **Sharp edge this function works around, worth documenting since it cost
    real debugging time**: `redis.Redis.__del__` calls `self.close()`, which
    tears down its connection pool — including the dedicated connection a
    `PubSub` object created from it is using. A `PubSub` instance only holds
    a reference to the connection *pool*, not to the `Redis` client object
    itself, so if the `Redis` client is a purely local variable with no other
    reference once this function returns, CPython's deterministic refcounting
    GC collects it immediately, silently closing the connection and losing
    the subscription server-side — even though the caller still holds a
    perfectly usable-looking `PubSub` Python object with no exception raised
    anywhere. The fix: stash the client on the returned `PubSub` object
    itself (`pubsub._rpd_owner_client`) so it stays alive for exactly as long
    as the `PubSub` object the caller is holding onto does.
    """

    client = redis.Redis.from_url(redis_url)
    pubsub = client.pubsub()
    pubsub._rpd_owner_client = client  # see docstring — prevents premature GC/close()
    pubsub.subscribe(channel)
    channel_bytes = channel.encode()
    for _ in range(10):
        msg = pubsub.get_message(timeout=5)
        if (
            msg is not None
            and msg.get("type") == "subscribe"
            and msg.get("channel") == channel_bytes
        ):
            return pubsub
    raise AssertionError(f"never observed a subscribe confirmation for {channel!r}")


def _next_real_message(pubsub: redis.client.PubSub, *, timeout: float = 5.0) -> dict | None:
    """Poll `get_message(..., ignore_subscribe_messages=True)` in a loop
    until an actual published `"message"` arrives or `timeout` (seconds,
    total across the whole loop) elapses — `ignore_subscribe_messages=True`
    only suppresses a SINGLE control message per call (redis-py's own
    `get_message` never loops internally, see its source), so a caller that
    might still see a stray subscribe/reconnect control message after the
    real subscription is already established needs this loop, not one bare
    call, to reliably reach the actual message.
    """

    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        msg = pubsub.get_message(timeout=remaining, ignore_subscribe_messages=True)
        if msg is not None:
            return msg


def test_channel_name_format():
    run_id = uuid.uuid4()
    assert channel_name(run_id) == f"schedule-run-progress:{run_id}"
    assert channel_name(str(run_id)) == channel_name(run_id)


def test_publish_progress_queued_message_observed_by_real_subscriber(
    redis_url, _point_at_real_redis
):
    run_id = str(uuid.uuid4())
    pubsub = _subscribe(redis_url, channel_name(run_id))
    try:
        publish_progress(run_id, status="queued")
        msg = _next_real_message(pubsub)
        assert msg is not None and msg["type"] == "message"
        payload = json.loads(msg["data"])
        assert payload["schedule_run_id"] == run_id
        assert payload["status"] == "queued"
        assert "timestamp" in payload
        # Optional keys must be ABSENT (not null) when not supplied.
        assert "percent" not in payload
        assert "message" not in payload
        assert "error" not in payload
    finally:
        pubsub.close()


def test_publish_progress_running_message_includes_optional_message(
    redis_url, _point_at_real_redis
):
    run_id = str(uuid.uuid4())
    pubsub = _subscribe(redis_url, channel_name(run_id))
    try:
        publish_progress(run_id, status="running", message="CP-SAT solve started")
        msg = _next_real_message(pubsub)
        payload = json.loads(msg["data"])
        assert payload["status"] == "running"
        assert payload["message"] == "CP-SAT solve started"
    finally:
        pubsub.close()


def test_publish_progress_completed_message_includes_percent(redis_url, _point_at_real_redis):
    run_id = str(uuid.uuid4())
    pubsub = _subscribe(redis_url, channel_name(run_id))
    try:
        publish_progress(run_id, status="completed", percent=100.0)
        msg = _next_real_message(pubsub)
        payload = json.loads(msg["data"])
        assert payload["status"] == "completed"
        assert payload["percent"] == 100.0
    finally:
        pubsub.close()


def test_publish_progress_failed_message_includes_error(redis_url, _point_at_real_redis):
    run_id = str(uuid.uuid4())
    pubsub = _subscribe(redis_url, channel_name(run_id))
    try:
        publish_progress(run_id, status="failed", error="boom")
        msg = _next_real_message(pubsub)
        payload = json.loads(msg["data"])
        assert payload["status"] == "failed"
        assert payload["error"] == "boom"
    finally:
        pubsub.close()


def test_publish_progress_cancelled_message(redis_url, _point_at_real_redis):
    run_id = str(uuid.uuid4())
    pubsub = _subscribe(redis_url, channel_name(run_id))
    try:
        publish_progress(run_id, status="cancelled")
        msg = _next_real_message(pubsub)
        payload = json.loads(msg["data"])
        assert payload["status"] == "cancelled"
    finally:
        pubsub.close()


def test_publish_progress_scoped_to_its_own_channel_only(redis_url, _point_at_real_redis):
    """A message published for one schedule_run_id must never appear on
    another schedule_run_id's channel — confirms the per-run channel naming
    convention actually isolates runs from each other, not just in theory.
    """

    run_a, run_b = str(uuid.uuid4()), str(uuid.uuid4())
    pubsub_b = _subscribe(redis_url, channel_name(run_b))
    try:
        publish_progress(run_a, status="queued")
        assert _next_real_message(pubsub_b, timeout=1) is None
    finally:
        pubsub_b.close()
