"""P27 / S26-M1: the hosted static frontend (`render.yaml`) sends a strict CSP
and the framing / referrer / permissions headers.

Guards the two things that silently rot: the inline theme script's SHA-256
in `script-src` must match `frontend/index.html`, and `connect-src` must name
the API origin the build points at (`VITE_API_BASE_URL`).
"""

from __future__ import annotations

import base64
import hashlib
import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest

yaml = pytest.importorskip("yaml")

REPO = Path(__file__).resolve().parents[2]
RENDER = REPO / "render.yaml"
INDEX_HTML = REPO / "frontend" / "index.html"

pytestmark = pytest.mark.skipif(
    not (RENDER.exists() and INDEX_HTML.exists()), reason="repo checkout only"
)


def _static_site() -> dict:
    services = yaml.safe_load(RENDER.read_text(encoding="utf-8"))["services"]
    return next(s for s in services if s["type"] == "static")


def _headers() -> dict[str, str]:
    site = _static_site()
    assert all(h["path"] == "/*" for h in site["headers"])
    return {h["name"]: h["value"] for h in site["headers"]}


def _csp() -> dict[str, list[str]]:
    policy: dict[str, list[str]] = {}
    for part in _headers()["Content-Security-Policy"].split(";"):
        tokens = part.split()
        if tokens:
            policy[tokens[0]] = tokens[1:]
    return policy


def _inline_script_hashes() -> set[str]:
    html = INDEX_HTML.read_text(encoding="utf-8")
    bodies = re.findall(r"<script>(.*?)</script>", html, flags=re.S)
    return {
        "'sha256-" + base64.b64encode(hashlib.sha256(b.encode("utf-8")).digest()).decode() + "'"
        for b in bodies
    }


def test_every_inline_script_is_allowed_by_hash_and_nothing_else_inline():
    script_src = _csp()["script-src"]
    hashes = _inline_script_hashes()
    assert hashes, "index.html has no inline script; drop the hash from render.yaml"
    assert hashes <= set(script_src), (
        "frontend/index.html's inline script changed: update its sha256 in render.yaml "
        f"script-src to {sorted(hashes)}"
    )
    assert "'unsafe-inline'" not in script_src
    assert "'unsafe-eval'" not in script_src
    assert not [s for s in script_src if s.startswith("http") or s in ("*", "data:", "blob:")]


def test_connect_src_is_self_plus_the_built_api_origin():
    env = {e["key"]: e.get("value") for e in _static_site()["envVars"]}
    api = urlsplit(env["VITE_API_BASE_URL"])
    origin = f"{api.scheme}://{api.netloc}"
    assert _csp()["connect-src"] == ["'self'", origin]


def test_policy_is_locked_down():
    csp = _csp()
    assert csp["default-src"] == ["'self'"]
    assert csp["object-src"] == ["'none'"]
    assert csp["base-uri"] == ["'self'"]
    assert csp["form-action"] == ["'self'"]
    assert csp["frame-ancestors"] == ["'none'"]
    assert "upgrade-insecure-requests" in csp
    # Fonts are bundled (@fontsource); no third-party origin anywhere.
    for directive, sources in csp.items():
        assert "*" not in sources, directive
        assert not [s for s in sources if s.startswith("http") and directive != "connect-src"]


def test_framing_referrer_and_permissions_headers():
    h = _headers()
    assert h["X-Frame-Options"] == "DENY"
    assert h["X-Content-Type-Options"] == "nosniff"
    assert h["Referrer-Policy"] == "strict-origin-when-cross-origin"
    perms = h["Permissions-Policy"]
    for feature in ("camera", "microphone", "geolocation", "payment", "usb"):
        assert f"{feature}=()" in perms
