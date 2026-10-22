"""OEM hubs are capacity children of R&D-Greece (ADR 0042, P29-T01)

Revision ID: p29a_capacity_hubs
Revises: p27a_project_scoring_tags
Create Date: 2026-10-22

Schema:

- `hubs.capacity_hub_id` (nullable self-FK). CHECK `ck_hubs_capacity_hub_not_self`
  and the trigger `trg_hubs_capacity_hub_flat` (function
  `rpd_hubs_capacity_hub_flat()`): a capacity hub has no capacity hub of its
  own, i.e. no chain (a member's capacity hub must itself have none) and a hub
  that already has members cannot become a member.
- `engineers.counts_in_capacity` boolean NOT NULL default true (ADR 0042 §5).
- `projects.leader_is_provisional` boolean NOT NULL default false (§7).

Data (every value a bound parameter; the client's names are frozen here like
the other data migrations, p13a / p27a). Every changed row gets an audit row
(actor null, `after_state.source = "capacity_hubs_adr_0042"`, or
`"provisional_leader_adr_0042"` for steps 6-7):

1. OEM-HCK and OEM-Seltek -> capacity hub R&D-Greece (`hub.update`).
2. `counts_in_capacity = false` for Theoni, Dipak, Antonis, Sailesh (the four
   leaders on no client roster, docs/OPEN_QUESTIONS.md #52); everyone else,
   Elena Micu and Marian included, stays true (`engineer.update`).
3. Every engineer on a member hub moves to its capacity hub (an engineer's hub
   is always a capacity hub): Theoni, OEM-HCK -> R&D-Greece.
4. Dimopoulou, Lioumis and Kanarios get `A-OEM`, `B-OEM`, `C-OEM` appended to
   `allowed_categories` (§6), each once.
5. The member hubs' `hub_work_calendars` rows are deleted; Greece's calendar
   applies (`workflow_settings.hub_calendar_delete`).
6. Provisional leaders (§7): every project on a member hub with no leader gets
   the eligible engineer of its capacity hub (counted in capacity; category
   allowed, or the blanket `OEM` chip for an OEM category) with the least Σ
   design effort (`duration_weeks` of design-kind `project_workflow_steps`) of
   the schedulable projects it already leads, ties alphabetical. Projects are
   walked in scheduling order (priority, status, category, id) and each
   assignment of a schedulable project adds its design effort to the chosen
   engineer's load. A frozen copy of `seed.client_2026.assign_provisional_leaders`
   (a test pins equality). `leader_is_provisional = true`, one `project.update`
   audit row per project.
7. One In Progress design stage per leader (the seed's `ResourceLedger` rule,
   so two anchored tails never collide on one engineer, I1): walking the
   provisionally led projects in scheduling order, an open project whose In
   Progress design stage would give its new leader a second In Progress design
   stage is set back to Not Started (0 %, no actual weeks). These stages were
   derived by the seed against a private ledger because the project had no
   leader. One `project_stage.update` audit row each.
8. Every schedulable project of a member hub or of their capacity hub is marked
   `schedule_stale` (solver input changed: engineer pool, leaders). Nothing is
   re-solved (ADR 0006).

The log line reports every count.

Downgrade: the provisional leaders are set back to NULL (audited,
`source = "provisional_leader_adr_0042_downgrade"`), the member hubs' India
calendars are restored, the three OEM categories are removed from the three
Greek engineers, Theoni returns to OEM-HCK, the affected projects are marked
stale again, and the trigger, function and the three columns are dropped.
Stages reset by step 7 are NOT restored (the before values are in the audit
rows); counts_in_capacity and capacity_hub_id leave with their columns.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa

from alembic import op

revision: str = "p29a_capacity_hubs"
down_revision: str | Sequence[str] | None = "p27a_project_scoring_tags"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_log = logging.getLogger("alembic.runtime.migration")

# --- Frozen ADR 0042 facts ---------------------------------------------------------
_CAPACITY_HUB_OF: dict[str, str] = {"OEM-HCK": "R&D-Greece", "OEM-Seltek": "R&D-Greece"}
_NOT_IN_CAPACITY_ROSTER: tuple[str, ...] = ("Theoni", "Dipak", "Antonis", "Sailesh")
_THEONI = "Theoni"
_THEONI_PRE_ADR_HUB = "OEM-HCK"
_OEM_ELIGIBLE_GREEKS: tuple[str, ...] = ("Dimopoulou", "Lioumis", "Kanarios")
_OEM_CATEGORIES: tuple[str, ...] = ("A-OEM", "B-OEM", "C-OEM")
#: India's calendar, the pre-ADR seed of the two OEM hubs (ADR 0008 / P9-T01).
_RETIRED_OEM_CALENDAR = (6, 13, 7, 7, 20)
_SOURCE = "capacity_hubs_adr_0042"
_SOURCE_LEADER = "provisional_leader_adr_0042"
_SOURCE_DOWN = "provisional_leader_adr_0042_downgrade"

_SCHEDULABLE: tuple[str, ...] = (
    "In Buyoff",
    "Under Industrialization",
    "In Development",
    "In Queue",
)
_PRIORITY_ORDER: tuple[str, ...] = ("P1", "P2", "P3", "P4", "Q")
_CATEGORY_ORDER: tuple[str, ...] = ("A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM")

_TRIGGER_FN = """
CREATE FUNCTION rpd_hubs_capacity_hub_flat() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.capacity_hub_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM hubs
            WHERE id = NEW.capacity_hub_id AND capacity_hub_id IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'hub % cannot have a capacity hub that is itself a member (ADR 0042)',
                NEW.id USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM hubs WHERE capacity_hub_id = NEW.id) THEN
            RAISE EXCEPTION 'hub % has members and cannot become a member itself (ADR 0042)',
                NEW.id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$
"""

_INSERT_AUDIT = sa.text(
    "INSERT INTO audit_log_entries "
    "(id, actor_user_id, action, entity_type, entity_id, hub_id, before_state, "
    "after_state, notes) VALUES (:id, NULL, :action, :entity_type, :entity_id, "
    ":hub_id, CAST(:before AS jsonb), CAST(:after AS jsonb), :notes)"
)

_SELECT_PROJECTS_SQL = (
    "SELECT p.id, p.name, p.external_code, p.hub_id, CAST(p.category AS text) AS category, "
    "CAST(p.status AS text) AS status, CAST(p.priority AS text) AS priority, "
    "p.leader_engineer_id, p.frozen "
    "FROM projects p WHERE p.hub_id = ANY(:hubs) AND {where} ORDER BY p.id"
)

_SELECT_ENGINEER_SQL = (
    "SELECT e.id, e.name, e.hub_id, e.fte, CAST(e.allowed_categories AS text[]) AS cats, "
    "e.user_id, e.counts_in_capacity FROM engineers e WHERE {where} ORDER BY e.name, e.id"
)


def _audit(
    bind: sa.Connection,
    *,
    action: str,
    entity_type: str,
    entity_id: str,
    hub_id: uuid.UUID | None,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    notes: str,
) -> None:
    bind.execute(
        _INSERT_AUDIT,
        {
            "id": uuid.uuid4(),
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "hub_id": hub_id,
            "before": json.dumps(before) if before is not None else None,
            "after": json.dumps(after) if after is not None else None,
            "notes": notes,
        },
    )


def _hubs(bind: sa.Connection) -> dict[str, sa.Row]:
    rows = bind.execute(
        sa.text("SELECT id, CAST(name AS text) AS name, capacity_hub_id FROM hubs")
    ).all()
    return {r.name: r for r in rows}


def _engineer_state(row: sa.Row) -> dict[str, Any]:
    """`services.audit_helpers.engineer_audit_state`, frozen."""

    return {
        "id": str(row.id),
        "name": row.name,
        "hub_id": str(row.hub_id),
        "fte": float(row.fte) if row.fte is not None else None,
        "allowed_categories": list(row.cats or []),
        "user_id": str(row.user_id) if row.user_id else None,
        "counts_in_capacity": row.counts_in_capacity,
    }


def _engineer_rows(bind: sa.Connection, where: str, params: dict[str, Any]) -> list[sa.Row]:
    return list(bind.execute(sa.text(_SELECT_ENGINEER_SQL.format(where=where)), params).all())


def _project_state(row: sa.Row, *, leader: uuid.UUID | None, provisional: bool) -> dict:
    """A redacted project snapshot (no financial field is read)."""

    return {
        "id": str(row.id),
        "name": row.name,
        "external_code": row.external_code,
        "hub_id": str(row.hub_id),
        "leader_engineer_id": str(leader) if leader else None,
        "leader_is_provisional": provisional,
        "category": row.category,
        "status": row.status,
        "priority": row.priority,
    }


def _mark_stale(bind: sa.Connection, hub_ids: list[uuid.UUID]) -> int:
    if not hub_ids:
        return 0
    result = bind.execute(
        sa.text(
            "UPDATE projects SET schedule_stale = true "
            "WHERE CAST(status AS text) = ANY(:statuses) AND hub_id = ANY(:hubs) "
            "AND schedule_stale = false"
        ),
        {"statuses": list(_SCHEDULABLE), "hubs": hub_ids},
    )
    return result.rowcount or 0


def _design_effort_by_project(bind: sa.Connection) -> dict[uuid.UUID, int]:
    rows = bind.execute(
        sa.text(
            "SELECT s.project_id, COALESCE(SUM(s.duration_weeks), 0) AS weeks "
            "FROM project_workflow_steps s "
            "JOIN workflow_step_templates t ON t.id = s.step_template_id "
            "WHERE CAST(t.kind AS text) = 'design' GROUP BY s.project_id"
        )
    ).all()
    return {r.project_id: int(r.weeks) for r in rows}


def _scheduling_order(row: sa.Row) -> tuple[int, int, int, str]:
    """DOMAIN_RULES "Scheduling order" without the frozen / VIP keys (the seed
    rule, `seed.client_2026.scheduling_order_key`)."""

    return (
        _PRIORITY_ORDER.index(row.priority) if row.priority in _PRIORITY_ORDER else 99,
        _SCHEDULABLE.index(row.status) if row.status in _SCHEDULABLE else 99,
        _CATEGORY_ORDER.index(row.category) if row.category in _CATEGORY_ORDER else 99,
        str(row.id),
    )


def _in_progress_design_stage(bind: sa.Connection, project_id: uuid.UUID) -> sa.Row | None:
    return bind.execute(
        sa.text(
            "SELECT s.id, s.step_template_id, CAST(s.status AS text) AS status, "
            "s.percent_complete, s.actual_start_week, s.actual_end_week "
            "FROM project_workflow_steps s "
            "JOIN workflow_step_templates t ON t.id = s.step_template_id "
            "WHERE s.project_id = :pid AND CAST(t.kind AS text) = 'design' "
            "AND CAST(s.status AS text) = 'In Progress' ORDER BY s.sequence_order LIMIT 1"
        ),
        {"pid": project_id},
    ).first()


def _busy_engineers(bind: sa.Connection) -> set[uuid.UUID]:
    """Leaders who already have an In Progress / Blocked design stage on an open,
    non-frozen project (the seed ledger's `busy_leaders`)."""

    rows = bind.execute(
        sa.text(
            "SELECT DISTINCT p.leader_engineer_id FROM projects p "
            "JOIN project_workflow_steps s ON s.project_id = p.id "
            "JOIN workflow_step_templates t ON t.id = s.step_template_id "
            "WHERE p.leader_engineer_id IS NOT NULL AND NOT p.frozen "
            "AND CAST(p.status AS text) = ANY(:statuses) AND CAST(t.kind AS text) = 'design' "
            "AND CAST(s.status AS text) IN ('In Progress', 'Blocked')"
        ),
        {"statuses": list(_SCHEDULABLE)},
    ).all()
    return {r.leader_engineer_id for r in rows}


def _assign_provisional_leaders(
    bind: sa.Connection, hubs: dict[str, sa.Row]
) -> tuple[int, int]:
    """Steps 6 and 7. Returns `(leaders assigned, stages reset)`."""

    assigned = reset = 0
    by_capacity: dict[uuid.UUID, list[uuid.UUID]] = {}
    for member, parent in _CAPACITY_HUB_OF.items():
        if member in hubs and parent in hubs:
            by_capacity.setdefault(hubs[parent].id, []).append(hubs[member].id)
    if not by_capacity:
        return 0, 0
    effort = _design_effort_by_project(bind)
    busy = _busy_engineers(bind)

    for capacity_hub_id, member_ids in by_capacity.items():
        leaderless = bind.execute(
            sa.text(_SELECT_PROJECTS_SQL.format(where="p.leader_engineer_id IS NULL")),
            {"hubs": member_ids},
        ).all()
        if not leaderless:
            continue
        candidates = _engineer_rows(
            bind, "e.hub_id = :hub AND e.counts_in_capacity", {"hub": capacity_hub_id}
        )
        if not candidates:
            _log.warning(
                "p29a: capacity hub %s has no counted engineer; %d leaderless project(s) kept",
                capacity_hub_id,
                len(leaderless),
            )
            continue
        loads: dict[uuid.UUID, int] = {}
        for c in candidates:
            led = bind.execute(
                sa.text(
                    "SELECT id FROM projects WHERE leader_engineer_id = :eng "
                    "AND CAST(status AS text) = ANY(:statuses)"
                ),
                {"eng": c.id, "statuses": list(_SCHEDULABLE)},
            ).all()
            loads[c.id] = sum(effort.get(r.id, 0) for r in led)

        for row in sorted(leaderless, key=_scheduling_order):
            category = row.category or ""
            eligible = [
                c
                for c in candidates
                if category in (c.cats or [])
                or (category in _OEM_CATEGORIES and "OEM" in (c.cats or []))
            ]
            if not eligible:
                continue
            chosen = min(eligible, key=lambda c: (loads[c.id], c.name))
            is_open = row.status in _SCHEDULABLE
            if is_open:
                loads[chosen.id] += effort.get(row.id, 0)
            bind.execute(
                sa.text(
                    "UPDATE projects SET leader_engineer_id = :eng, leader_is_provisional = true, "
                    "schedule_stale = (CAST(status AS text) = ANY(:statuses)) OR schedule_stale "
                    "WHERE id = :id"
                ),
                {"eng": chosen.id, "id": row.id, "statuses": list(_SCHEDULABLE)},
            )
            _audit(
                bind,
                action="project.update",
                entity_type="Project",
                entity_id=str(row.id),
                hub_id=row.hub_id,
                before=_project_state(row, leader=None, provisional=False),
                after={
                    **_project_state(row, leader=chosen.id, provisional=True),
                    "source": _SOURCE_LEADER,
                },
                notes="p29a: provisional leader for a leaderless OEM project (ADR 0042 §7)",
            )
            assigned += 1

            # Step 7: one In Progress design stage per leader.
            if not is_open or row.frozen:
                continue
            stage = _in_progress_design_stage(bind, row.id)
            if stage is None:
                continue
            if chosen.id not in busy:
                busy.add(chosen.id)
                continue
            bind.execute(
                sa.text(
                    "UPDATE project_workflow_steps SET status = 'Not Started', "
                    "percent_complete = 0, actual_start_week = NULL, actual_end_week = NULL, "
                    "remaining_weeks_override = NULL WHERE id = :id"
                ),
                {"id": stage.id},
            )
            before_stage = {
                "project_id": str(row.id),
                "step_id": stage.step_template_id,
                "status": stage.status,
                "percent_complete": stage.percent_complete,
                "actual_start_week": stage.actual_start_week,
                "actual_end_week": stage.actual_end_week,
            }
            after_stage = {
                **before_stage,
                "status": "Not Started",
                "percent_complete": 0,
                "actual_start_week": None,
                "actual_end_week": None,
                "source": _SOURCE_LEADER,
            }
            _audit(
                bind,
                action="project_stage.update",
                entity_type="ProjectWorkflowStep",
                entity_id=str(stage.id),
                hub_id=row.hub_id,
                before=before_stage,
                after=after_stage,
                notes="p29a: the provisional leader already has an In Progress design stage",
            )
            reset += 1
    return assigned, reset


def upgrade() -> None:
    bind = op.get_bind()

    # --- schema ---------------------------------------------------------------------
    op.add_column("hubs", sa.Column("capacity_hub_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_hubs_capacity_hub_id_hubs"), "hubs", "hubs", ["capacity_hub_id"], ["id"]
    )
    op.create_check_constraint(
        op.f("ck_hubs_capacity_hub_not_self"),
        "hubs",
        "capacity_hub_id IS NULL OR capacity_hub_id <> id",
    )
    op.execute(_TRIGGER_FN)
    op.execute(
        "CREATE TRIGGER trg_hubs_capacity_hub_flat BEFORE INSERT OR UPDATE OF capacity_hub_id "
        "ON hubs FOR EACH ROW EXECUTE FUNCTION rpd_hubs_capacity_hub_flat()"
    )
    op.add_column(
        "engineers",
        sa.Column(
            "counts_in_capacity", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
    )
    op.add_column(
        "projects",
        sa.Column(
            "leader_is_provisional", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
    )

    # --- 1. capacity hubs -----------------------------------------------------------
    hubs = _hubs(bind)
    member_ids: list[uuid.UUID] = []
    parent_ids: list[uuid.UUID] = []
    for member, parent in _CAPACITY_HUB_OF.items():
        if member not in hubs or parent not in hubs:
            continue  # a database without the seeded hubs: nothing to point
        m, p = hubs[member], hubs[parent]
        bind.execute(
            sa.text("UPDATE hubs SET capacity_hub_id = :parent WHERE id = :member"),
            {"parent": p.id, "member": m.id},
        )
        _audit(
            bind,
            action="hub.update",
            entity_type="Hub",
            entity_id=str(m.id),
            hub_id=m.id,
            before={"name": member, "capacity_hub_id": None},
            after={"name": member, "capacity_hub_id": str(p.id), "source": _SOURCE},
            notes=f"p29a: {member} is a capacity child of {parent} (ADR 0042 §1)",
        )
        member_ids.append(m.id)
        if p.id not in parent_ids:
            parent_ids.append(p.id)

    # --- 2.-4. engineers ---------------------------------------------------------------
    names = sorted(set(_NOT_IN_CAPACITY_ROSTER) | set(_OEM_ELIGIBLE_GREEKS))
    touched = _engineer_rows(
        bind,
        "e.name = ANY(:names) OR e.hub_id = ANY(:members)",
        {"names": names, "members": member_ids or [uuid.UUID(int=0)]},
    )
    before_state = {r.id: _engineer_state(r) for r in touched}
    bind.execute(
        sa.text("UPDATE engineers SET counts_in_capacity = false WHERE name = ANY(:names)"),
        {"names": list(_NOT_IN_CAPACITY_ROSTER)},
    )
    for member, parent in _CAPACITY_HUB_OF.items():
        if member in hubs and parent in hubs:
            bind.execute(
                sa.text("UPDATE engineers SET hub_id = :parent WHERE hub_id = :member"),
                {"parent": hubs[parent].id, "member": hubs[member].id},
            )
    for cat in _OEM_CATEGORIES:
        bind.execute(
            sa.text(
                "UPDATE engineers SET allowed_categories = "
                "array_append(allowed_categories, CAST(:cat AS engineer_allowed_category)) "
                "WHERE name = ANY(:names) "
                "AND NOT (CAST(:cat AS engineer_allowed_category) = ANY(allowed_categories))"
            ),
            {"cat": cat, "names": list(_OEM_ELIGIBLE_GREEKS)},
        )
    changed_engineers = 0
    for row in _engineer_rows(
        bind, "e.id = ANY(:ids)", {"ids": list(before_state) or [uuid.UUID(int=0)]}
    ):
        after_state = _engineer_state(row)
        if after_state == before_state[row.id]:
            continue
        changed_engineers += 1
        _audit(
            bind,
            action="engineer.update",
            entity_type="Engineer",
            entity_id=str(row.id),
            hub_id=row.hub_id,
            before=before_state[row.id],
            after={**after_state, "source": _SOURCE},
            notes="p29a: capacity roster, capacity hub and OEM eligibility (ADR 0042 §5-§6)",
        )

    # --- 5. member calendars retired ---------------------------------------------------
    calendars = 0
    for hub_id in member_ids:
        cal = bind.execute(
            sa.text(
                "SELECT weekdays_per_week, national_holiday_days, medical_leave_days, "
                "casual_leave_days, annual_leave_days, weeks_in_year "
                "FROM hub_work_calendars WHERE hub_id = :hub"
            ),
            {"hub": hub_id},
        ).first()
        if cal is None:
            continue
        bind.execute(sa.text("DELETE FROM hub_work_calendars WHERE hub_id = :hub"), {"hub": hub_id})
        _audit(
            bind,
            action="workflow_settings.hub_calendar_delete",
            entity_type="HubWorkCalendar",
            entity_id=str(hub_id),
            hub_id=hub_id,
            before={
                "weekdays_per_week": cal.weekdays_per_week,
                "national_holiday_days": float(cal.national_holiday_days),
                "medical_leave_days": float(cal.medical_leave_days),
                "casual_leave_days": float(cal.casual_leave_days),
                "annual_leave_days": float(cal.annual_leave_days),
                "weeks_in_year": cal.weeks_in_year,
            },
            after={"source": _SOURCE},
            notes="p29a: a capacity member hub uses its capacity hub's calendar (ADR 0042 §1)",
        )
        calendars += 1

    # --- 6.-8. provisional leaders, stage reset, stale ----------------------------------
    assigned, reset = _assign_provisional_leaders(bind, hubs)
    stale = _mark_stale(bind, member_ids + parent_ids)
    _log.info(
        "p29a: %d member hub(s) under their capacity hub; %d engineer(s) changed; "
        "%d member calendar row(s) deleted; %d provisional leader(s) assigned; "
        "%d In Progress design stage(s) reset; %d more project(s) marked stale",
        len(member_ids),
        changed_engineers,
        calendars,
        assigned,
        reset,
        stale,
    )


def downgrade() -> None:
    bind = op.get_bind()
    hubs = _hubs(bind)
    member_ids = [hubs[m].id for m in _CAPACITY_HUB_OF if m in hubs]
    parent_ids = sorted({hubs[p].id for m, p in _CAPACITY_HUB_OF.items() if p in hubs}, key=str)

    # Provisional leaders back to blank (audited; the upgrade rows stay).
    rows = bind.execute(
        sa.text(
            "SELECT p.id, p.name, p.external_code, p.hub_id, CAST(p.category AS text) AS category, "
            "CAST(p.status AS text) AS status, CAST(p.priority AS text) AS priority, "
            "p.leader_engineer_id FROM projects p WHERE p.leader_is_provisional ORDER BY p.id"
        )
    ).all()
    for row in rows:
        bind.execute(
            sa.text(
                "UPDATE projects SET leader_engineer_id = NULL, leader_is_provisional = false, "
                "schedule_stale = true WHERE id = :id"
            ),
            {"id": row.id},
        )
        _audit(
            bind,
            action="project.update",
            entity_type="Project",
            entity_id=str(row.id),
            hub_id=row.hub_id,
            before=_project_state(row, leader=row.leader_engineer_id, provisional=True),
            after={**_project_state(row, leader=None, provisional=False), "source": _SOURCE_DOWN},
            notes="p29a downgrade: provisional leader removed (ADR 0042 §7)",
        )

    # The member hubs' pre-ADR (India) calendars.
    weekdays, nat, med, cas, ann = _RETIRED_OEM_CALENDAR
    for hub_id in member_ids:
        bind.execute(
            sa.text(
                "INSERT INTO hub_work_calendars (id, hub_id, weekdays_per_week, "
                "national_holiday_days, medical_leave_days, casual_leave_days, "
                "annual_leave_days, weeks_in_year, created_at, updated_at) "
                "SELECT :id, :hub, :wd, :nat, :med, :cas, :ann, 52, now(), now() "
                "WHERE NOT EXISTS (SELECT 1 FROM hub_work_calendars WHERE hub_id = :hub)"
            ),
            {
                "id": uuid.uuid4(),
                "hub": hub_id,
                "wd": weekdays,
                "nat": nat,
                "med": med,
                "cas": cas,
                "ann": ann,
            },
        )
    for cat in _OEM_CATEGORIES:
        bind.execute(
            sa.text(
                "UPDATE engineers SET allowed_categories = "
                "array_remove(allowed_categories, CAST(:cat AS engineer_allowed_category)) "
                "WHERE name = ANY(:names)"
            ),
            {"cat": cat, "names": list(_OEM_ELIGIBLE_GREEKS)},
        )
    if _THEONI_PRE_ADR_HUB in hubs:
        bind.execute(
            sa.text("UPDATE engineers SET hub_id = :hub WHERE name = :name"),
            {"hub": hubs[_THEONI_PRE_ADR_HUB].id, "name": _THEONI},
        )
    _mark_stale(bind, member_ids + parent_ids)

    op.drop_column("projects", "leader_is_provisional")
    op.drop_column("engineers", "counts_in_capacity")
    op.execute("DROP TRIGGER trg_hubs_capacity_hub_flat ON hubs")
    op.execute("DROP FUNCTION rpd_hubs_capacity_hub_flat()")
    op.drop_constraint(op.f("ck_hubs_capacity_hub_not_self"), "hubs", type_="check")
    op.drop_constraint(op.f("fk_hubs_capacity_hub_id_hubs"), "hubs", type_="foreignkey")
    op.drop_column("hubs", "capacity_hub_id")
