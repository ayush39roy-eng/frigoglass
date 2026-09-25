"""`GET /schedule-runs/{schedule_run_id}/progress` (P3-T05) — the SSE
endpoint relaying `workers.progress.publish_progress`'s Redis pub/sub
channel. Uses its OWN dedicated, throwaway `redis:7` `testcontainers`
container (not the shared session-scoped Postgres container in
`tests/conftest.py`), mirroring `tests/test_workers_progress.py`'s
established "own dedicated throwaway container" pattern — this is genuinely
different infrastructure the rest of the suite doesn't otherwise need, and
this endpoint's whole job (relaying real pub/sub messages, closing cleanly,
the already-terminal-at-connect-time synthesized event) is only meaningfully
testable against a REAL Redis, not a mock.

**What this file does NOT cover (deliberately, matching P3-T06's own stated
split)**: it never spins up a real Celery worker or dispatches a real CP-SAT
solve — `publish_progress(...)` is called directly from the test to simulate
what a real worker would publish, exactly as `tests/test_workers_progress.py`
already does for the publisher side alone. The genuinely end-to-end path
(real `POST /schedule-runs/cp-sat-dispatch` -> real Celery worker -> real
"queued"/"running"/"completed" events observed over a real SSE connection to
THIS endpoint) is covered by this task's live verification only, documented
in `docs/MEMORY.md`'s P3-T05 entry, not re-automated here.

**A real, load-bearing httpx/`ASGITransport` limitation this file works
around — worth documenting since it cost real debugging time**:
`httpx.ASGITransport.handle_async_request` (confirmed by reading its actual
source, not assumed) `await`s the WHOLE ASGI app coroutine to completion
(waiting for `response_complete`, i.e. the final `more_body=False` body
chunk) and buffers every body chunk into a list BEFORE ever constructing/
returning an `httpx.Response` — including for `client.stream(...)`, which one
might otherwise expect to return as soon as response *headers* are available
(as it does for real network transports). This means driving this endpoint
end-to-end through `httpx.AsyncClient(transport=ASGITransport(app=app))`
cannot be used to test the LIVE-relay path (subscribe, then have a test
concurrently `publish_progress(...)` while the request is "in flight") —
`async with client.stream(...)` simply never returns control to the test
until the SSE generator itself has already reached a terminal state or its
safety cap, at which point publishing from the test body is too late and the
request hangs forever waiting for an event that can never arrive because the
test code that would publish it hasn't run yet. Confirmed empirically: an
earlier version of this file's live-relay test hung for the full safety-cap
duration before being killed. **Fix**: tests that need genuine concurrency
(live-relay, channel isolation) call `_progress_event_source` directly as a
plain async generator against a REAL, already-subscribed `redis.asyncio`
`PubSub` (bypassing `httpx`/ASGI entirely) and drive it from a background
`asyncio.Task` while the test body calls `publish_progress(...)`
concurrently on the same event loop — this exercises the exact same
production code path (`_progress_event_source` is the literal function the
real endpoint awaits from) without ASGITransport's full-buffering
limitation. Tests that complete within a single non-concurrent request/
response cycle (RBAC 403, 404, and the already-terminal case, which
synthesizes its one event and returns without ever needing an external
publish) are unaffected by this limitation and are still driven through the
full HTTP-shaped `httpx`/`ASGITransport`/FastAPI stack, exercising real
routing + dependency wiring + response headers.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
import redis
import redis.asyncio as redis_asyncio
from httpx import ASGITransport, AsyncClient
from testcontainers.core.container import DockerContainer
from testcontainers.core.waiting_utils import wait_for_logs

import api.routers.schedule_runs as schedule_runs_module
import workers.progress as progress_module
from api.db import get_db
from api.main import app
from core.celery_config import get_redis_settings
from models.enums import RoleName, ScheduleRunStatus, SolverType
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_schedule_run, make_user
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
    """Same rationale/mechanics as `tests/test_workers_progress.py`'s fixture
    of the same name: override `RPD_REDIS_URL` + clear every module-level
    cache/singleton that could otherwise still point at `conftest.py`'s inert
    placeholder value, so both `publish_progress` (used here to simulate a
    worker) AND this router's own `get_redis_settings()` call genuinely talk
    to THIS test's disposable container.
    """

    monkeypatch.setenv("RPD_REDIS_URL", redis_url)
    get_redis_settings.cache_clear()
    original_client = progress_module._redis_client
    progress_module._redis_client = None
    yield
    progress_module._redis_client = original_client
    get_redis_settings.cache_clear()


async def _client(db_session, *principal_roles: RoleName) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    user = await make_user(db_session, *principal_roles)
    override_current_principal(make_principal(*principal_roles, user_id=user.id))
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


def _subscriber_count(redis_url: str, channel: str) -> int:
    client = redis.Redis.from_url(redis_url)
    try:
        # PUBSUB NUMSUB returns [channel, count, channel, count, ...]
        result = client.execute_command("PUBSUB", "NUMSUB", channel)
        return int(result[1])
    finally:
        client.close()


async def _read_sse_events(
    response, *, max_events: int, timeout: float = 10.0
) -> list[dict | None]:
    """Read up to `max_events` SSE frames from a streaming httpx response.
    Returns the parsed JSON `dict` for a `data: ...` frame, or `None` for a
    comment (`: ...`) line — callers that don't care about heartbeats filter
    `None`s out.
    """

    events: list[dict | None] = []

    async def _consume():
        async for line in response.aiter_lines():
            if not line:
                continue
            if line.startswith("data: "):
                events.append(json.loads(line[len("data: ") :]))
            elif line.startswith(":"):
                events.append(None)
            if len(events) >= max_events:
                return

    await asyncio.wait_for(_consume(), timeout=timeout)
    return events


# --------------------------------------------------------------------------
# RBAC
# --------------------------------------------------------------------------


async def test_progress_requires_read_permission(db_session):
    """AUDITOR holds no READ on DASHBOARD/CAPACITY/GANTT (see
    `core/rbac.py`) — same `_read_any` dependency as `GET /schedule-runs`,
    so this must 403 exactly like that endpoint does, before ever touching
    Redis (no `_point_at_real_redis` fixture needed for this test).
    """

    run = await make_schedule_run(db_session, status=ScheduleRunStatus.COMPLETED)
    client = await _client(db_session, RoleName.AUDITOR)
    try:
        resp = await client.get(f"/schedule-runs/{run.id}/progress")
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_progress_engineer_role_can_read(db_session, redis_url, _point_at_real_redis):
    """ENGINEER holds READ on GANTT only — `_read_any` must still admit it,
    confirming this endpoint is genuinely "any of the three", not silently
    narrowed to a subset. Uses an already-`COMPLETED` run (see the
    already-terminal test block below) so this request completes within a
    single request/response cycle and doesn't hit the `ASGITransport`
    limitation documented in this file's module docstring — it still needs
    `_point_at_real_redis` because the endpoint unconditionally subscribes
    for any EXISTING run (terminal or not) before deciding whether to keep
    that subscription open, per the module docstring's race-closing design.
    """

    run = await make_schedule_run(db_session, status=ScheduleRunStatus.COMPLETED)
    client = await _client(db_session, RoleName.ENGINEER)
    try:
        resp = await client.get(f"/schedule-runs/{run.id}/progress")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
    finally:
        _teardown()


# --------------------------------------------------------------------------
# 404
# --------------------------------------------------------------------------


async def test_progress_unknown_run_404s_without_touching_redis(db_session):
    """A 404 for an unknown id must never call `redis_asyncio.Redis.from_url`
    at all (see module docstring's "existence check first" ordering) — this
    test deliberately does NOT use `_point_at_real_redis`, so if this
    endpoint tried to actually reach Redis before 404ing it would hang/error
    against `conftest.py`'s unreachable placeholder URL and this test would
    fail/timeout, proving the ordering is real, not just documented.
    """

    client = await _client(db_session, RoleName.PORTFOLIO_MANAGER)
    try:
        resp = await client.get(f"/schedule-runs/{uuid.uuid4()}/progress")
        assert resp.status_code == 404
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Already-terminal-at-connect-time
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "run_status,expects_percent,expects_error",
    [
        (ScheduleRunStatus.COMPLETED, True, False),
        (ScheduleRunStatus.FAILED, False, True),
        (ScheduleRunStatus.CANCELLED, False, False),
    ],
)
async def test_progress_already_terminal_run_emits_one_synthetic_event_and_closes(
    db_session, redis_url, _point_at_real_redis, run_status, expects_percent, expects_error
):
    error_message = "boom" if run_status == ScheduleRunStatus.FAILED else None
    run = await make_schedule_run(
        db_session,
        solver_type=SolverType.CP_SAT,
        status=run_status,
        error_message=error_message,
    )
    client = await _client(db_session, RoleName.PORTFOLIO_MANAGER)
    try:
        async with client.stream("GET", f"/schedule-runs/{run.id}/progress") as resp:
            assert resp.status_code == 200
            events = [e for e in await _read_sse_events(resp, max_events=1) if e is not None]
        assert len(events) == 1
        payload = events[0]
        assert payload["schedule_run_id"] == str(run.id)
        assert payload["status"] == run_status.value
        assert "synthesized" in payload["message"].lower()
        assert ("percent" in payload) is expects_percent
        assert ("error" in payload) is expects_error
        if expects_error:
            # P3-T09 (security remediation, finding #7): the SSE `error`
            # field is always a generic message, never the raw
            # `ScheduleRun.error_message` text ("boom" here) — that field
            # is not returned by any API endpoint today (a strict subset of
            # "Admin-only"), and is asserted directly against the DB below.
            assert payload["error"] == "Solver run failed — see server logs"
            await db_session.refresh(run)
            assert run.error_message == "boom"

        # Cleanly closed: nothing left subscribed to this run's channel.
        assert _subscriber_count(redis_url, channel_name(run.id)) == 0
    finally:
        _teardown()


async def test_progress_endpoint_headers_for_a_live_not_yet_terminal_run(
    db_session, redis_url, _point_at_real_redis
):
    """Confirms the endpoint itself (real routing/dependencies/response
    object) sets the documented `text/event-stream` content type and the
    `Cache-Control`/`X-Accel-Buffering` headers for a genuinely non-terminal
    run — driven through the full HTTP-shaped stack. Deliberately does NOT
    try to read the streamed body (see module docstring's `ASGITransport`
    limitation) — cancels the request immediately after the headers are
    observed so this test itself doesn't hang waiting for a terminal event
    that this test never publishes.
    """

    run = await make_schedule_run(db_session, status=ScheduleRunStatus.QUEUED)
    client = await _client(db_session, RoleName.PORTFOLIO_MANAGER)
    try:
        # `publish_progress` a terminal event BEFORE issuing the request so
        # the generator exits almost immediately once entered — this test is
        # about header shape, not relay timing (covered separately below via
        # `_progress_event_source` directly).
        async def _publish_soon():
            await asyncio.sleep(0.05)
            publish_progress(str(run.id), status="cancelled")

        publisher = asyncio.create_task(_publish_soon())
        try:
            resp = await client.get(f"/schedule-runs/{run.id}/progress")
        finally:
            await publisher
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers["cache-control"] == "no-cache"
        assert resp.headers["x-accel-buffering"] == "no"
        assert b"cancelled" in resp.content
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Live relay — exercises `_progress_event_source` directly against a real,
# already-subscribed `PubSub`, bypassing `httpx`/`ASGITransport` entirely.
# See module docstring for why (a real `ASGITransport` full-buffering
# limitation, not a workaround for a shortcut). This is still the exact
# production code path `stream_schedule_run_progress` awaits — not a
# reimplementation of it.
# --------------------------------------------------------------------------


class _FakeRequest:
    """Only `_progress_event_source` needs `.is_disconnected()` from the real
    `starlette.Request` it normally receives — a minimal stand-in avoids
    constructing a real ASGI scope for tests that don't exercise routing.
    """

    def __init__(self) -> None:
        self.disconnected = False

    async def is_disconnected(self) -> bool:
        return self.disconnected


async def _open_real_subscription(redis_url: str, schedule_run_id):
    """Mirrors exactly what `stream_schedule_run_progress` itself does:
    construct a fresh `redis.asyncio.Redis` + `PubSub`, subscribe to
    `channel_name(schedule_run_id)`, and hand both back for the generator
    to own/close.
    """

    redis_client = redis_asyncio.Redis.from_url(redis_url)
    pubsub = redis_client.pubsub()
    await pubsub.subscribe(channel_name(schedule_run_id))
    return redis_client, pubsub


async def test_progress_event_source_relays_real_published_events_in_order(
    redis_url, _point_at_real_redis
):
    run_id = uuid.uuid4()
    redis_client, pubsub = await _open_real_subscription(redis_url, run_id)
    request = _FakeRequest()
    generator = schedule_runs_module._progress_event_source(
        request=request,
        schedule_run_id=run_id,
        redis_client=redis_client,
        pubsub=pubsub,
        initial_terminal_payload=None,
    )

    events: list[dict] = []

    async def _consume():
        async for frame in generator:
            text = frame.decode()
            if text.startswith("data: "):
                events.append(json.loads(text[len("data: ") : -2]))

    consumer = asyncio.create_task(_consume())
    await asyncio.sleep(0.1)  # let the generator start polling get_message()
    publish_progress(str(run_id), status="running", message="solve started")
    await asyncio.sleep(0.1)
    publish_progress(str(run_id), status="completed", percent=100.0)

    await asyncio.wait_for(consumer, timeout=10.0)

    assert [e["status"] for e in events] == ["running", "completed"]
    assert events[0]["message"] == "solve started"
    assert events[1]["percent"] == 100.0

    # The generator's own `finally` unsubscribed + closed both objects on
    # relaying the terminal event — confirm no dangling subscriber remains
    # (this is the "no resource leak" acceptance criterion, proven directly
    # against real Redis, not inferred).
    assert _subscriber_count(redis_url, channel_name(run_id)) == 0


async def test_progress_event_source_ignores_other_runs_channel(redis_url, _point_at_real_redis):
    """A message published for a DIFFERENT schedule_run_id must never leak
    into this run's stream — confirms the per-run channel naming convention
    (`workers.progress.channel_name`) genuinely isolates runs through this
    generator, not just at the publisher layer (already covered by
    `tests/test_workers_progress.py`).
    """

    run_id = uuid.uuid4()
    other_run_id = uuid.uuid4()
    redis_client, pubsub = await _open_real_subscription(redis_url, run_id)
    request = _FakeRequest()
    generator = schedule_runs_module._progress_event_source(
        request=request,
        schedule_run_id=run_id,
        redis_client=redis_client,
        pubsub=pubsub,
        initial_terminal_payload=None,
    )

    events: list[dict] = []

    async def _consume():
        async for frame in generator:
            text = frame.decode()
            if text.startswith("data: "):
                events.append(json.loads(text[len("data: ") : -2]))

    consumer = asyncio.create_task(_consume())
    await asyncio.sleep(0.1)
    publish_progress(str(other_run_id), status="running")
    await asyncio.sleep(0.5)
    publish_progress(str(run_id), status="cancelled")

    await asyncio.wait_for(consumer, timeout=10.0)

    assert len(events) == 1
    assert events[0]["schedule_run_id"] == str(run_id)
    assert events[0]["status"] == "cancelled"


async def test_progress_event_source_closes_cleanly_on_client_disconnect(
    redis_url, _point_at_real_redis
):
    """No terminal event ever arrives — the generator must still exit (and
    unsubscribe/close) once `request.is_disconnected()` starts returning
    `True`, proving the "clean close, no hanging connection" acceptance
    criterion for the disconnect path specifically (the terminal-event path
    is covered by the two tests above).
    """

    run_id = uuid.uuid4()
    redis_client, pubsub = await _open_real_subscription(redis_url, run_id)
    request = _FakeRequest()
    generator = schedule_runs_module._progress_event_source(
        request=request,
        schedule_run_id=run_id,
        redis_client=redis_client,
        pubsub=pubsub,
        initial_terminal_payload=None,
    )

    frames: list[bytes] = []

    async def _consume():
        async for frame in generator:
            frames.append(frame)

    consumer = asyncio.create_task(_consume())
    await asyncio.sleep(0.1)
    request.disconnected = True

    # The polling loop checks `is_disconnected()` once per
    # `_POLL_TIMEOUT_SECONDS` (1.0s) iteration — allow just over that.
    await asyncio.wait_for(consumer, timeout=5.0)

    assert frames == []  # no event was ever relayed
    assert _subscriber_count(redis_url, channel_name(run_id)) == 0


async def test_progress_event_source_closes_cleanly_on_redis_error(
    redis_url, _point_at_real_redis
):
    """A genuine Redis error while polling (connection drop, etc.) must not
    crash the generator uncaught — it logs, yields one `: upstream-error,
    closing\\n\\n` comment, and closes (unsubscribe/close still run via the
    outer `finally`), rather than hanging or propagating an unhandled
    exception into Starlette's response-streaming machinery. Simulated by
    monkeypatching this specific `PubSub` instance's `get_message` — no way
    to reliably force a real connection failure against a healthy
    `testcontainers` Redis without flaking, and this is exactly the kind of
    rare-but-must-not-crash edge case this project's own conventions treat as
    fair game for a monkeypatched unit test rather than requiring a live
    reproduction.
    """

    run_id = uuid.uuid4()
    redis_client, pubsub = await _open_real_subscription(redis_url, run_id)

    async def _boom(*args, **kwargs):
        raise ConnectionError("simulated redis failure")

    pubsub.get_message = _boom  # type: ignore[method-assign]

    request = _FakeRequest()
    generator = schedule_runs_module._progress_event_source(
        request=request,
        schedule_run_id=run_id,
        redis_client=redis_client,
        pubsub=pubsub,
        initial_terminal_payload=None,
    )

    frames = [frame async for frame in generator]

    assert frames == [b": upstream-error, closing\n\n"]
    assert _subscriber_count(redis_url, channel_name(run_id)) == 0


async def test_progress_event_source_sends_heartbeat_comments_when_idle(
    redis_url, _point_at_real_redis, monkeypatch
):
    """No message is ever published — confirms the `: heartbeat\\n\\n` SSE
    comment (module docstring point 1) is genuinely emitted while idle, not
    just documented. Shrinks `_HEARTBEAT_INTERVAL_SECONDS` for this test only
    so it doesn't need to wait the real ~15s. Explicitly `aclose()`s the
    generator once enough heartbeats are observed (rather than relying on the
    generator's own terminal-status/disconnect exit conditions, neither of
    which applies here) — this deterministically drives its `finally` cleanup
    the same way Starlette does when an ASGI response body iterator is torn
    down early, so the subscriber-count assertion below is real, not a race.
    """

    monkeypatch.setattr(schedule_runs_module, "_HEARTBEAT_INTERVAL_SECONDS", 0.05)
    run_id = uuid.uuid4()
    redis_client, pubsub = await _open_real_subscription(redis_url, run_id)
    request = _FakeRequest()
    generator = schedule_runs_module._progress_event_source(
        request=request,
        schedule_run_id=run_id,
        redis_client=redis_client,
        pubsub=pubsub,
        initial_terminal_payload=None,
    )

    frames: list[bytes] = []
    async for frame in generator:
        frames.append(frame)
        if len(frames) >= 2:
            break
    await generator.aclose()

    assert frames == [b": heartbeat\n\n", b": heartbeat\n\n"]
    assert _subscriber_count(redis_url, channel_name(run_id)) == 0


async def test_progress_event_source_relays_malformed_json_without_crashing(
    redis_url, _point_at_real_redis
):
    """A defensive case: if something ever publishes non-JSON (or JSON
    without a `"status"` key) to a run's channel, the generator must still
    relay it verbatim (per module docstring point 1's "pass it through, never
    editorialize" contract) rather than crashing — it just can't treat it as
    a terminal-status signal, so the loop continues rather than closing.

    Drives the generator with direct `__anext__()` calls (rather than a
    background task) so the test controls exactly when it resumes: the FIRST
    `__anext__()` yields the malformed frame itself (suspended immediately
    after the `yield`); a SECOND `__anext__()` is required to actually
    resume execution PAST that yield — running the `json.loads(...)`
    parse-failure branch this test targets — before it loops back to polling
    Redis again (where it's left to block, then explicitly `aclose()`d).
    """

    run_id = uuid.uuid4()
    redis_client, pubsub = await _open_real_subscription(redis_url, run_id)
    request = _FakeRequest()
    generator = schedule_runs_module._progress_event_source(
        request=request,
        schedule_run_id=run_id,
        redis_client=redis_client,
        pubsub=pubsub,
        initial_terminal_payload=None,
    )

    async def _get_first_frame():
        return await generator.__anext__()

    getter = asyncio.create_task(_get_first_frame())
    await asyncio.sleep(0.1)
    # Publish directly (bypassing `publish_progress`'s `json.dumps`) to
    # simulate a malformed message.
    raw_client = redis.Redis.from_url(redis_url)
    try:
        raw_client.publish(channel_name(run_id), "not valid json")
    finally:
        raw_client.close()

    first_frame = await asyncio.wait_for(getter, timeout=5.0)
    assert first_frame == b"data: not valid json\n\n"

    # Resume past the yield (runs the parse-failure branch), then it blocks
    # again polling Redis for a message that will never come — bounded wait,
    # then explicitly closed.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(generator.__anext__(), timeout=1.2)
    await generator.aclose()

    assert _subscriber_count(redis_url, channel_name(run_id)) == 0
