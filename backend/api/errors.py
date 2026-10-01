"""Coded HTTP errors for the P9 endpoints (docs/API_CONTRACT_P9.md §9).

The error envelope is unchanged from P3: `{"detail": str | [{loc, msg, type}],
"code"?: str}`. A plain `HTTPException` produces the envelope without `code`.
Endpoints that return a machine-readable reason use `CodedHTTPException`,
which adds a top-level `code` (for example `LAST_SUPER_ADMIN`, `CYCLE`,
`CATEGORY_WORKFLOW_MISMATCH` or `EDIT_LOCKED`), so the frontend never has to
parse `detail` text.

`coded_http_exception_handler` and `sanitizing_validation_exception_handler`
are both registered on the app in `api/main.py`.
"""

from __future__ import annotations

import math
from typing import Any

from fastapi import HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

#: Plain status integers. Starlette renamed its 413/422 constants
#: (`HTTP_422_UNPROCESSABLE_ENTITY` is deprecated in favour of
#: `HTTP_422_UNPROCESSABLE_CONTENT`); integers keep the P9 code independent
#: of which Starlette version the image resolves.
HTTP_413 = 413
HTTP_422 = 422


class CodedHTTPException(HTTPException):
    """An `HTTPException` that also carries a machine-readable `code`."""

    def __init__(
        self,
        status_code: int,
        code: str,
        detail: str | list[dict[str, Any]],
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.code = code


def field_error(field: str, msg: str, error_type: str = "value_error") -> dict[str, Any]:
    """One entry of a FastAPI-style `detail` list: `{loc, msg, type}`, with
    `loc = ["body", field]`, the same shape Pydantic request validation uses.
    """

    return {"loc": ["body", field], "msg": msg, "type": error_type}


async def coded_http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, CodedHTTPException)
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": exc.code},
        headers=exc.headers,
    )


def _sanitize_non_finite(value: Any) -> Any:
    """Recursively replace `inf`/`-inf`/`nan` floats with their JSON-safe
    string form (`"Infinity"`/`"-Infinity"`/`"NaN"`, the same tokens Python's
    own `json` module would emit if `allow_nan=True`), leaving every other
    value untouched.

    P9-F01 (R04-L1/R04-L2): a request body with a non-finite float (e.g.
    `deterministic_time: Infinity`, `efficiency: NaN`) is correctly REJECTED
    by Pydantic's `allow_inf_nan=False` — but FastAPI's default
    `RequestValidationError` handler echoes the raw offending value back in
    `errors()[i]["input"]`, and Starlette's `JSONResponse.render` hardcodes
    `json.dumps(..., allow_nan=False)`. That combination means the properly-
    rejected request still crashes with an unhandled `ValueError` (a 500, not
    the intended 422) — exactly the security-auditor's P9-R04 live finding
    ("the 422 body cannot be JSON-rendered ... surfacing as 500"). This
    function is applied to the already-`jsonable_encoder`-passed error list
    before it reaches `JSONResponse`, so the 422 always renders.
    """

    if isinstance(value, float) and not math.isfinite(value):
        if value != value:  # noqa: PLR0124 - the standard nan-detection idiom
            return "NaN"
        return "Infinity" if value > 0 else "-Infinity"
    if isinstance(value, dict):
        return {k: _sanitize_non_finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_non_finite(v) for v in value]
    return value


async def sanitizing_validation_exception_handler(
    request: Request, exc: Exception
) -> JSONResponse:
    """Drop-in replacement for FastAPI's default `RequestValidationError`
    handler (same status code and `{"detail": [...]}` shape), with
    `_sanitize_non_finite` applied first. See that function's docstring.
    """

    assert isinstance(exc, RequestValidationError)
    errors = _sanitize_non_finite(jsonable_encoder(exc.errors()))
    return JSONResponse(status_code=HTTP_422, content={"detail": errors})
