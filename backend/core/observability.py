"""Request-level observability for the `api` service (P6-T06): a
correlation id (`request_id`) on every request/log line, one structured
"request completed" log line per request, and Prometheus request-count/
latency metrics scraped from `GET /metrics`.

**Deliberately a raw ASGI middleware, not `starlette.middleware.base.
BaseHTTPMiddleware`.** `BaseHTTPMiddleware` buffers/re-wraps the response
body through an in-memory stream, which is documented to break long-lived
streaming responses in some Starlette versions (background tasks not
running until the stream fully drains, connection-drop detection quirks).
This app has a real, load-bearing streaming endpoint
(`GET /schedule-runs/{id}/progress`, `api/routers/schedule_runs.py`'s SSE
stream, proxied with `proxy_buffering off` at the edge — see
`deploy/nginx/default.conf`) that must not be silently broken by an
observability middleware added in a later phase. A plain ASGI middleware
that only inspects `http.response.start` (never touches
`http.response.body` chunks) has none of that risk.

**Metrics cardinality**: labelled by `route` (the FastAPI/Starlette ROUTE
TEMPLATE, e.g. `/projects/{project_id}`, resolved from `scope["route"]`
after routing — never the raw path with a real UUID/name in it) plus
`method`/`status`. This is deliberately NOT per-project or per-engineer
(CLAUDE.md: no financial/utilization dimension is reintroduced here) and
has bounded cardinality equal to the number of registered routes, not the
~236-project or per-engineer scale of the underlying data.
"""

from __future__ import annotations

import logging
import time
import uuid

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from core.logging_config import request_id_ctx

logger = logging.getLogger("api.access")

REQUEST_ID_HEADER = b"x-request-id"

#: "at minimum" per this task's Part 2 — basic request-level metrics by
#: route+status, not a per-entity breakdown.
HTTP_REQUESTS_TOTAL = Counter(
    "rpd_http_requests_total",
    "Total HTTP requests handled by the api service.",
    ["method", "route", "status"],
)
HTTP_REQUEST_DURATION_SECONDS = Histogram(
    "rpd_http_request_duration_seconds",
    "HTTP request latency in seconds, by method and route.",
    ["method", "route"],
)


class ObservabilityMiddleware:
    """Assigns/propagates a `request_id`, times the request, records
    Prometheus metrics, and emits one structured JSON "request completed"
    log line — deliberately logging the ROUTE TEMPLATE and PATH ONLY, never
    the query string (`scope["query_string"]` is never read here) and never
    the request/response body. See module docstring for why.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming_headers = dict(scope.get("headers") or [])
        request_id = incoming_headers.get(REQUEST_ID_HEADER, b"").decode() or str(uuid.uuid4())
        token = request_id_ctx.set(request_id)

        status_code = 500
        start = time.perf_counter()

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                headers = MutableHeaders(scope=message)
                headers.append("x-request-id", request_id)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration_seconds = time.perf_counter() - start
            route = scope.get("route")
            route_path = getattr(route, "path", None) or scope.get("path", "unmatched")
            method = scope.get("method", "")

            HTTP_REQUESTS_TOTAL.labels(
                method=method, route=route_path, status=str(status_code)
            ).inc()
            HTTP_REQUEST_DURATION_SECONDS.labels(method=method, route=route_path).observe(
                duration_seconds
            )

            logger.info(
                "http_request_completed",
                extra={
                    "http_method": method,
                    "http_route": route_path,
                    "http_status": status_code,
                    "duration_ms": round(duration_seconds * 1000, 2),
                },
            )

            request_id_ctx.reset(token)


def render_metrics() -> tuple[bytes, str]:
    """Returns `(body, content_type)` for the `/metrics` endpoint
    (`api/main.py`). Split out as a plain function (rather than inlined in
    the route) so it's trivially unit-testable without spinning up the ASGI
    app.
    """

    return generate_latest(), CONTENT_TYPE_LATEST
