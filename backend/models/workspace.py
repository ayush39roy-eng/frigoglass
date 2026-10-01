"""Project Workspace (docs/PROJECT_AND_STACK.md §2, Surface #7) persistence:
file attachments and comments. P8-T01's data-model bullet, absorbed into
P9-T01 verbatim.

Both tables are project-scoped and therefore go through the hub-scoping
layer like every other project read (P3-T03). Neither carries financial
data. `ProjectComment` author/mention columns and `ProjectFile.uploaded_by`
are user references — ordinary account data, but their *display* alongside
engineer names is gated by docs/OPEN_QUESTIONS.md #8 (GDPR) at the API layer.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import ProjectFileCategory

if TYPE_CHECKING:
    from models.project import Project
    from models.user import User


class ProjectFile(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One uploaded file version attached to a project. The bytes live in
    MinIO under `minio_object_key`; this row is the metadata. Re-uploading a
    file with the same `display_name` creates a new row with `version + 1`
    (unique on `(project_id, display_name, version)`), never overwrites.
    """

    __tablename__ = "project_files"

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[ProjectFileCategory] = mapped_column(
        Enum(
            ProjectFileCategory,
            name="project_file_category",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
        default=ProjectFileCategory.OTHER,
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    uploaded_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_type: Mapped[str] = mapped_column(String(255), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    #: Object key inside the MinIO bucket (`core/minio_config.py`). Unique —
    #: two rows never share bytes.
    minio_object_key: Mapped[str] = mapped_column(String(1024), nullable=False, unique=True)

    project: Mapped[Project] = relationship(back_populates="files")
    uploaded_by: Mapped[User] = relationship()

    __table_args__ = (
        UniqueConstraint(
            "project_id", "display_name", "version", name="uq_project_files_name_version"
        ),
        CheckConstraint("size_bytes >= 0", name="size_non_negative"),
        CheckConstraint("version >= 1", name="version_positive"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<ProjectFile {self.display_name!r} v{self.version}>"


class ProjectComment(TimestampMixin, Base):
    """A Markdown comment on a project's Activity & Comments panel.

    **Never hard-deleted**: deletion sets `soft_deleted_at`; the DB trigger
    `trg_project_comments_no_delete` (P9-T01 migration) rejects a physical
    `DELETE`, mirroring the audit log's append-only protection. `edited_at`
    is set on every body edit. `mentioned_user_ids` is the list of `User.id`s
    @mentioned in `body_md` (notification fan-out, P9-T03; display gated by
    docs/OPEN_QUESTIONS.md #8).
    """

    __tablename__ = "project_comments"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    body_md: Mapped[str] = mapped_column(Text, nullable=False)
    author_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    soft_deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    mentioned_user_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)

    project: Mapped[Project] = relationship(back_populates="comments_thread")
    author: Mapped[User] = relationship()

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<ProjectComment {self.id} project={self.project_id}>"
