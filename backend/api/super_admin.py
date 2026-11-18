"""ADR 0058 D1: destructive actions are Super Admin only.

One helper for every guarded point, so the rule and the error are spelled
once:

- `is_super_admin(principal)`: true iff the caller holds `Super Admin`.
- `ensure_super_admin(principal)`: raises the 403 below for any other caller,
  Admin included. For in-handler checks that fire only on the destructive
  variant of a write (a status set to Cancelled, `is_active` set to false, a
  role removed, a scenario saved by someone else).

Each guarded route keeps its own permission dependency first, so a caller
without that permission keeps its existing 401 / 403; the Super Admin check
runs at the top of the handler (or, for the conditional cases, exactly where
the destructive variant is detected).

The error is a 403 with `code = "SUPER_ADMIN_ONLY"`, the same envelope as every
other `CodedHTTPException`. The server is the authority; the frontend only
hides or disables the controls (ADR 0058).
"""

from __future__ import annotations

from fastapi import status

from api.errors import CodedHTTPException
from core.principal import Principal
from models.enums import RoleName

SUPER_ADMIN_ONLY = "SUPER_ADMIN_ONLY"


def is_super_admin(principal: Principal) -> bool:
    return RoleName.SUPER_ADMIN in principal.roles


def super_admin_only_error() -> CodedHTTPException:
    return CodedHTTPException(
        status.HTTP_403_FORBIDDEN,
        SUPER_ADMIN_ONLY,
        "Only a Super Admin can do this.",
    )


def ensure_super_admin(principal: Principal) -> None:
    if not is_super_admin(principal):
        raise super_admin_only_error()
