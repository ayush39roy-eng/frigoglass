"""Enums whose member *values* (not just names) must match `docs/DOMAIN_RULES.md`'s
vocabulary exactly, since the frontend, exports, and the (future) scheduling
dataclasses all serialise/compare on these string values, not Python identifiers.

Sourcing note: DOMAIN_RULES.md is authoritative for every enum below except
`ProjectType` and `ProjectStatus.DRAFT`, which it does not enumerate. Those two
gaps are filled from `reference/rpd-platform-prototype.html` (cross-checked, see
docs/MEMORY.md P1-T01 entry) and from `docs/PROJECT_AND_STACK.md` §2's mention of
a "draft status" gate on Project Registration, respectively. Flagged for
orchestrator review.
"""

from __future__ import annotations

import enum


class HubName(str, enum.Enum):
    """The six hubs, per docs/DOMAIN_RULES.md "Hubs and lab-region mapping"."""

    RD_GREECE = "R&D-Greece"
    RD_INDIA = "R&D-India"
    PD_INDIA = "PD-India"
    PD_ROMANIA = "PD-Romania"
    OEM_HCK = "OEM-HCK"
    OEM_SELTEK = "OEM-Seltek"


class LabRegion(str, enum.Enum):
    """Lab regions chambers are pooled by, per the DOMAIN_RULES.md hub→lab-region
    table. Multiple hubs share a lab region (e.g. R&D-India, PD-India, OEM-HCK and
    OEM-Seltek all map to "India") — this is why Chamber has its own `lab_region`
    column rather than an FK to Hub.
    """

    GREECE = "Greece"
    INDIA = "India"
    ROMANIA = "Romania"


class ProjectCategory(str, enum.Enum):
    """A+/A/B/C, per DOMAIN_RULES.md "Category multipliers"."""

    A_PLUS = "A+"
    A = "A"
    B = "B"
    C = "C"


class EngineerAllowedCategory(str, enum.Enum):
    """Engineer.allowed_categories values. A superset of ProjectCategory: also
    includes "OEM", per DOMAIN_RULES.md's CAT_NOT_ALLOWED rule ("assigned leader's
    allowed_categories excludes the project's category (or OEM for OEM-hub
    projects)"). Kept as a distinct enum from ProjectCategory rather than reusing
    it, since a Project never has category "OEM" itself — only an engineer's
    *eligibility* list can contain it.
    """

    A_PLUS = "A+"
    A = "A"
    B = "B"
    C = "C"
    OEM = "OEM"


class ProjectPriority(str, enum.Enum):
    """P1-P4/Q, per DOMAIN_RULES.md "Scheduling order" and prioritization bands."""

    P1 = "P1"
    P2 = "P2"
    P3 = "P3"
    P4 = "P4"
    Q = "Q"


class ProjectStatus(str, enum.Enum):
    """Status values. The first four match DOMAIN_RULES.md's scheduling-order
    table exactly (with its 0-3 ordinals preserved via Python enum member
    definition order — see `domain_constants.SCHEDULABLE_STATUS_ORDER` for the
    explicit mapping used by scheduling logic). COMMERCIALIZED and ON_HOLD are
    named in DOMAIN_RULES.md's booking rules ("excluded from scheduling
    entirely") and confirmed present in the prototype. DRAFT is *not* named in
    DOMAIN_RULES.md; it is added to satisfy PROJECT_AND_STACK.md §2's Project
    Registration hard-gate requirement ("Hard gates enforce required fields
    before a project can leave draft status"). DRAFT projects are excluded from
    scheduling identically to COMMERCIALIZED/ON_HOLD. Flagged for orchestrator
    review since it is an addition beyond DOMAIN_RULES.md's literal vocabulary.
    """

    IN_BUYOFF = "In Buyoff"
    UNDER_INDUSTRIALIZATION = "Under Industrialization"
    IN_DEVELOPMENT = "In Development"
    IN_QUEUE = "In Queue"
    COMMERCIALIZED = "Commercialized"
    ON_HOLD = "On Hold"
    DRAFT = "Draft"


#: Statuses excluded from scheduling entirely, per DOMAIN_RULES.md booking rules
#: plus the DRAFT addition documented on ProjectStatus above.
NON_SCHEDULABLE_STATUSES: frozenset[ProjectStatus] = frozenset(
    {ProjectStatus.COMMERCIALIZED, ProjectStatus.ON_HOLD, ProjectStatus.DRAFT}
)


class ProjectType(str, enum.Enum):
    """Not enumerated in docs/DOMAIN_RULES.md. Sourced from
    `reference/rpd-platform-prototype.html` (`Um={NM:"New Model",CO:"Cost
    Optimization",RC:"Regulatory / Compliance",NO:"New Option",IMP:"Improvement"}`)
    since PROJECT_AND_STACK.md §2 references a `type` field on Project
    Registration without defining its vocabulary. Flagged for orchestrator
    review — per the memory protocol, this is a gap-fill from the (non-
    authoritative) prototype, not a documented DOMAIN_RULES.md value, and should
    be confirmed with the client rather than assumed permanent.
    """

    NM = "NM"
    CO = "CO"
    RC = "RC"
    NO = "NO"
    IMP = "IMP"


class WorkflowStepKind(str, enum.Enum):
    """design | lab, per DOMAIN_RULES.md's workflow template "Kind" column."""

    DESIGN = "design"
    LAB = "lab"


class HardGateReason(str, enum.Enum):
    """The three named hard gates, per DOMAIN_RULES.md "Hard gates (override
    band, force P1)". Values match verbatim, including the parenthetical.
    """

    REGULATORY_DEADLINE_6MO = "Regulatory deadline within 6 months"
    CUSTOMER_CERT_AT_RISK = "Customer certification at risk (Coke/Pepsi)"
    ACTIVE_SAFETY_NONCOMPLIANCE = "Active safety non-compliance"


class CurrencyCode(str, enum.Enum):
    """Base EUR; USD and INR configurable-rate currencies, per DOMAIN_RULES.md
    "Currency".
    """

    EUR = "EUR"
    USD = "USD"
    INR = "INR"


class SolverType(str, enum.Enum):
    """Which engine produced a ScheduleRun. CP-SAT dispatch always goes through a
    Celery task (solver-worker) per CLAUDE.md non-negotiables — never inline in
    FastAPI. GREEDY may run synchronously for small/fast recalcs per
    docs/PROJECT_AND_STACK.md §4.
    """

    GREEDY = "greedy"
    CP_SAT = "cp_sat"


class ScheduleRunStatus(str, enum.Enum):
    """Celery task lifecycle for a ScheduleRun, per PROJECT_AND_STACK.md §4's SSE
    progress model (queued -> running -> progress % -> done/failed).
    """

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ScheduleOutcomeFlag(str, enum.Enum):
    """The five named scheduling outcomes from DOMAIN_RULES.md's booking rules
    and invariants (I1, I2, I5, "Completing within year"). Provided as an enum
    for grep-ability / cross-reference from tests and reviewers; the persisted
    columns on ScheduleRunProjectStep / ScheduleRunProjectOutcome are individual
    booleans (`eng_conflict`, `overlap`, `left_out`, `cat_not_allowed`,
    `spillover`) rather than a single polymorphic flag column, so that I6/I7 hub
    load reconciliation queries stay simple aggregate SQL. See
    `domain_constants.SCHEDULE_OUTCOME_FLAGS` for the same list as plain strings.
    """

    ENG_CONFLICT = "ENG_CONFLICT"
    OVERLAP = "OVERLAP"
    LEFT_OUT = "LEFT_OUT"
    CAT_NOT_ALLOWED = "CAT_NOT_ALLOWED"
    SPILLOVER = "SPILLOVER"


class ScenarioEntityType(str, enum.Enum):
    """Which live table a `ScenarioApplyChange` row snapshots, per
    `docs/PROJECT_AND_STACK.md` §4's "in-progress edit to priorities,
    capacity, or project data" — the four row kinds a scenario edit may
    touch. **P5-T02 scope note**: only `PRIORITY_SCORE` has a real write path
    today (`POST /scenarios/apply`'s `priority_scores` field, generalising
    `PUT /priorities/{project_id}`); `PROJECT`/`ENGINEER`/`CHAMBER` are
    defined here so the schema does not need another migration to grow into
    them, but no endpoint accepts diffs for those three yet — see
    `docs/MEMORY.md`'s P5-T02 entry for the deferral.
    """

    PRIORITY_SCORE = "priority_score"
    PROJECT = "project"
    ENGINEER = "engineer"
    CHAMBER = "chamber"


class ExportSurface(str, enum.Enum):
    """Which of the six surfaces (`docs/PROJECT_AND_STACK.md` §2's cross-
    cutting "Downloads" feature, P5-T04) an `ExportJob` was generated for.
    Audit Log and User/Role Admin (`core.rbac.Surface`'s other two columns)
    are deliberately absent — neither is one of the "every surface" the
    Downloads feature names, and the audit log's own "immutable append-only"
    contract makes a bulk CSV/XLSX export of it a separate, unscoped decision
    this task does not make.

    Deliberately duplicated (not imported) from `core.rbac.Surface` — string-
    value-identical to it by construction, so the two can be compared via
    `.value` without a translation table — because `models/` must never
    depend on `core/` (the established layering in this codebase: `core/`
    and `services/` depend on `models/`, never the reverse; confirmed by
    grepping this codebase's existing imports before adding this enum).
    """

    DASHBOARD = "dashboard"
    CAPACITY = "capacity"
    MATRIX = "matrix"
    GANTT = "gantt"
    PROJECT_REGISTRATION = "project_registration"
    CAPACITY_PLANNING = "capacity_planning"


class ExportFormat(str, enum.Enum):
    """P5-T04 — the two formats `docs/PROJECT_AND_STACK.md` §2's Downloads
    feature names ("CSV/XLSX export").
    """

    CSV = "csv"
    XLSX = "xlsx"


class ExportJobStatus(str, enum.Enum):
    """Lifecycle for the async ("large export, via MinIO") path only — the
    synchronous path (`api/routers/exports.py`'s default, streamed inline)
    never creates an `ExportJob` row at all. Deliberately a strict subset of
    `ScheduleRunStatus`'s vocabulary (no `CANCELLED` — export generation is a
    short-lived, non-cancellable background job, unlike a CP-SAT solve; see
    `workers/export_tasks.py`'s module docstring for why cancellation was
    judged unnecessary scope here).
    """

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class NotificationReason(str, enum.Enum):
    """The three in-app notification triggers named verbatim in
    `docs/PROJECT_AND_STACK.md` §2's cross-cutting "Notifications" line:
    "in-app notification of schedule changes affecting a user's hub or
    assigned projects (delay introduced, project left out, conflict
    raised)." — P5-T06. Each is a *regression* detected by diffing a newly
    activated `ScheduleRun`'s per-project outcome against the immediately
    prior active run's outcome for that same project (see
    `services/notifications.py`'s module docstring for the exact diff
    rules) — never a description of the live schedule's current state in
    isolation, and never re-derived anywhere outside that one diff function
    (mirrors Invariant I9's "no independent calculation" posture, applied to
    notification-worthy deltas instead of the within-year count).
    """

    DELAY_INTRODUCED = "delay_introduced"
    PROJECT_LEFT_OUT = "project_left_out"
    CONFLICT_RAISED = "conflict_raised"


class RoleName(str, enum.Enum):
    """Per docs/PROJECT_AND_STACK.md §5 RBAC role/permission matrix."""

    PORTFOLIO_MANAGER = "Portfolio Manager"
    HUB_PLANNER = "Hub Planner"
    ENGINEER = "Engineer"
    EXECUTIVE_VIEWER = "Executive Viewer"
    AUDITOR = "Auditor"
    ADMIN = "Admin"
