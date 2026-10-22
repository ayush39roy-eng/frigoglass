"""P27 / S26-L2 (final security gate): `/docs`, `/redoc` and `/openapi.json`
are served only in dev mode. Outside dev mode they are 404, and the schema is
still available in-process through `app.openapi()` (the contract tests'
method, `tests/test_openapi_frontend_contract.py`).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.main import api_docs_urls, app

BACKEND = Path(__file__).resolve().parents[1]
DOC_PATHS = ("/docs", "/redoc", "/openapi.json")


@pytest.mark.parametrize("value", ["", "false", "0", "no", "off"])
def test_docs_urls_are_none_outside_dev_mode(monkeypatch, value):
    monkeypatch.setenv("RPD_DEV_MODE", value)
    assert api_docs_urls() == {"docs_url": None, "redoc_url": None, "openapi_url": None}


def test_docs_urls_unset_env_is_off(monkeypatch):
    monkeypatch.delenv("RPD_DEV_MODE", raising=False)
    assert set(api_docs_urls().values()) == {None}


def test_docs_urls_in_dev_mode(monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    assert api_docs_urls() == {
        "docs_url": "/docs",
        "redoc_url": "/redoc",
        "openapi_url": "/openapi.json",
    }


def test_an_app_built_outside_dev_mode_serves_no_docs(monkeypatch):
    monkeypatch.delenv("RPD_DEV_MODE", raising=False)
    probe = FastAPI(**api_docs_urls())

    @probe.get("/ping")
    def ping() -> dict[str, str]:
        return {"ok": "yes"}

    with TestClient(probe) as client:
        for path in DOC_PATHS:
            assert client.get(path).status_code == 404, path
    # The schema is still generated in-process.
    assert "/ping" in probe.openapi()["paths"]


_PROBE = """
from fastapi.testclient import TestClient
from api.main import app
client = TestClient(app)
for path in ("/docs", "/redoc", "/openapi.json"):
    print("P27PROBE", path, client.get(path).status_code)
print("P27PROBE", "paths", len(app.openapi()["paths"]))
"""


def _doc_statuses_of_fresh_import(dev_mode: str | None) -> dict[str, int]:
    """Import the real `api.main` in a clean interpreter (the app reads
    `RPD_DEV_MODE` once at import) and GET the three doc paths. No DB is
    touched: those routes have no dependencies."""

    env = {k: v for k, v in os.environ.items() if k != "RPD_DEV_MODE"}
    if dev_mode is not None:
        env["RPD_DEV_MODE"] = dev_mode
    out = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    # The app logs to stdout too; keep only the tagged probe lines.
    probe_lines = [ln.split() for ln in out.stdout.splitlines() if ln.startswith("P27PROBE ")]
    return {key: int(value) for _tag, key, value in probe_lines}


def test_real_app_has_no_doc_routes_outside_dev_mode():
    statuses = _doc_statuses_of_fresh_import(None)
    assert statuses["paths"] > 100  # sanity: the real app, schema still built in-process
    assert {p: statuses[p] for p in DOC_PATHS} == dict.fromkeys(DOC_PATHS, 404)


def test_real_app_has_doc_routes_in_dev_mode():
    statuses = _doc_statuses_of_fresh_import("true")
    assert {p: statuses[p] for p in DOC_PATHS} == dict.fromkeys(DOC_PATHS, 200)


def test_contract_tooling_still_reads_the_schema():
    schema = app.openapi()
    assert schema["info"]["title"] == "RPD Web Application API"
    assert "WorkspacePriorityScore" in schema["components"]["schemas"]
