"""Scenario Apply — versioned pre-apply snapshots of whatever rows a
scenario edit touches, per `docs/PROJECT_AND_STACK.md` §4:

    "A 'scenario' (in-progress edit to priorities, capacity, or project data
    not yet committed) is held in frontend Zustand state and, on 'Apply',
    POSTed as a diff against the last committed version. The backend
    snapshots the pre-apply state to Postgres (versioned row set) before
    writing the new state, so every Apply is reversible and every historical
    version is queryable (Versions & History, §2)."

**Relationship to `models/schedule.py` and `models/priority.py`'s existing
versioned-snapshot tables** (read before extending this module): this is a
DIFFERENT, new mechanism, not a duplicate of either —

- `ScheduleRun`/`ScheduleRunProjectStep`/`ScheduleRunProjectOutcome` snapshot
  the OUTPUT of the scheduler (a computed schedule), not a user's edit to
  input rows.
- `PriorityApplicationRun`/`PriorityApplicationResult` snapshot the
  COMPUTED band/score RESULT of one "Apply Priorities" portfolio-wide action
  (weighted_score/normalized_pct/suggested_band/set_priority per project) —
  not a generic "what did this row look like right before someone changed
  it" record, and it has no `before_state`/`after_state` shape at all.

`ScenarioApplyRun`/`ScenarioApplyChange` below are the generic mechanism this
task (P5-T02) was asked to build: for an arbitrary set of rows a scenario
diff touches, capture the PRE-APPLY (`before_state`) and POST-APPLY
(`after_state`) values of each one, keyed by `entity_type`/`entity_id`, so
that (a) every historical Apply is queryable ("Versions & History", §2) and
(b) a revert-to-version-N is at least conceptually reconstructible by
re-writing every touched row's `before_state` back onto the live table (the
revert *endpoint* is explicitly P5-T03's job, not this one — see that task's
scope note).

**P5-T02 scope**: only `ScenarioEntityType.PRIORITY_SCORE` has a real write
path today (`services/scenario_apply.py`'s `apply_priority_score_changes`,
called from `POST /scenarios/apply`) — see `models/enums.py`'s
`ScenarioEntityType` docstring for why `PROJECT`/`ENGINEER`/`CHAMBER` exist
as enum values already (so a follow-up task can add their write paths
without another migration) despite having no writer yet.

**Financial fields**: `PriorityScore` (the only entity type with a real
write path in this task) has no financial columns at all — its
`before_state`/`after_state` JSONB blobs are exactly
`services.audit_helpers.priority_score_audit_state(...)`'s output, the same
redaction-audited helper `api/routers/priorities.py`'s own `AuditLogEntry`
rows use. If/when `PROJECT` gets a real write path here, its snapshots MUST
go through `services.audit_helpers.project_audit_state(...)` (which
hard-redacts `customer_name`/`tcogs_eur`/`selling_price_eur`/
`gross_margin_pct` to the literal string `"<redacted>"`, never the real
value) — never a raw `__dict__`/`vars()` dump of a `Project` ORM instance.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ARRAY, Enum, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import ScenarioEntityType

if TYPE_CHECKING:
    from models.hub import Hub
    from models.project import Project
    from models.user import User


class ScenarioApplyRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One "Apply" action on a scenario edit (Prioritization Matrix, Capacity
    Planning, or Project Registration — per `docs/PROJECT_AND_STACK.md` §4),
    versioned per the cross-cutting "Versions & History" requirement.
    Mirrors the `ScheduleRun` / `PriorityApplicationRun` versioning pattern
    in `models/schedule.py` / `models/priority.py`, but generalised to
    arbitrary row-level before/after snapshots (see module docstring) rather
    than either scheduler output or computed priority bands.

    Unlike `ScheduleRun.is_active`/`PriorityApplicationRun.is_active`, there
    is no "only one active" partial-unique-index concept here — every Apply
    is simply a new, immutable, append-in-spirit version. There is nothing
    to "activate": the live `PriorityScore`/`Project`/`Engineer`/`Chamber`
    rows this Apply wrote to are already the current state as of this
    row's `created_at`, and every prior version's rows remain individually
    queryable via `changes` regardless.
    """

    __tablename__ = "scenario_apply_runs"

    version: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)
    applied_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    #: Optional free-text description of the scenario edit, supplied by the
    #: caller (e.g. the frontend's Zustand scenario-diff description).
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: Cached, denormalised summary of the distinct `ScenarioEntityType`
    #: values touched by this run's `changes` — computed once at apply time
    #: from the rows actually written (never independently editable), so the
    #: P5-T03 "Versions & History" list view can render a summary without an
    #: extra join/aggregate query per row. `values_callable`-style Enum
    #: storage is unnecessary here since this is a cache of `.value` strings,
    #: not a column whose own values are ever queried/filtered by enum
    #: identity.
    entity_types_touched: Mapped[list[str]] = mapped_column(
        ARRAY(String(50)), nullable=False, default=list
    )
    #: Cached count of `changes` rows, same rationale as above.
    change_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    applied_by: Mapped[User | None] = relationship()
    changes: Mapped[list[ScenarioApplyChange]] = relationship(
        back_populates="run",
        order_by="ScenarioApplyChange.entity_type, ScenarioApplyChange.entity_id",
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<ScenarioApplyRun v{self.version} changes={self.change_count}>"


class ScenarioApplyChange(Base):
    """Immutable per-row pre/post snapshot of one entity touched by a single
    `ScenarioApplyRun`. `before_state=None` means this row did not exist
    before the Apply (a create); `after_state` is always populated (a
    Scenario Apply never deletes a row in this task's scope).

    `project_id`/`hub_id` are populated for every entity type this task
    supports (`PRIORITY_SCORE` only — `project_id` is the *scored* project's
    id, `hub_id` that project's hub) specifically so:

    1. `services.hub_scope.hub_scope_filter` can be composed directly against
       `hub_id` for row-level hub-scoped read access to Versions & History,
       matching every other hub-scoped surface in this codebase, without
       inventing a new scoping shape.
    2. A future revert path can resolve "which live row does this snapshot
       correspond to" without re-deriving it from `before_state`/
       `after_state` JSON, which is a redacted/lossy view by design (see
       module docstring) and must never be the source of truth for a
       structural lookup.

    Both are nullable because a future `ENGINEER`/`CHAMBER` writer may have
    no natural single `project_id` (an Engineer or Chamber is not scoped to
    one project) — `hub_id` alone (still resolvable for Engineer; Chamber
    has no `hub_id` at all, see `services/hub_scope.py`'s module docstring)
    would still support scoping for those future entity types without a
    schema change.
    """

    __tablename__ = "scenario_apply_changes"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    scenario_apply_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scenario_apply_runs.id"), nullable=False
    )

    entity_type: Mapped[ScenarioEntityType] = mapped_column(
        Enum(
            ScenarioEntityType,
            name="scenario_entity_type",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    #: `str(<row's own primary key>)` — e.g. `str(PriorityScore.id)` for
    #: `PRIORITY_SCORE`, matching `AuditLogEntry.entity_id`'s convention
    #: (`services/audit_helpers.py`'s callers already do `str(score.id)`).
    entity_id: Mapped[str] = mapped_column(String(100), nullable=False)

    project_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("projects.id"), nullable=True)
    hub_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("hubs.id"), nullable=True)

    #: Redacted snapshots, same shape/rules as `AuditLogEntry.before_state`/
    #: `after_state` (`models/audit.py`) — see this module's docstring for
    #: the financial-field redaction requirement once a `PROJECT` writer
    #: exists.
    before_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_state: Mapped[dict] = mapped_column(JSONB, nullable=False)

    run: Mapped[ScenarioApplyRun] = relationship(back_populates="changes")
    project: Mapped[Project | None] = relationship()
    hub: Mapped[Hub | None] = relationship()

    __table_args__ = (
        UniqueConstraint(
            "scenario_apply_run_id",
            "entity_type",
            "entity_id",
            name="uq_scenario_apply_change_run_entity",
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<ScenarioApplyChange {self.entity_type}:{self.entity_id}>"
