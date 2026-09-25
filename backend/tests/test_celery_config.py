"""Unit tests for `core.celery_config` — the env-driven Redis/Celery settings
module (P3-T06), mirroring `core.config.OIDCSettings`' own "no default
issuer/audience, fails loudly, lru_cache singleton" tests in spirit (see
`tests/test_core_oidc.py` for that precedent; no direct equivalent test file
existed for `OIDCSettings` itself, so this is this module's own from-scratch
coverage of the same pattern).
"""

from __future__ import annotations

import pydantic
import pytest

from core.celery_config import (
    CelerySettings,
    RedisSettings,
    get_celery_settings,
    get_redis_settings,
)


def test_redis_settings_default_fallback(monkeypatch):
    monkeypatch.delenv("RPD_REDIS_URL", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)
    settings = RedisSettings()
    assert settings.redis_url == "redis://localhost:6379/0"


def test_redis_settings_reads_env_var(monkeypatch):
    monkeypatch.setenv("RPD_REDIS_URL", "redis://example.test:6379/2")
    settings = RedisSettings()
    assert settings.redis_url == "redis://example.test:6379/2"


def test_redis_settings_reads_plain_redis_url(monkeypatch):
    monkeypatch.delenv("RPD_REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_URL", "redis://render.test:6379/0")
    settings = RedisSettings()
    assert settings.redis_url == "redis://render.test:6379/0"


def test_get_redis_settings_is_cached_singleton(monkeypatch):
    monkeypatch.setenv("RPD_REDIS_URL", "redis://a.test:6379/0")
    get_redis_settings.cache_clear()
    first = get_redis_settings()
    second = get_redis_settings()
    assert first is second
    get_redis_settings.cache_clear()


def test_celery_settings_defaults():
    settings = CelerySettings()
    assert settings.task_time_limit_seconds == 900
    assert settings.cp_sat_max_time_in_seconds == 60.0


def test_celery_settings_env_override(monkeypatch):
    monkeypatch.setenv("RPD_CELERY_TASK_TIME_LIMIT_SECONDS", "120")
    monkeypatch.setenv("RPD_CELERY_CP_SAT_MAX_TIME_IN_SECONDS", "5.5")
    settings = CelerySettings()
    assert settings.task_time_limit_seconds == 120
    assert settings.cp_sat_max_time_in_seconds == 5.5


def test_celery_settings_rejects_non_positive_time_limit():
    with pytest.raises(pydantic.ValidationError):
        CelerySettings(task_time_limit_seconds=0)


def test_celery_settings_rejects_non_positive_cp_sat_time():
    with pytest.raises(pydantic.ValidationError):
        CelerySettings(cp_sat_max_time_in_seconds=0)


def test_get_celery_settings_is_cached_singleton():
    get_celery_settings.cache_clear()
    first = get_celery_settings()
    second = get_celery_settings()
    assert first is second
    get_celery_settings.cache_clear()
