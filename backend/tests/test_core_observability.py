"""`core/observability.py` — the `ObservabilityMiddleware` (request-id +
structured access log + Prometheus metrics) and the `/metrics` route it
backs (P6-T06). Exercised against the real FastAPI app via `TestClient`
(the middleware is added in `api/main.py`), not re-implemented/mocked —
this is the same app object every real request goes through.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from api.main import app
from core.observability import HTTP_REQUEST_DURATION_SECONDS, HTTP_REQUESTS_TOTAL, render_metrics

client = TestClient(app)


def test_healthz_response_carries_a_request_id_header():
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.headers["x-request-id"]


def test_two_requests_get_different_request_ids():
    first = client.get("/healthz").headers["x-request-id"]
    second = client.get("/healthz").headers["x-request-id"]

    assert first != second


def test_incoming_request_id_header_is_honoured_for_correlation():
    response = client.get("/healthz", headers={"x-request-id": "caller-supplied-id"})

    assert response.headers["x-request-id"] == "caller-supplied-id"


def test_metrics_endpoint_returns_prometheus_text_exposition_format():
    response = client.get("/metrics")

    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    assert "rpd_http_requests_total" in response.text


def test_metrics_endpoint_records_request_count_and_latency_by_route():
    client.get("/healthz")

    body, _content_type = render_metrics()
    text = body.decode()

    assert 'route="/healthz"' in text
    assert 'method="GET"' in text

    # The Counter/Histogram objects themselves reflect the increment too —
    # not just the rendered text (guards against a formatting-only bug).
    sample_families = list(HTTP_REQUESTS_TOTAL.collect())
    total_samples = [s for family in sample_families for s in family.samples]
    assert any(
        s.labels.get("route") == "/healthz" and s.value >= 1
        for s in total_samples
        if s.name.endswith("_total")
    )

    latency_families = list(HTTP_REQUEST_DURATION_SECONDS.collect())
    latency_samples = [s for family in latency_families for s in family.samples]
    assert any(
        s.labels.get("route") == "/healthz" and s.name.endswith("_count") and s.value >= 1
        for s in latency_samples
    )


def test_access_log_line_never_includes_query_string(caplog):
    """Scoped to THIS app's own `api.access` logger (`core.observability`)
    only — `httpx`'s own internal request-debug logger (used only by
    `TestClient` in this test harness, never present in a real production
    deployment which talks HTTP directly, not via the `httpx` test client)
    does log the full URL including the query string, which is that
    library's own concern, not this app's — asserting on it would be
    testing `httpx`, not this codebase.
    """

    import logging

    caplog.set_level(logging.INFO, logger="api.access")

    client.get("/healthz?customer_name=SHOULD-NEVER-APPEAR")

    access_log_records = [r for r in caplog.records if r.name == "api.access"]
    assert access_log_records, "expected at least one api.access log record"
    for record in access_log_records:
        rendered = record.getMessage() + str(record.__dict__)
        assert "SHOULD-NEVER-APPEAR" not in rendered
