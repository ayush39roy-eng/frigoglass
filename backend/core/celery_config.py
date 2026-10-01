"""Redis + Celery configuration — env-driven, per CLAUDE.md's "no secrets in
the repo" / "no hardcoded environment-specific values" rules and this repo's
established `RPD_<AREA>_` `pydantic-settings` `BaseSettings` convention (see
`core/config.py`'s `OIDCSettings` — same pattern: no default for anything
that must be explicitly configured per-environment, `lru_cache`-wrapped
singleton getter).

**One Redis instance backs three distinct uses in this codebase** — documented
here since it is a deliberate simplification, not an oversight:

1. Celery broker (task queue) — `workers/celery_app.py`.
2. Celery result backend (task state/return-value storage) — same module.
3. Solver-progress pub/sub (`workers/progress.py`) — a plain Redis
   PUBLISH/SUBSCRIBE channel, entirely separate from Celery's own queue/
   result machinery, sharing the same Redis server purely for deployment
   simplicity (one `redis:7` container in Docker Compose, not three).

A single `RPD_REDIS_URL` covers all three uses below. If a future phase needs
to split them apart (e.g. a dedicated pub/sub-only Redis instance for
horizontal scaling, or a different broker entirely), that is a config-only
change (a new env var + a second settings field) — flagged here as a real,
considered decision for this task (P3-T06), not a limitation nobody thought
about.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class RedisSettings(BaseSettings):
    """Mirroring RPD_DATABASE_URL convention, accepts RPD_REDIS_URL or REDIS_URL,
    defaulting to redis://localhost:6379/0 if unspecified.
    """

    model_config = SettingsConfigDict(env_prefix="RPD_", extra="ignore")

    #: e.g. `redis://localhost:6379/0` (dev) or a real Redis/Sentinel/Cluster
    #: DSN in production. Used as both the Celery broker and result backend
    #: (`workers/celery_app.py`), and as the connection this process's
    #: `workers.progress.publish_progress` / (P3-T05's) SSE subscriber use.
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias=AliasChoices("RPD_REDIS_URL", "REDIS_URL"),
    )


@lru_cache
def get_redis_settings() -> RedisSettings:
    """Cached singleton — see `core.config.get_oidc_settings`'s identical
    rationale. Tests that need a different value call `.cache_clear()` first.
    """

    return RedisSettings()


class CelerySettings(BaseSettings):
    """Task-execution tuning knobs — kept as a separate settings class (its
    own `RPD_CELERY_` prefix) from `RedisSettings` since these are
    Celery-task-shape/solver-budget concerns, not connection config.
    """

    model_config = SettingsConfigDict(env_prefix="RPD_CELERY_", extra="ignore")

    #: Hard kill ceiling for the *whole* Celery task (DB I/O + the CP-SAT
    #: solve itself + persistence) — `workers/celery_app.py`'s
    #: `task_time_limit`. This is the only wall-clock limit left: the solver's
    #: own budget is deterministic time (`cp_sat_deterministic_time` below),
    #: so this must stay comfortably above the slowest expected solve.
    task_time_limit_seconds: int = Field(default=900, ge=1)

    #: P9-R02b (DOMAIN_RULES "Gate remediation rulings" #6): the CP-SAT pass-1
    #: budget in deterministic-time units, forwarded to
    #: `scheduling.cp_sat.run_cp_sat(deterministic_time=...)` unless a
    #: per-dispatch override is supplied on `POST
    #: /schedule-runs/cp-sat-dispatch`. `None` (the default) keeps the
    #: solver's own default (`scheduling/cp_sat.py::DEFAULT_DETERMINISTIC_TIME`).
    #: Replaces the retired wall-clock `cp_sat_max_time_in_seconds`; a stale
    #: `RPD_CELERY_CP_SAT_MAX_TIME_IN_SECONDS` env var is ignored
    #: (`extra="ignore"`).
    cp_sat_deterministic_time: float | None = Field(default=None, gt=0)


@lru_cache
def get_celery_settings() -> CelerySettings:
    return CelerySettings()
