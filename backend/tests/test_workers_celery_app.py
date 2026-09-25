"""`workers/celery_app.py` — confirms the `Celery` app object is built with
the documented config (broker/backend from `RPD_REDIS_URL`, JSON
serialization, `task_acks_late=False`, task time limit from
`RPD_CELERY_TASK_TIME_LIMIT_SECONDS`). Constructing a `Celery(...)` instance
never itself opens a network connection (Celery/`kombu` connect lazily, on
first actual broker operation) — so this is a legitimate, fast, no-Docker-
needed unit test of the app's *configuration*, not a substitute for this
task's live verification of an actual worker process picking up and
executing a real task (see `docs/MEMORY.md`'s P3-T06 entry).
"""

from __future__ import annotations

from workers.celery_app import celery_app
from workers.schedule_tasks import TASK_NAME


def test_celery_app_name():
    assert celery_app.main == "rpd_solver_worker"


def test_celery_app_broker_and_backend_use_configured_redis_url():
    # conftest.py defaults RPD_REDIS_URL to redis://localhost:6379/0 for the
    # whole test process (see that module's own docstring note).
    assert celery_app.conf.broker_url.startswith("redis://")
    assert celery_app.conf.result_backend.startswith("redis://")


def test_celery_app_serialization_is_json_only():
    assert celery_app.conf.task_serializer == "json"
    assert celery_app.conf.result_serializer == "json"
    assert celery_app.conf.accept_content == ["json"]


def test_celery_app_acks_late_is_disabled():
    """See `workers/celery_app.py`'s module docstring: paired deliberately
    with this task's cancellation design (early ack -> a terminated task is
    never redelivered to another worker).
    """

    assert celery_app.conf.task_acks_late is False


def test_celery_app_task_time_limit_is_configured():
    assert celery_app.conf.task_time_limit == 900


def test_celery_app_registers_run_cp_sat_schedule_task():
    # `include=["workers.schedule_tasks"]` on the Celery app + this test's
    # own import of that module (below) is enough to trigger task
    # registration under Celery's global registry.
    import workers.schedule_tasks  # noqa: F401

    assert TASK_NAME in celery_app.tasks
