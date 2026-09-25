"""Gunicorn configuration for the `api` Docker Compose service (P6-T06).

Routes Gunicorn's own access/error logs — and, transitively,
`uvicorn.error`/`uvicorn.access` (Gunicorn's `UvicornWorker` defers to
Gunicorn's own logging configuration rather than setting up its own) —
through the same `core.logging_config.JsonFormatter` used by application
code, so EVERY line this container writes to stdout is one JSON object, not
a mix of JSON app logs and Gunicorn's plain-text access-log format.

`access_log_format` is deliberately overridden to `%(h)s "%(m)s %(U)s" ...`
— `%(U)s` (URL PATH ONLY) instead of the default `%(r)s` (full request
line, which includes the query string). No endpoint in this app currently
puts a financial/customer/engineer-utilization value in a query string
(checked: `grep -rn "Query(" api/routers/*.py` returns nothing — every
filterable endpoint takes filters in a POST body, not query params), but
this is a structural guarantee against that ever changing silently, per
CLAUDE.md's "never logged" non-negotiable — defense in depth, not just
"nothing to fix today".

Referenced from `docker-compose.yml`'s `api` service command
(`--config gunicorn_conf.py`) and `Dockerfile`'s CMD (same flag, for anyone
running the image directly without Compose).
"""

from __future__ import annotations

import os

_port = os.environ.get("PORT", "8000")
bind = f"0.0.0.0:{_port}"
workers = 4
worker_class = "uvicorn.workers.UvicornWorker"

accesslog = "-"
errorlog = "-"
access_log_format = '%(h)s "%(m)s %(U)s" %(s)s %(b)s %(D)sus'

_level = os.environ.get("RPD_LOG_LEVEL", "info").upper()
loglevel = _level.lower()

logconfig_dict = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {"()": "core.logging_config.JsonFormatter"},
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "json",
            "stream": "ext://sys.stdout",
        },
    },
    "root": {"handlers": ["console"], "level": _level},
    "loggers": {
        "gunicorn.error": {"handlers": ["console"], "level": _level, "propagate": False},
        "gunicorn.access": {"handlers": ["console"], "level": _level, "propagate": False},
        "uvicorn": {"handlers": ["console"], "level": _level, "propagate": False},
        "uvicorn.error": {"handlers": ["console"], "level": _level, "propagate": False},
        "uvicorn.access": {"handlers": ["console"], "level": _level, "propagate": False},
    },
}
