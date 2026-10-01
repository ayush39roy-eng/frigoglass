"""User / role administration (docs/API_CONTRACT_P9.md §2, ADR 0010 §3).

There are no passwords: sign-in is OIDC, and a user created here is linked
to an IdP identity by email on first login (P3-T02 JIT link).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from models.enums import RoleName

#: A deliberately plain shape check (one `@`, no whitespace, a dot in the
#: domain). Deliverability is the IdP's business; this only stops obvious
#: typos. Kept as a pattern to avoid adding `email-validator` as a dependency.
_EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


def _dedupe_roles(roles: list[RoleName]) -> list[RoleName]:
    return list(dict.fromkeys(roles))


def _normalise_email(value: str | None) -> str | None:
    return None if value is None else value.strip().lower()


class UserRead(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    is_active: bool
    roles: list[RoleName]
    hub_scope_all: bool
    hub_ids: list[uuid.UUID]
    engineer_id: uuid.UUID | None
    #: 2026-09-30 (ADR 0012): the direct manager for grant delegation
    #: (`services.project_access.can_manage_grant`'s "U.manager_id == M.id"
    #: check). `null` means no manager set.
    manager_id: uuid.UUID | None
    #: True once the account has been linked to an OIDC identity (`sub`).
    oidc_linked: bool
    created_at: datetime
    updated_at: datetime


class UserList(BaseModel):
    total_count: int
    items: list[UserRead]


class UserCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(max_length=320, pattern=_EMAIL_PATTERN)
    full_name: str = Field(min_length=1, max_length=200)
    roles: list[RoleName] = Field(default_factory=list)
    hub_scope_all: bool = False
    hub_ids: list[uuid.UUID] = Field(default_factory=list)
    engineer_id: uuid.UUID | None = None

    @field_validator("roles")
    @classmethod
    def _dedupe(cls, roles: list[RoleName]) -> list[RoleName]:
        return _dedupe_roles(roles)

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        return value.strip().lower()

    @model_validator(mode="after")
    def _forbid_engineer_hub_scope_all(self) -> UserCreateRequest:
        """P10-F01 (security remediation, High): an Engineer-only account
        must never carry `hub_scope_all=True` —
        `services.hub_scope.is_engineer_self_scoped`'s own docstring relies
        on "a pure Engineer principal has `hub_scope_all=False`" as an
        invariant; this is what actually enforces it at creation time,
        rather than leaving it as an assumption an Admin could silently
        violate (the P10-F01 finding's root cause — this exact combination
        was also the real `seed_dev_users.py`/
        `tests/factories.py::make_user` default before this fix). Multi-role
        accounts (Engineer plus a broader role, e.g. also Hub Planner) are
        unaffected: `set(self.roles) == {ENGINEER}` only matches an
        Engineer-only role set.
        """

        if set(self.roles) == {RoleName.ENGINEER} and self.hub_scope_all:
            raise ValueError(
                "An Engineer-only account may not have hub_scope_all=True — Engineer is "
                "always scoped to their own assignments, never to every hub."
            )
        return self


class UserUpdateRequest(BaseModel):
    """Any subset of the create fields plus `is_active`. A field that is
    absent is left unchanged; `engineer_id: null` unlinks the engineer.
    """

    model_config = ConfigDict(extra="forbid")

    email: str | None = Field(default=None, max_length=320, pattern=_EMAIL_PATTERN)
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    roles: list[RoleName] | None = None
    hub_scope_all: bool | None = None
    hub_ids: list[uuid.UUID] | None = None
    engineer_id: uuid.UUID | None = None
    is_active: bool | None = None
    #: 2026-09-30 (ADR 0012). Writable only by Super Admin/global Admin (the
    #: existing `USER_ROLE_ADMIN` WRITE guard already limits this endpoint to
    #: those two roles). `null` clears the manager link. Self
    #: (`manager_id == id`) and any longer reporting-line cycle are rejected
    #: — see `api/routers/users.py::_update_user`.
    manager_id: uuid.UUID | None = None

    @field_validator("roles")
    @classmethod
    def _dedupe(cls, roles: list[RoleName] | None) -> list[RoleName] | None:
        return None if roles is None else _dedupe_roles(roles)

    @field_validator("email")
    @classmethod
    def _email(cls, value: str | None) -> str | None:
        return _normalise_email(value)

    @model_validator(mode="after")
    def _forbid_engineer_hub_scope_all(self) -> UserUpdateRequest:
        """Same P10-F01 guard as `UserCreateRequest`, for the common case
        where a single PATCH sets both `roles` and `hub_scope_all` together.
        This alone cannot catch every case (e.g. `hub_scope_all=True` set
        without touching `roles` on an account that is already
        Engineer-only, or `roles` set to Engineer-only without touching an
        existing `hub_scope_all=True`) — those need the target account's
        current DB state, which a Pydantic validator never has;
        `api/routers/users.py::_update_user` re-checks the fully merged
        (current DB state + this patch) role set/`hub_scope_all` for that
        reason, via the same underlying rule.
        """

        if (
            self.roles is not None
            and set(self.roles) == {RoleName.ENGINEER}
            and self.hub_scope_all is True
        ):
            raise ValueError(
                "An Engineer-only account may not have hub_scope_all=True — Engineer is "
                "always scoped to their own assignments, never to every hub."
            )
        return self


class RoleRead(BaseModel):
    name: RoleName
    description: str
    #: False for Admin / Super Admin when the caller is an Admin (only a
    #: Super Admin grants those, ADR 0010 §1).
    assignable: bool


class MentionCandidate(BaseModel):
    """One `GET /users/mention-search` hit. The endpoint returns none while
    docs/OPEN_QUESTIONS.md #8 is open. See `api/routers/users.py`.
    """

    user_id: uuid.UUID
    display: str
