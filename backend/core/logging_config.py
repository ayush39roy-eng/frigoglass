"""Structured (JSON) logging setup, shared by `api`, `worker`, and
`solver-worker` (P6-T06 — "Observability: structured logging (no PII),
metrics, backup/restore drill").

**Scope / non-goals**: this module is the OPERATIONAL/application log path
(stdout-bound, 12-factor style, consumed by `docker compose logs` / any
external log-aggregation stack an operator points at it). It is a SEPARATE
concern from `models.audit.AuditLogEntry` (the immutable, append-only,
Postgres-backed audit trail written by `services/audit_helpers.py` for every
mutation, per CLAUDE.md's "Every mutation writes an audit row..."
non-negotiable) — this module does not read, write, or duplicate anything in
that table. Do not add audit-log writes here, and do not stop writing
`AuditLogEntry` rows in favour of a log line here.

**PII / financial-data line drawn here** (CLAUDE.md non-negotiables +
`docs/OPEN_QUESTIONS.md` #8):
  - Never log the value of a financial column (`tcogs_eur`,
    `selling_price_eur`, `gross_margin_pct`, `customer_name` —
    `models.types.FINANCIAL_FIELD_NAMES`). Existing call sites in
    `workers/export_tasks.py` / `workers/schedule_tasks.py` /
    `api/routers/schedule_runs.py` were audited as part of this task and
    only ever log opaque identifiers (job/run UUIDs, surface/format names,
    row counts, solver status/timing) — never a decrypted financial value,
    a project/customer name, or an engineer name. New log call sites must
    keep to that same standard.
  - Engineer-level utilization data (`docs/OPEN_QUESTIONS.md` #8) is
    scoped to VIEWS/EXPORTS of named-engineer load, not to a bare
    authenticated user id used purely as a request-correlation identifier.
    This module's request-logging path therefore correlates by `request_id`
    (a random per-request UUID, not tied to any person) plus, where
    convenient, the authenticated actor's `user_id` (already the audit log's
    own `actor_user_id` correlation key, per `models.audit.AuditLogEntry`) —
    never a name, email, or per-engineer utilization figure.
"""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

#: Set by `core.observability.ObservabilityMiddleware` (API) / manually in
#: worker code where useful. `JsonFormatter` reads this so every log line
#: emitted while handling a given request carries the same correlation id,
#: without every `logger.info(...)` call site having to thread it through
#: explicitly.
request_id_ctx: ContextVar[str | None] = ContextVar("request_id_ctx", default=None)


class LoggingSettings(BaseSettings):
    """`RPD_LOG_*` — deliberately minimal (one knob), mirroring this repo's
    established per-area `pydantic-settings` convention (`core.config.
    OIDCSettings`, `core.celery_config.RedisSettings`). Unlike those, this
    one DOES have a sane default (`INFO`) — logging must work out of the box
    with zero configuration; there is no equivalent "fail loudly if unset"
    reason to require an operator to set this before anything starts.
    """

    model_config = SettingsConfigDict(env_prefix="RPD_LOG_", extra="ignore")

    level: str = Field(default="INFO")


@lru_cache
def get_logging_settings() -> LoggingSettings:
    return LoggingSettings()


#: Standard attributes every `logging.LogRecord` has. Anything else found on
#: a record (i.e. passed via `logger.info(..., extra={...})`) is treated as
#: an application-supplied structured field and merged into the JSON output
#: verbatim — this is how `core.observability`'s request-completed log line
#: attaches `http_method`/`http_route`/`http_status`/`duration_ms` without
#: string-formatting them into the free-text `message`.
_RESERVED_RECORD_ATTRS = frozenset(
    {
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "message",
        "taskName",  # Python 3.12+ (asyncio task name)
    }
)


class JsonFormatter(logging.Formatter):
    """One JSON object per line, per the "structured (JSON) logging" P6-T06
    acceptance criterion. Deliberately hand-rolled against the stdlib
    `logging` module rather than pulling in a third-party JSON-logging
    package (`python-json-logger`, `structlog`, ...) — no such dependency
    already existed in `pyproject.toml` (checked before writing this), and
    the format this app needs (timestamp/level/logger/message + a
    `request_id` correlation field + arbitrary `extra=` fields + exception
    tracebacks) is a few dozen lines of stdlib code, not a case for a new
    third-party dependency.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        request_id = request_id_ctx.get(None)
        if request_id is not None:
            payload["request_id"] = request_id

        for key, value in record.__dict__.items():
            if key in _RESERVED_RECORD_ATTRS or key.startswith("_"):
                continue
            payload[key] = value

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack_info"] = self.formatStack(record.stack_info)

        # `default=str`: best-effort serialisation for any non-JSON-native
        # `extra=` value (e.g. a `Decimal`/`uuid.UUID`/`enum.Enum` member) —
        # never raise out of a logging call because a caller passed a
        # slightly-unusual type. Financial/PII values are never passed here
        # in the first place (see module docstring); this is purely a
        # robustness net for otherwise-safe structured fields.
        return json.dumps(payload, default=str)


#: Guards against configuring logging twice in the same process (e.g. a
#: module import order that calls `configure_logging` from more than one
#: entry point) — idempotent by design rather than relying on every caller
#: to only call it once.
_configured = False


def configure_logging(service: str, *, force: bool = False) -> None:
    """Route the root logger through a single stdout `StreamHandler` +
    `JsonFormatter`, per 12-factor logging (stdout/stderr, not a file inside
    the container — `docker compose logs` / `make dev-logs`, per P6-T01's
    `Makefile`, is the log-aggregation surface for this on-premise
    deployment). Called once at process start by `api/main.py` (API/Gunicorn
    worker processes), and by `workers/celery_app.py` /
    `workers/worker_app.py` via Celery's own `setup_logging` signal (which,
    once connected, tells Celery not to apply its own default logging setup
    — see those two modules).

    `service` is attached to every record as a fixed `extra`-style field so
    log lines from `api`/`worker`/`solver-worker` are distinguishable once
    aggregated into one stream (`docker compose logs` interleaves all
    containers by default).
    """

    global _configured
    if _configured and not force:
        return

    settings = get_logging_settings()
    level = getattr(logging, settings.level.upper(), logging.INFO)

    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(JsonFormatter())

    class _ServiceFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            record.service = service
            return True

    handler.addFilter(_ServiceFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    _configured = True
