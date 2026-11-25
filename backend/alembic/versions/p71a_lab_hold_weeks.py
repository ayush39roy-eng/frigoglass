"""lab hold weeks: room weeks on lab steps (P62-T04, ADR 0071)

Revision ID: p71a_lab_hold_weeks
Revises: p70a_effort_weight_revive
Create Date: 2026-11-25

ADR 0071 (Accepted 2026-11-25; ruling R62-0 … R62-13), DOMAIN_RULES "Lab hold
weeks" (I64–I67), `docs/API_CONTRACT_P62.md` §1. Owner ruling 2026-11-25
("FOR PR. Pr and pilot are in lab but they only use logic for 1 week …";
Q1 "Only PoC + Certification"; Q2 "c doesnt have else have"): the approval
for EXACTLY the existing-row changes below, and nothing else.

**Schema (additive).**

- `workflow_lead_times.lab_hold_weeks` INTEGER NULL, CHECK
  `lab_hold_weeks IS NULL OR (0 <= lab_hold_weeks <= weeks)` (I65);
- `project_workflow_steps.plan_lab_hold_weeks` INTEGER NULL, CHECK
  `… <= plan_weeks` (I65);
- `schedule_run_project_steps.lab_hold_weeks` INTEGER NULL, CHECK
  `lab_hold_weeks IS NULL OR (0 <= lab_hold_weeks <= end_week - start_week + 1)`.
  **Deviation from the contract** (recorded in MEMORY P62-T04): the contract
  bounds it by `duration_weeks`, but the engine books `h = min(hold, n)` over
  the row's booked span `n`, which can exceed `duration_weeks` on an In
  Progress tail, a Done span or a pin (P62-T03 note 4). NULL on every row
  written before this revision (read as `duration_weeks`).

**Data steps** (one transaction, in this order; each a named function so it
can be reverted alone):

1. `step1_template_defaults` — template room weeks where still NULL: PDD-J /
   PDD-L = 1 for A+, A, B and 0 for C; OEM-J / OEM-L only if `lab` here
   (A-OEM / B-OEM 1, C-OEM 0). Every value is clamped to the row's `weeks`.
   R62-11 lives in `step1_r62_11_c_no_pr_pr_template`: C/PDD-J `weeks` 1 → 0
   (weights untouched: the p33b trigger only guards `effort_weight_weeks`).
   `template_version + 1` on each changed category; one `template_changes`
   row; one `workflow_template.applied` audit per category (reason
   `p62_lab_hold_defaults`; `p62_c_no_pr_pr` listed for C).
2. `step2_backfill_hold_copies` — `plan_lab_hold_weeks` from the template
   (clamped to `plan_weeks`) on EVERY project, reached / frozen / Cancelled /
   Commercialized included (R62-7), where still NULL. One
   `project.lab_hold_backfilled` audit per changed project.
3. `step3_r62_11_c_no_pr_pr_copies` — C/PDD-J `plan_weeks` 1 → 0 on ¬never
   pairs (P33 §C: not frozen, not Cancelled / Commercialized, J not reached),
   whatever ownEffort says (R62-12). `project.template_applied` audit with
   `weeks [1, 0]`.
4. `step4_r62_1_rederive` — the R6 re-derivation, trigger
   `lab_hold_default`, over every non-frozen project with a figure or a
   stored effort value: a `partialRoom` step leaves the lab S′
   (`scheduling.effort_split`, the engine's split), R3 raises and the ADR
   0070 hold-back apply (`services.project_effort.held_out`), NO
   `started_share` refusal; a kind that loses its own figure has the
   template `weeks` re-copied onto its not-reached steps (OR-5). Audit
   `project.effort_rederived`. A project whose split R7 would reject (a step
   above 104 weeks) is left unchanged.
5. `step5_mark_stale` — `schedule_stale = true` on every schedulable project
   when any step above changed something. No run is dispatched (ADR 0069).

**Idempotent.** Every step writes only values that differ (NULL holds only,
`weeks = 1` / `plan_weeks = 1` only, a re-derivation only when the split
differs), so a second pass writes nothing and audits nothing
(`tests/test_p62_migration.py`). Constant SQL with bound parameters only.

**Downgrade** drops the three CHECKs and columns. It does NOT restore
C/PDD-J `weeks` / `plan_weeks` = 1 or the old effort splits; the audit rows
written here (actor NULL, `notes` = `_NOTES`) record every before value.

No financial field is read or written.
"""

from __future__ import annotations

import json
import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

import sqlalchemy as sa
from sqlalchemy.engine import Connection

from alembic import op

revision: str = "p71a_lab_hold_weeks"
down_revision: str | Sequence[str] | None = "p70a_effort_weight_revive"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LEAD = "workflow_lead_times"
_STEPS = "project_workflow_steps"
_RUN_STEPS = "schedule_run_project_steps"
_CK_LEAD = "ck_workflow_lead_times_lab_hold_weeks_range"
_CK_STEPS = "ck_project_workflow_steps_plan_lab_hold_weeks_range"
_CK_RUN = "ck_schedule_run_project_steps_lab_hold_weeks_range"

_NOTES = "ADR 0071: lab hold weeks (migration p71a_lab_hold_weeks)"
REASON_DEFAULTS = "p62_lab_hold_defaults"
REASON_C_NO_PR_PR = "p62_c_no_pr_pr"
TRIGGER_LAB_HOLD_DEFAULT = "lab_hold_default"

#: Step 1 defaults (owner 2026-11-25): (workflow, category, step) -> room weeks.
PDD_DEFAULTS: Mapping[tuple[str, str, str], int] = {
    ("PDD", cat, sid): (0 if cat == "C" else 1)
    for cat in ("A+", "A", "B", "C")
    for sid in ("PDD-J", "PDD-L")
}
#: Only where OEM-J / OEM-L are `lab` at migration time (ADR 0071 §2).
OEM_DEFAULTS: Mapping[tuple[str, str, str], int] = {
    ("OEM", cat, sid): (0 if cat == "C-OEM" else 1)
    for cat in ("A-OEM", "B-OEM", "C-OEM")
    for sid in ("OEM-J", "OEM-L")
}
#: R62-11: category C has no Pr. Pr (C/PDD-L is already 0).
C_NO_PR_PR: tuple[str, str, str] = ("PDD", "C", "PDD-J")

#: The statuses a P33 apply never writes to (§C `never`), and the
#: non-schedulable statuses (`models.enums.NON_SCHEDULABLE_STATUSES`).
_CLOSED = ("Cancelled", "Commercialized")
_NON_SCHEDULABLE = ("Commercialized", "On Hold", "Cancelled", "Draft")
_NOT_STARTED = "Not Started"


class StepsResult:
    """What one pass of the data steps changed (for the tests and the log).
    A plain class: alembic loads this module outside `sys.modules`, where
    `dataclasses` cannot resolve it."""

    def __init__(self) -> None:
        self.categories: list[str] = []
        self.template_rows = 0
        self.backfilled_projects = 0
        self.c_copies = 0
        self.rederived_projects = 0
        self.rejected_projects: list[str] = []
        self.stale_marked = False

    @property
    def changed(self) -> bool:
        return bool(
            self.template_rows or self.backfilled_projects or self.c_copies
            or self.rederived_projects
        )  # fmt: skip


# --- SQL (constant; every value is a bound parameter) --------------------------------------------

_INSERT_AUDIT = sa.text(
    "INSERT INTO audit_log_entries "
    "(id, actor_user_id, action, entity_type, entity_id, hub_id, before_state, "
    "after_state, notes) VALUES (:id, NULL, :action, :entity_type, :entity_id, "
    ":hub_id, CAST(:before AS jsonb), CAST(:after AS jsonb), :notes)"
)
_INSERT_CHANGE = sa.text(
    "INSERT INTO template_changes (id, actor_user_id, reason, changes, selection) "
    "VALUES (:id, NULL, :reason, CAST(:changes AS jsonb), CAST(:selection AS jsonb))"
)
_KINDS = sa.text("SELECT id, workflow_id, kind::text AS kind, predecessor_ids "
                 "FROM workflow_step_templates")  # fmt: skip
_LEAD_ROWS = sa.text(
    "SELECT workflow_id, category, step_id, weeks, lab_hold_weeks, effort_weight_weeks "
    "FROM workflow_lead_times"
)
_UPDATE_LEAD = sa.text(
    "UPDATE workflow_lead_times SET weeks = :weeks, lab_hold_weeks = :hold "
    "WHERE workflow_id = :wf AND category = :cat AND step_id = :sid"
)
_BUMP_VERSION = sa.text(
    "UPDATE categories SET template_version = template_version + 1 WHERE code = :code "
    "RETURNING template_version"
)
_PROJECTS = sa.text(
    "SELECT p.id, p.hub_id, p.category, p.status::text AS status, p.frozen, "
    "p.design_effort_weeks, p.lab_effort_weeks, p.certification_testing_required, "
    "CASE WHEN h.is_oem THEN 'OEM' ELSE 'PDD' END AS workflow_id "
    "FROM projects p JOIN hubs h ON h.id = p.hub_id ORDER BY p.id"
)
_STEP_ROWS = sa.text(
    "SELECT id, project_id, step_template_id, sequence_order, status::text AS status, "
    "excluded, effort_weeks, plan_weeks, plan_lab_hold_weeks "
    "FROM project_workflow_steps ORDER BY project_id, sequence_order"
)
_SET_HOLD = sa.text("UPDATE project_workflow_steps SET plan_lab_hold_weeks = :hold WHERE id = :id")
_SET_PLAN = sa.text(
    "UPDATE project_workflow_steps SET plan_weeks = :plan, plan_lab_hold_weeks = :hold, "
    "template_change_id = COALESCE(:change_id, template_change_id) WHERE id = :id"
)
_SET_EFFORT = sa.text("UPDATE project_workflow_steps SET effort_weeks = :effort WHERE id = :id")
_STALE_ALL = sa.text(
    "UPDATE projects SET schedule_stale = true "
    "WHERE status::text NOT IN :closed AND schedule_stale = false"
).bindparams(sa.bindparam("closed", expanding=True))
_STALE_ONE = sa.text("UPDATE projects SET schedule_stale = true WHERE id = :id")


def _audit(
    bind: Connection,
    *,
    action: str,
    entity_type: str,
    entity_id: str,
    hub_id: Any,
    before: Any,
    after: Any,
) -> None:
    bind.execute(
        _INSERT_AUDIT,
        {
            "id": uuid.uuid4(),
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "hub_id": hub_id,
            "before": json.dumps(before, sort_keys=True, default=str),
            "after": json.dumps(after, sort_keys=True, default=str),
            "notes": _NOTES,
        },
    )


def _clamp(hold: int | None, weeks: int) -> int | None:
    return None if hold is None else max(0, min(hold, weeks))


# --- the world as read --------------------------------------------------------------------------


class _World:
    def __init__(
        self,
        kinds: dict[str, str],
        predecessors: dict[str, dict[str, tuple[str, ...]]],
        lead: dict[tuple[str, str, str], dict[str, Any]],
        projects: list[dict[str, Any]],
        steps: dict[Any, list[dict[str, Any]]],
    ) -> None:
        self.kinds = kinds
        self.predecessors = predecessors
        self.lead = lead
        self.projects = projects
        self.steps = steps


def _read(bind: Connection) -> _World:
    kinds: dict[str, str] = {}
    preds: dict[str, dict[str, tuple[str, ...]]] = defaultdict(dict)
    for r in bind.execute(_KINDS).mappings():
        kinds[r["id"]] = r["kind"]
        preds[r["workflow_id"]][r["id"]] = tuple(r["predecessor_ids"] or ())
    lead = {
        (r["workflow_id"], r["category"], r["step_id"]): dict(r)
        for r in bind.execute(_LEAD_ROWS).mappings()
    }
    projects = [dict(r) for r in bind.execute(_PROJECTS).mappings()]
    steps: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for r in bind.execute(_STEP_ROWS).mappings():
        steps[r["project_id"]].append(dict(r))
    return _World(kinds, dict(preds), lead, projects, dict(steps))


def _reached(
    rows: Sequence[Mapping[str, Any]], predecessors: Mapping[str, Sequence[str]]
) -> set[str]:
    """R33-10 `reached` on stored statuses (the rule of
    `services.template_copy.reached_step_ids`)."""

    reached: set[str] = set()
    stack = [r["step_template_id"] for r in rows if r["status"] != _NOT_STARTED]
    while stack:
        sid = stack.pop()
        if sid in reached:
            continue
        reached.add(sid)
        stack.extend(p for p in predecessors.get(sid, ()) if p not in reached)
    return reached


# --- step 1 ---------------------------------------------------------------------------------------


def step1_r62_11_c_no_pr_pr_template(world: _World) -> dict[tuple[str, str, str], int]:
    """R62-11 (owner Q2): C/PDD-J `weeks` 1 → 0. Returns the new `weeks`."""

    row = world.lead.get(C_NO_PR_PR)
    if row is None or row["weeks"] != 1:
        return {}
    return {C_NO_PR_PR: 0}


def step1_template_defaults(
    bind: Connection, world: _World, result: StepsResult
) -> uuid.UUID | None:
    """Step 1 (module docstring). Returns the `template_changes` id when a
    template row changed (it is also the copies' provenance in step 3)."""

    weeks_after = step1_r62_11_c_no_pr_pr_template(world)
    defaults = dict(PDD_DEFAULTS)
    for key, value in OEM_DEFAULTS.items():
        if world.kinds.get(key[2]) == "lab":
            defaults[key] = value
    changes: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for key in sorted(set(defaults) | set(weeks_after)):
        row = world.lead.get(key)
        if row is None:
            continue
        weeks = weeks_after.get(key, row["weeks"])
        hold = row["lab_hold_weeks"]
        if hold is None and key in defaults:
            hold = _clamp(defaults[key], weeks)
        if weeks == row["weeks"] and hold == row["lab_hold_weeks"]:
            continue
        item: dict[str, Any] = {"step_id": key[2]}
        if weeks != row["weeks"]:
            item["weeks"] = [row["weeks"], weeks]
        if hold != row["lab_hold_weeks"]:
            item["lab_hold_weeks"] = [row["lab_hold_weeks"], hold]
        changes[key[1]].append({**item, "_wf": key[0], "_weeks": weeks, "_hold": hold})
    if not changes:
        return None
    change_id = uuid.uuid4()
    summaries: list[dict[str, Any]] = []
    for code in sorted(changes):
        wf = changes[code][0]["_wf"]
        for item in changes[code]:
            bind.execute(_UPDATE_LEAD, {"weeks": item["_weeks"], "hold": item["_hold"],
                                        "wf": wf, "cat": code, "sid": item["step_id"]})  # fmt: skip
            world.lead[(wf, code, item["step_id"])].update(
                weeks=item["_weeks"], lab_hold_weeks=item["_hold"]
            )
            result.template_rows += 1
        version = int(bind.execute(_BUMP_VERSION, {"code": code}).scalar_one())
        steps = [{k: v for k, v in i.items() if not k.startswith("_")} for i in changes[code]]
        summaries.append({
            "workflow_id": wf, "category": code,
            "template_version": [version - 1, version], "steps": steps,
        })  # fmt: skip
        result.categories.append(code)
    bind.execute(_INSERT_CHANGE, {
        "id": change_id, "reason": REASON_DEFAULTS, "changes": json.dumps(summaries),
        "selection": json.dumps({"mode": "migration", "project_ids": []}),
    })  # fmt: skip
    for summary in summaries:
        reasons = [REASON_DEFAULTS]
        if any("weeks" in s for s in summary["steps"]):
            reasons.append(REASON_C_NO_PR_PR)
        _audit(
            bind,
            action="workflow_template.applied",
            entity_type="TemplateChange",
            entity_id=str(change_id),
            hub_id=None,
            before=None,
            after={
                "template_change_id": str(change_id),
                "reason": REASON_DEFAULTS,
                "reasons": reasons,
                "changes": [summary],
                "migration": revision,
            },
        )
    return change_id


# --- step 2 ---------------------------------------------------------------------------------------


def step2_backfill_hold_copies(bind: Connection, world: _World, result: StepsResult) -> None:
    """R62-7: every project's copy of the template room weeks, where NULL."""

    for p in world.projects:
        if p["category"] is None:
            continue
        before: dict[str, Any] = {}
        after: dict[str, Any] = {}
        for s in world.steps.get(p["id"], []):
            t = world.lead.get((p["workflow_id"], p["category"], s["step_template_id"]))
            if t is None or t["lab_hold_weeks"] is None or s["plan_lab_hold_weeks"] is not None:
                continue
            hold = _clamp(t["lab_hold_weeks"], s["plan_weeks"])
            bind.execute(_SET_HOLD, {"hold": hold, "id": s["id"]})
            before[s["step_template_id"]], after[s["step_template_id"]] = None, hold
            s["plan_lab_hold_weeks"] = hold
        if after:
            result.backfilled_projects += 1
            _audit(
                bind, action="project.lab_hold_backfilled", entity_type="Project",
                entity_id=str(p["id"]), hub_id=p["hub_id"],
                before={"plan_lab_hold_weeks": before},
                after={"plan_lab_hold_weeks": after, "reason": REASON_DEFAULTS},
            )  # fmt: skip


# --- step 3 ---------------------------------------------------------------------------------------


def step3_r62_11_c_no_pr_pr_copies(
    bind: Connection, world: _World, result: StepsResult, change_id: uuid.UUID | None
) -> None:
    """R62-11 / R62-12: C/PDD-J `plan_weeks` 1 → 0 on ¬never pairs, whatever
    ownEffort says. A frozen / Cancelled / Commercialized project, or one
    that reached J, keeps its copy."""

    wf, cat, sid = C_NO_PR_PR
    template = world.lead.get(C_NO_PR_PR)
    if template is None or template["weeks"] != 0:
        return
    for p in world.projects:
        if p["workflow_id"] != wf or p["category"] != cat:
            continue
        if p["frozen"] or p["status"] in _CLOSED:
            continue
        rows = world.steps.get(p["id"], [])
        row = next((r for r in rows if r["step_template_id"] == sid), None)
        if row is None or row["plan_weeks"] != 1:
            continue
        if sid in _reached(rows, world.predecessors.get(wf, {})):
            continue
        hold = _clamp(row["plan_lab_hold_weeks"], 0)
        bind.execute(_SET_PLAN, {"plan": 0, "hold": hold, "id": row["id"], "change_id": change_id})
        before = {"plan_weeks": 1}
        after: dict[str, Any] = {"plan_weeks": 0}
        if hold != row["plan_lab_hold_weeks"]:
            before["plan_lab_hold_weeks"], after["plan_lab_hold_weeks"] = (
                row["plan_lab_hold_weeks"], hold,
            )  # fmt: skip
        row["plan_weeks"], row["plan_lab_hold_weeks"] = 0, hold
        result.c_copies += 1
        _audit(
            bind, action="project.template_applied", entity_type="Project",
            entity_id=str(p["id"]), hub_id=p["hub_id"],
            before={"steps": {sid: before}},
            after={
                "template_change_id": None if change_id is None else str(change_id),
                "workflow_id": wf, "category": cat, "received_as": "migration",
                "reason": REASON_C_NO_PR_PR, "steps": {sid: after},
                "weeks": {sid: [1, 0]}, "effort_rederived": False,
            },
        )  # fmt: skip


# --- step 4 ---------------------------------------------------------------------------------------


def _figure(value: Any) -> str | None:
    return None if value is None else str(value)


def step4_r62_1_rederive(bind: Connection, world: _World, result: StepsResult) -> None:
    """R62-1 (owner Q1 "Only PoC + Certification"): re-derive every
    non-frozen project with a figure or a stored effort value, with the
    `partialRoom` steps outside the lab S′. Uses the engine's split and the
    service's ADR 0070 hold-back rule (pure functions)."""

    from scheduling.effort_split import EffortSplitRejected, EffortStepInput, derive_project_effort
    from services.project_effort import HoldBackStep, held_out
    from services.workflow_durations import own_effort_kinds

    for p in world.projects:
        rows = world.steps.get(p["id"], [])
        has_figure = p["design_effort_weeks"] is not None or p["lab_effort_weeks"] is not None
        if p["frozen"] or not (has_figure or any(r["effort_weeks"] is not None for r in rows)):
            continue
        wf, cat = p["workflow_id"], p["category"]
        weights = {
            sid: int(t["effort_weight_weeks"])
            for (w, c, sid), t in world.lead.items()
            if w == wf and c == cat
        }
        kind_of = {r["step_template_id"]: world.kinds.get(r["step_template_id"], "elapsed")
                   for r in rows}  # fmt: skip
        held = held_out(
            HoldBackStep(
                step_id=r["step_template_id"],
                kind=kind_of[r["step_template_id"]],
                weight=weights.get(r["step_template_id"], 0),
                excluded=bool(r["excluded"]),
                not_started=r["status"] == _NOT_STARTED,
                effort_weeks=r["effort_weeks"],
                plan_weeks=r["plan_weeks"],
                lab_hold_weeks=r["plan_lab_hold_weeks"],
            )
            for r in rows
        )
        try:
            derivation = derive_project_effort(
                design_effort_weeks=_as_decimal(p["design_effort_weeks"]),
                lab_effort_weeks=_as_decimal(p["lab_effort_weeks"]),
                certification_testing_required=bool(p["certification_testing_required"]),
                steps=tuple(
                    EffortStepInput(
                        step_id=r["step_template_id"],
                        sequence_order=r["sequence_order"],
                        kind=kind_of[r["step_template_id"]],
                        lead_weeks=weights.get(r["step_template_id"], 0),
                        started=r["status"] != _NOT_STARTED,
                        excluded=bool(r["excluded"]) or r["step_template_id"] in held,
                        lab_hold_weeks=r["plan_lab_hold_weeks"],
                    )
                    for r in rows
                ),
            )
        except EffortSplitRejected:
            result.rejected_projects.append(str(p["id"]))
            continue
        wanted = derivation.effort_weeks_by_step()
        before = {r["step_template_id"]: r["effort_weeks"] for r in rows}
        after = {r["step_template_id"]: wanted.get(r["step_template_id"]) for r in rows}
        if before == after:
            continue
        for r in rows:
            if r["effort_weeks"] != after[r["step_template_id"]]:
                bind.execute(_SET_EFFORT, {"effort": after[r["step_template_id"]], "id": r["id"]})
                r["effort_weeks"] = after[r["step_template_id"]]
        # OR-5: a kind that loses its own figure follows the template again
        # on its not-reached steps (lengths; the room weeks are clamped).
        lost = own_effort_kinds(before.items(), kind_of) - own_effort_kinds(after.items(), kind_of)
        recopied: dict[str, dict[str, list[Any]]] = {}
        if lost and cat is not None:
            reached = _reached(rows, world.predecessors.get(wf, {}))
            for r in rows:
                sid = r["step_template_id"]
                if sid in reached or kind_of[sid] not in lost:
                    continue
                t = world.lead.get((wf, cat, sid))
                weeks = 0 if t is None else int(t["weeks"])
                hold = _clamp(r["plan_lab_hold_weeks"], weeks)
                if weeks == r["plan_weeks"] and hold == r["plan_lab_hold_weeks"]:
                    continue
                diff: dict[str, list[Any]] = {}
                if weeks != r["plan_weeks"]:
                    diff["plan_weeks"] = [r["plan_weeks"], weeks]
                if hold != r["plan_lab_hold_weeks"]:
                    diff["plan_lab_hold_weeks"] = [r["plan_lab_hold_weeks"], hold]
                bind.execute(_SET_PLAN, {"plan": weeks, "hold": hold, "id": r["id"],
                                         "change_id": None})  # fmt: skip
                r["plan_weeks"], r["plan_lab_hold_weeks"] = weeks, hold
                recopied[sid] = diff
        bind.execute(_STALE_ONE, {"id": p["id"]})
        result.rederived_projects += 1
        state = {
            "project_id": str(p["id"]),
            "design_effort_weeks": _figure(p["design_effort_weeks"]),
            "lab_effort_weeks": _figure(p["lab_effort_weeks"]),
            "certification_testing_required": bool(p["certification_testing_required"]),
            "category": cat,
        }
        after_state: dict[str, Any] = {
            **state,
            "effort_weeks": dict(sorted(after.items())),
            "design_split": _split_state(derivation.design),
            "lab_split": _split_state(derivation.lab),
            "trigger": TRIGGER_LAB_HOLD_DEFAULT,
        }
        if recopied:
            after_state["template_copy"] = dict(sorted(recopied.items()))
        _audit(
            bind, action="project.effort_rederived", entity_type="Project",
            entity_id=str(p["id"]), hub_id=p["hub_id"],
            before={**state, "effort_weeks": dict(sorted(before.items()))},
            after=after_state,
        )  # fmt: skip


def _as_decimal(value: Any) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def _split_state(split: Any) -> dict[str, Any]:
    return {
        "applied": split.applied,
        "not_applied_reason": split.not_applied_reason,
        "target_weeks": split.target_weeks,
        "raised_step_ids": list(split.raised_step_ids),
    }


# --- step 5 / driver ------------------------------------------------------------------------------


def step5_mark_stale(bind: Connection, result: StepsResult) -> None:
    """Every schedulable project stale when anything changed. No run."""

    if result.changed:
        bind.execute(_STALE_ALL, {"closed": list(_NON_SCHEDULABLE)})
        result.stale_marked = True


def run_data_steps(bind: Connection) -> StepsResult:
    """Steps 1–5 in order, on the caller's transaction (alembic's)."""

    result = StepsResult()
    world = _read(bind)
    change_id = step1_template_defaults(bind, world, result)
    step2_backfill_hold_copies(bind, world, result)
    step3_r62_11_c_no_pr_pr_copies(bind, world, result, change_id)
    step4_r62_1_rederive(bind, world, result)
    step5_mark_stale(bind, result)
    return result


def upgrade() -> None:
    op.add_column(_LEAD, sa.Column("lab_hold_weeks", sa.Integer(), nullable=True))
    op.create_check_constraint(
        op.f(_CK_LEAD),
        _LEAD,
        "lab_hold_weeks IS NULL OR (lab_hold_weeks >= 0 AND lab_hold_weeks <= weeks)",
    )
    op.add_column(_STEPS, sa.Column("plan_lab_hold_weeks", sa.Integer(), nullable=True))
    op.create_check_constraint(
        op.f(_CK_STEPS),
        _STEPS,
        "plan_lab_hold_weeks IS NULL OR "
        "(plan_lab_hold_weeks >= 0 AND plan_lab_hold_weeks <= plan_weeks)",
    )
    op.add_column(_RUN_STEPS, sa.Column("lab_hold_weeks", sa.Integer(), nullable=True))
    op.create_check_constraint(
        op.f(_CK_RUN),
        _RUN_STEPS,
        "lab_hold_weeks IS NULL OR "
        "(lab_hold_weeks >= 0 AND lab_hold_weeks <= end_week - start_week + 1)",
    )
    run_data_steps(op.get_bind())


def downgrade() -> None:
    op.drop_constraint(op.f(_CK_RUN), _RUN_STEPS, type_="check")
    op.drop_column(_RUN_STEPS, "lab_hold_weeks")
    op.drop_constraint(op.f(_CK_STEPS), _STEPS, type_="check")
    op.drop_column(_STEPS, "plan_lab_hold_weeks")
    op.drop_constraint(op.f(_CK_LEAD), _LEAD, type_="check")
    op.drop_column(_LEAD, "lab_hold_weeks")
