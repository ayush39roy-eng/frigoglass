"""`core/celery_logging.py` — the Celery `setup_logging`/`task_prerun`/
`task_postrun` signal wiring shared by `workers/celery_app.py` /
`workers/worker_app.py` (P6-T06). `workers/celery_app.py` and
`workers/worker_app.py` already call `install_celery_logging`/
`install_task_duration_logging` at import time (both modules are imported
elsewhere in the suite — `tests/test_workers_celery_app.py` etc.) — this
file adds direct coverage of the signal-handler bodies themselves (duration
computed, `task_completed` log line emitted, never includes task arguments).
"""

from __future__ import annotations

import logging

from workers.worker_app import worker_app


def test_task_completion_emits_structured_task_completed_log_line(caplog):
    caplog.set_level(logging.INFO, logger="celery.task_metrics")

    @worker_app.task(name="tests._celery_logging_probe_task")
    def _probe_task(secret_argument: str) -> str:
        return "ok"

    _probe_task.apply(args=("this-argument-must-never-be-logged",))

    task_completed_records = [
        r
        for r in caplog.records
        if r.name == "celery.task_metrics" and r.message == "task_completed"
    ]
    assert task_completed_records, "expected a task_completed log record"

    record = task_completed_records[-1]
    assert record.task_name == "tests._celery_logging_probe_task"
    assert record.state == "SUCCESS"
    assert record.duration_seconds is not None
    assert record.duration_seconds >= 0

    # Never logs the task's own arguments (module docstring's explicit
    # promise — an export task's filters payload might not be safe to log,
    # even though this probe task's argument happens to be harmless).
    rendered = str(record.__dict__)
    assert "this-argument-must-never-be-logged" not in rendered
