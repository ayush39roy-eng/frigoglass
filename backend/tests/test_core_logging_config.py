"""`core/logging_config.py` — the JSON formatter + `configure_logging` setup
shared by `api`/`worker`/`solver-worker` (P6-T06). Confirms the actual
"structured, no-PII-by-construction" shape: valid JSON, request-id
correlation via the contextvar, `extra=` fields merged in, and that
`configure_logging` is idempotent (safe to call more than once).
"""

from __future__ import annotations

import json
import logging

import pytest

from core.logging_config import JsonFormatter, configure_logging, request_id_ctx


@pytest.fixture(autouse=True)
def _restore_root_logger_state():
    """`configure_logging` mutates the ROOT logger's handlers globally
    (by design — see that function's docstring). Snapshot/restore around
    every test in this module so this file never leaks logging-handler
    state into the rest of the suite (e.g. pytest's own log-capture
    machinery, or any later test module that imports something with a
    module-level logger).
    """

    root = logging.getLogger()
    original_handlers = list(root.handlers)
    original_level = root.level
    import core.logging_config as logging_config_module

    original_configured = logging_config_module._configured
    try:
        yield
    finally:
        root.handlers = original_handlers
        root.setLevel(original_level)
        logging_config_module._configured = original_configured


def _make_record(**extra: object) -> logging.LogRecord:
    record = logging.LogRecord(
        name="some.logger",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="a message with %s",
        args=("placeholder",),
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_json_formatter_produces_valid_json_with_expected_core_fields():
    formatter = JsonFormatter()
    record = _make_record()

    parsed = json.loads(formatter.format(record))

    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "some.logger"
    assert parsed["message"] == "a message with placeholder"
    assert "timestamp" in parsed
    assert "request_id" not in parsed  # no request in flight for this record


def test_json_formatter_includes_request_id_from_contextvar():
    formatter = JsonFormatter()
    token = request_id_ctx.set("test-request-id-123")
    try:
        parsed = json.loads(formatter.format(_make_record()))
    finally:
        request_id_ctx.reset(token)

    assert parsed["request_id"] == "test-request-id-123"


def test_json_formatter_merges_extra_fields():
    formatter = JsonFormatter()
    record = _make_record(http_status=200, duration_ms=12.5)

    parsed = json.loads(formatter.format(record))

    assert parsed["http_status"] == 200
    assert parsed["duration_ms"] == 12.5


def test_json_formatter_includes_exception_traceback_when_present():
    formatter = JsonFormatter()
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        record = _make_record()
        record.exc_info = sys.exc_info()

    parsed = json.loads(formatter.format(record))

    assert "ValueError: boom" in parsed["exc_info"]


def test_configure_logging_is_idempotent_and_installs_json_handler():
    configure_logging("test-service", force=True)
    root = logging.getLogger()
    assert len(root.handlers) == 1
    assert isinstance(root.handlers[0].formatter, JsonFormatter)

    # A second call without force=True must not add a second handler.
    configure_logging("test-service")
    assert len(root.handlers) == 1
