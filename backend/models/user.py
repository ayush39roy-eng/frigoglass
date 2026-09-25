from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import RoleName

if TYPE_CHECKING:
    from models.engineer import Engineer
    from models.hub import Hub


class Role(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One of the six roles in docs/PROJECT_AND_STACK.md §5's RBAC matrix. Kept
    as a real table (not a bare enum on User) so Admin can manage role
    membership and so the permission matrix has a stable FK target if it grows
    a `Permission` table in a later phase — P1-T01 does not need one yet since
    v1's permission matrix is fixed per role, not dynamically composable.
    """

    __tablename__ = "roles"

    name: Mapped[RoleName] = mapped_column(String(50), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)

    user_roles: Mapped[list[UserRole]] = relationship(back_populates="role")


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """An authenticated principal. Identity comes from OIDC (P3-T02); this table
    holds the application-side profile, role assignment(s) and hub scoping used
    for RBAC + row-level filtering (docs/PROJECT_AND_STACK.md §5).
    """

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    #: The `sub` claim from the OIDC IdP (P3-T02). Nullable so a user record can
    #: be provisioned (e.g. by Admin, or seed data) before first SSO login.
    oidc_subject: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)

    #: True for roles that see all hubs by RBAC definition (Portfolio Manager,
    #: Executive Viewer, Auditor, Admin per docs/PROJECT_AND_STACK.md §5) rather
    #: than an explicit UserHubScope row per hub. A Hub Planner has this False
    #: and is scoped via `hub_scopes` instead. The data-access layer (P3-T03)
    #: must check this flag, not merely the absence of hub_scopes rows, so
    #: "scoped to zero hubs" (a misconfiguration) can never be silently read as
    #: "scoped to all hubs".
    hub_scope_all: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    roles: Mapped[list[UserRole]] = relationship(back_populates="user")
    hub_scopes: Mapped[list[UserHubScope]] = relationship(back_populates="user")
    engineer: Mapped[Engineer | None] = relationship(back_populates="user")

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<User {self.email!r}>"


class UserRole(Base):
    """User <-> Role, many-to-many. A user may hold more than one role even
    though the RBAC matrix in docs/PROJECT_AND_STACK.md §5 is expressed per
    single role — kept many-to-many for flexibility (e.g. a Hub Planner who is
    also an Auditor), enforced/reconciled at the API layer (P3).
    """

    __tablename__ = "user_roles"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"), primary_key=True)

    user: Mapped[User] = relationship(back_populates="roles")
    role: Mapped[Role] = relationship(back_populates="user_roles")


class UserHubScope(Base):
    """User <-> Hub, many-to-many. Explicit row-level hub scoping for Hub
    Planners (docs/PROJECT_AND_STACK.md §5: "scoped to their assigned hub(s)").
    Irrelevant (ignored by the data-access layer) when `User.hub_scope_all` is
    True.
    """

    __tablename__ = "user_hub_scopes"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    hub_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("hubs.id"), primary_key=True)

    user: Mapped[User] = relationship(back_populates="hub_scopes")
    hub: Mapped[Hub] = relationship(back_populates="user_scopes")
