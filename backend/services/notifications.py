"""In-app notification generation (P5-T06) —
`docs/PROJECT_AND_STACK.md` §2's cross-cutting "Notifications" line:
"in-app notification of schedule changes affecting a user's hub or assigned
projects (delay introduced, project left out, conflict raised)."

**Trigger point — read this before wiring a second caller.** The single
place this is invoked from is `services.schedule_persistence
.persist_schedule_output`, immediately after a newly-activated `ScheduleRun`
(`activate=True`) has its `ScheduleRunProjectOutcome`/`ScheduleRunProjectStep`
rows written, diffed against whatever `ScheduleRun` was `is_active`
immediately before this call (captured by that function before it flips
`is_active`). This deliberately reuses the exact data `persist_schedule_output`
already computes/persists as the sole source for "what changed" — no second,
parallel event-detection mechanism exists anywhere else in this codebase, per
this task's own instruction. A `persist_schedule_output(..., activate=False)`
call (e.g. a completed-but-not-activated CP-SAT run, per
`workers/schedule_tasks.py`'s current "CP-SAT never auto-activates" decision)
never reaches this module at all — notifications describe changes to the
*live* schedule a user's UI actually reflects, never a hypothetical,
not-yet-reviewed CP-SAT result nobody has applied. If/when a future task adds
an "activate a completed CP-SAT run" endpoint, it gets these notifications for
free as long as it goes through `persist_schedule_output(activate=True)` (or
calls this module directly with the two runs it is toggling between) — it
must not reimplement its own diff.

**Diff rules — the three `NotificationReason` triggers, precisely.** For
every project present in BOTH the previous active run's
`ScheduleRunProjectOutcome` and the new run's `ProjectScheduleOutcome`
(scheduling.types dataclass, still in memory — never re-read the new run's
own just-written DB rows, since the caller already has this exact data):

- A project with NO row in the previous run at all (a project added to the
  portfolio since) is skipped entirely for every reason below — there is no
  known prior baseline to regress from, so nothing here can honestly be
  called an *introduced* delay/left-out/conflict. This is a deliberate
  scope choice, not an oversight: a brand-new project's first-ever schedule
  outcome is not a "change".
- `PROJECT_LEFT_OUT`: previous `left_out=False`, new `left_out=True`.
- `DELAY_INTRODUCED`: new `left_out=False` (a project that just became
  `LEFT_OUT` gets that reason instead, not both — `LEFT_OUT` is the more
  severe, encompassing signal), and EITHER (a) both runs have a known
  `last_step_end_week`/`end_week` and the new value is strictly greater than
  the previous one (the project's projected finish moved later), OR (b) the
  previous run's persisted `within_year` was `True` and the new run's
  in-memory `within_year` is `False` (a SPILLOVER regression) — condition
  (b) exists specifically because `Project.delay_weeks` (ADR 0004's
  terminal-adjustment model, `docs/DOMAIN_RULES.md` known defect #3) is
  folded into `within_year`/`spillover` by `scheduling/greedy.py` but is
  NEVER reflected in `end_week`/`last_step_end_week` — condition (a) alone
  is blind to a project that regresses to SPILLOVER purely because a
  planner recorded a delay via `PUT /projects/{id}`, since that never moves
  `end_week`. Both conditions reuse fields already computed/persisted by
  the scheduler (`ScheduleRunProjectOutcome.within_year`,
  `ProjectScheduleOutcome.within_year`) — no delay/completion-week math is
  reimplemented here, per this codebase's "you call the scheduler, you
  never reimplement its logic" rule.
- `CONFLICT_RAISED`: previous run had neither `ENG_CONFLICT` nor `OVERLAP`
  on any of that project's steps, and the new run has at least one of
  either (per Invariant I1/I2, only possible for a `frozen` project) — the
  new run's `eng_conflict`/`overlap` come straight off the in-memory
  `ProjectScheduleOutcome` (project-level, per `scheduling/types.py`); the
  previous run's equivalent is derived from `ScheduleRunProjectStep` via
  `bool_or(...)` since `ScheduleRunProjectOutcome` itself has no
  eng_conflict/overlap columns (only the per-step snapshot table does — see
  `models/schedule.py`).

A single project may fire more than one of these three in the same
generation pass (e.g. both delayed AND newly conflicted) — each is a
separate `Notification` row.

**Recipient resolution — reusing the existing RBAC/hub-scope model, not a
new audience system.** See `_resolve_recipients` below: a user is a
candidate recipient for a given event iff (a) their role(s) grant READ on at
least one of DASHBOARD/CAPACITY/GANTT (the same surfaces
`api/routers/schedule_runs.py`'s `_read_any` already uses for "who can see
schedule-run-derived data" — MATRIX is deliberately excluded, since Matrix
concerns priority-score edits, not delay/left-out/conflict outcomes) AND
(b) they are either `hub_scope_all=True`, OR explicitly hub-scoped
(`UserHubScope`) to the event's project's hub, OR hold the Engineer role and
are the linked `User` for that project's `Project.leader_engineer_id` (the
GDPR-conscious "own assigned projects only" narrowing named in this task's
brief, matching `services.hub_scope.is_engineer_self_scoped`'s existing
Gantt precedent — an Engineer never receives a notification about a project
they are not the leader of, even one in a hub they happen to also be
tangentially linked to). A user matching more than one of these paths (e.g.
an Engineer who is ALSO Hub-Planner-scoped to that hub) still gets exactly
ONE `Notification` row per event — recipients are deduplicated by user id
before any row is written.
"""

from __future__ import annotations

import uuid
from collections import defaultdict

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.rbac import Action, Surface, role_allows
from models.enums import NotificationReason, RoleName
from models.notification import Notification
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.user import User, UserRole
from scheduling.types import ProjectScheduleOutcome

#: Same (DASHBOARD, CAPACITY, GANTT) triple `api/routers/schedule_runs.py`'s
#: `_read_any` uses — reused, not re-derived. See module docstring.
_NOTIFICATION_SURFACES = (Surface.DASHBOARD, Surface.CAPACITY, Surface.GANTT)


def _role_is_notification_eligible(role: RoleName) -> bool:
    return any(role_allows(role, surface, Action.READ) for surface in _NOTIFICATION_SURFACES)


def _reason_message(
    reason: NotificationReason,
    *,
    project_name: str,
    hub_name: str,
    previous_end_week: int | None = None,
    new_end_week: int | None = None,
    within_year_only: bool = False,
) -> str:
    """Compose the free-text `Notification.message`. Only ever reads
    `project_name`/`hub_name`/plain integer week numbers — never a financial
    field (`models/notification.py`'s module docstring, CLAUDE.md
    non-negotiable).

    `within_year_only=True` covers the `delay_weeks`-only regression case
    (see module docstring's DELAY_INTRODUCED condition (b)): `end_week` is
    unchanged, so a "moved from week X to week Y" message would be
    misleading (X == Y) — the message instead names the actual regression,
    the project falling out of the within-year cutoff.
    """

    if reason == NotificationReason.DELAY_INTRODUCED:
        if within_year_only:
            return (
                f'Project "{project_name}" ({hub_name}) was delayed: a recorded delay now '
                "pushes its projected completion past the within-year cutoff (previously "
                "projected to complete within the year; now projected to spill over)."
            )
        return (
            f'Project "{project_name}" ({hub_name}) was delayed: projected finish moved '
            f"from week {previous_end_week} to week {new_end_week}."
        )
    if reason == NotificationReason.PROJECT_LEFT_OUT:
        return (
            f'Project "{project_name}" ({hub_name}) could not be scheduled within the '
            "planning horizon and is now left out."
        )
    if reason == NotificationReason.CONFLICT_RAISED:
        return (
            f'Project "{project_name}" ({hub_name}) has a new scheduling conflict '
            "(a frozen project's engineer or lab chamber is over-booked)."
        )
    raise AssertionError(f"unhandled NotificationReason: {reason!r}")  # pragma: no cover


async def _resolve_recipients(
    db: AsyncSession,
) -> tuple[set[uuid.UUID], dict[uuid.UUID, set[uuid.UUID]], dict[uuid.UUID, uuid.UUID]]:
    """One pass over every active `User`, resolving three lookup structures
    used to compute each event's recipient set in O(1) per event rather than
    re-querying per project (`generate_schedule_change_notifications` below
    calls this exactly once per generation, regardless of how many events
    fire):

    - `hub_scope_all_ids`: notification-eligible users who see every hub.
    - `hub_scoped`: hub_id -> set of notification-eligible users explicitly
      scoped to that hub (Hub Planner, per `UserHubScope`).
    - `engineer_user_by_engineer_id`: Engineer.id -> the linked User.id, for
      every active user holding the Engineer role with a linked `Engineer`
      row (`Engineer.user_id`) — Engineer is always notification-eligible on
      its own (Gantt READ is in `_NOTIFICATION_SURFACES`), independent of
      `hub_scope_all`/`hub_scoped` membership.
    """

    users = (
        (
            await db.execute(
                select(User)
                .where(User.is_active.is_(True))
                .options(
                    selectinload(User.roles).selectinload(UserRole.role),
                    selectinload(User.hub_scopes),
                    selectinload(User.engineer),
                )
            )
        )
        .scalars()
        .all()
    )

    hub_scope_all_ids: set[uuid.UUID] = set()
    hub_scoped: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    engineer_user_by_engineer_id: dict[uuid.UUID, uuid.UUID] = {}

    for user in users:
        role_names = {RoleName(ur.role.name) for ur in user.roles if ur.role is not None}
        eligible = any(_role_is_notification_eligible(r) for r in role_names)

        if eligible:
            if user.hub_scope_all:
                hub_scope_all_ids.add(user.id)
            else:
                for hub_scope in user.hub_scopes:
                    hub_scoped[hub_scope.hub_id].add(user.id)

        if RoleName.ENGINEER in role_names and user.engineer is not None:
            engineer_user_by_engineer_id[user.engineer.id] = user.id

    return hub_scope_all_ids, dict(hub_scoped), engineer_user_by_engineer_id


async def generate_schedule_change_notifications(
    db: AsyncSession,
    *,
    new_run: ScheduleRun,
    previous_active_run_id: uuid.UUID | None,
    project_outcomes: tuple[ProjectScheduleOutcome, ...],
) -> list[Notification]:
    """Diff `project_outcomes` (the new run's in-memory `ScheduleOutput
    .project_outcomes`) against `previous_active_run_id`'s persisted
    `ScheduleRunProjectOutcome`/`ScheduleRunProjectStep` rows, and write one
    `Notification` row per (event, recipient) pair. Flushes (does not
    commit) — the caller (`services.schedule_persistence
    .persist_schedule_output`) controls the transaction, same convention as
    every other write in that module.

    Returns `[]` (no DB reads/writes at all beyond this) when
    `previous_active_run_id is None` — the very first-ever active run has no
    baseline to diff against, per module docstring.
    """

    if previous_active_run_id is None:
        return []

    prev_outcome_rows = (
        (
            await db.execute(
                select(ScheduleRunProjectOutcome).where(
                    ScheduleRunProjectOutcome.schedule_run_id == previous_active_run_id
                )
            )
        )
        .scalars()
        .all()
    )
    prev_outcomes = {row.project_id: row for row in prev_outcome_rows}

    prev_conflict_rows = await db.execute(
        select(
            ScheduleRunProjectStep.project_id,
            func.bool_or(ScheduleRunProjectStep.eng_conflict),
            func.bool_or(ScheduleRunProjectStep.chamber_overlap),
        )
        .where(ScheduleRunProjectStep.schedule_run_id == previous_active_run_id)
        .group_by(ScheduleRunProjectStep.project_id)
    )
    prev_conflicts: dict[uuid.UUID, tuple[bool, bool]] = {
        pid: (bool(eng), bool(overlap)) for pid, eng, overlap in prev_conflict_rows.all()
    }

    events: list[tuple[uuid.UUID, NotificationReason, int | None, int | None, bool]] = []
    for outcome in project_outcomes:
        if outcome.excluded:
            continue
        project_id = uuid.UUID(outcome.project_id)
        prev = prev_outcomes.get(project_id)
        if prev is None:
            # No prior baseline for this project (new to the portfolio since
            # the last active run) — nothing to call a "change". See module
            # docstring.
            continue

        if not prev.left_out and outcome.left_out:
            events.append((project_id, NotificationReason.PROJECT_LEFT_OUT, None, None, False))
        elif not outcome.left_out:
            end_week_moved = (
                prev.last_step_end_week is not None
                and outcome.end_week is not None
                and outcome.end_week > prev.last_step_end_week
            )
            # Condition (b): a `delay_weeks`-driven SPILLOVER regression with
            # an unchanged `end_week` — see module docstring. Checked even
            # when `end_week_moved` is already True so a project that both
            # moved AND flipped within_year still gets exactly one
            # DELAY_INTRODUCED event (not two), preferring the more concrete
            # "moved from week X to week Y" message.
            within_year_regressed = bool(prev.within_year) and not outcome.within_year
            if end_week_moved or within_year_regressed:
                events.append(
                    (
                        project_id,
                        NotificationReason.DELAY_INTRODUCED,
                        prev.last_step_end_week,
                        outcome.end_week,
                        not end_week_moved and within_year_regressed,
                    )
                )

        prev_eng_conflict, prev_overlap = prev_conflicts.get(project_id, (False, False))
        if not (prev_eng_conflict or prev_overlap) and (outcome.eng_conflict or outcome.overlap):
            events.append((project_id, NotificationReason.CONFLICT_RAISED, None, None, False))

    if not events:
        return []

    project_ids = {project_id for project_id, _reason, _prev, _new, _within_year_only in events}
    projects = (
        (
            await db.execute(
                select(Project)
                .options(selectinload(Project.hub))
                .where(Project.id.in_(project_ids))
            )
        )
        .scalars()
        .all()
    )
    project_by_id = {p.id: p for p in projects}

    hub_scope_all_ids, hub_scoped, engineer_user_by_engineer_id = await _resolve_recipients(db)

    notifications: list[Notification] = []
    for project_id, reason, prev_week, new_week, within_year_only in events:
        project = project_by_id.get(project_id)
        if project is None:  # pragma: no cover - defensive, should never happen
            continue

        recipients = set(hub_scope_all_ids) | hub_scoped.get(project.hub_id, set())
        if project.leader_engineer_id is not None:
            engineer_recipient = engineer_user_by_engineer_id.get(project.leader_engineer_id)
            if engineer_recipient is not None:
                recipients.add(engineer_recipient)
        if not recipients:
            continue

        message = _reason_message(
            reason,
            project_name=project.name,
            hub_name=project.hub.name.value,
            previous_end_week=prev_week,
            new_end_week=new_week,
            within_year_only=within_year_only,
        )
        for recipient_user_id in recipients:
            notifications.append(
                Notification(
                    recipient_user_id=recipient_user_id,
                    reason=reason,
                    project_id=project.id,
                    hub_id=project.hub_id,
                    message=message,
                    schedule_run_id=new_run.id,
                    previous_schedule_run_id=previous_active_run_id,
                )
            )

    db.add_all(notifications)
    await db.flush()
    return notifications
