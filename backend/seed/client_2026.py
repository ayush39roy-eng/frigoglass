"""Seed inputs the client's 2026 workbook does not carry, derived
deterministically from `client_2026_seed_data.json` (ADR 0024).

Pure functions and constants only: no database access and no I/O. Both
`seed_demo_data.py` and the tests use them. Every rule here is a *seed
input*. No scheduling or capacity formula is changed: the figures the app
shows are what the scheduler and the ADR 0008/0016 formulas compute from
these inputs.

Engineers and leaders (`assign_leaders`, `tune_fte`)
----------------------------------------------------
- Every Excel project leader becomes one engineer. Their hub is the hub where
  they lead the most projects (computed by the extractor).
- The scheduler books a project's leader for every week of every design
  step (DOMAIN_RULES "Booking rules"). The workbook names a few leaders on
  very many open projects: Dipak leads 52 and Pawan 29. Booked as one person
  each, most of their projects could not be placed before `HORIZON_WEEKS`.
  The workbook leader is clearly the responsible lead, not the only designer.
  So:
  - an engineer leads at most `MAX_OPEN_PROJECTS_PER_ENGINEER` open
    (scheduled) projects, taken in scheduling order;
  - a workbook leader's overflow goes to the least-loaded named capacity
    engineer of the *project's* hub ("<hub> Engineer <n>", created when none
    has room). These engineers are not people from the workbook;
  - a project with a blank leader goes to the least-loaded engineer of its
    own hub with room, workbook leaders included. Ties go to the first name
    alphabetically;
  - closed projects (Commercialized / On Hold / Cancelled) keep their workbook
    leader with no cap. A blank leader goes to the hub's least-loaded engineer;
  - a hub with no engineer at all still gets "<hub> Engineer 1". R&D-Greece
    and OEM-Seltek have no workbook leader of their own.
  The workbook leader of every project stays in the seed JSON (`leader`).
- Every engineer may lead every category, OEM included, so no project raises
  CAT_NOT_ALLOWED.
- **FTE is demo tuning.** It is ADR 0024's target booked %, not the client's
  roster, and must be replaced by the roster. Since ADR 0032 (supersedes
  ADR 0002) FTE also gates design speed (`span = ceil(duration / fte)`),
  so the tuned FTEs change the plan, not just the booked %. After the
  seed has written the projects it runs the greedy scheduler once, in
  memory, and reads each hub's design load the way the Capacity surface
  does (I6). `tune_fte` then sets the hub's total FTE to
  `load / (target × working weeks per engineer)`:
  - the target is R&D-India 60 % and every other hub 100 %;
  - the total is rounded down to 0.01, so the hub books at or just above
    its target;
  - it is spread evenly over the hub's engineers.

Lab supply (`tune_efficiency`)
------------------------------
**Chamber efficiency is demo tuning** too (ADR 0024: lab "Full", about 100 %
in every lab region). Efficiency only feeds the ADR 0008 supply figure, and
booking is gated by `max_concurrent` alone. Platforms, downtime and
allowed stages stay the client's values. Using the same in-memory run, each
region's chamber efficiencies are scaled by one factor, `lab load / lab
supply`. Each result is rounded down to 0.001 and capped at 1.0, so the
region books at or just above 100 %.

Priority dimensions (`derive_dims`)
-----------------------------------
The workbook has no prioritization scores. Each project gets 13 scores in
1..5 whose band (DOMAIN_RULES "Prioritization scoring") equals the project's
`priority`. The score starts at all 1s and is raised one dimension at a time,
in an order seeded from the project code, until the weighted score reaches the
band's target percentage:
- P1: 90 − 3 × (rank − 1) for Marketing Priority rank 1..5;
- P2: 66 − (rank − 6) for rank 6..13;
- P3: 45..52;
- P4: 25..36.
The unranked P3/P4 targets vary with the project code. No hard gates are set,
because the workbook records none.

Step progress (`derive_progress`)
---------------------------------
The workbook has no per-step data. Only non-skipped steps carry progress. A
skipped step (0-week lead time, or a lab step with certification testing off)
stays Not Started, and the scheduler treats it as complete. The *current step*
is chosen as follows:
- **Under Industrialization**: the first non-skipped step after
  Certification (step H). All design and lab steps before it are Done.
- **In Development** with a Development Step (`PDD-H`, `PDD-J`, ...): that
  step. If it is skipped for the category, the next non-skipped step is used.
  The steps before it are Done.
- **In Development** without one: a deterministic point in the workflow.
  `IN_DEVELOPMENT_POINTS` lists candidate step letters, and the project code
  picks one. The steps before it are Done.
- **In Queue**, **On Hold**, **Cancelled**: every step is Not Started.
- **Commercialized**: every non-skipped step is Done.

The current step is **In Progress** at `IN_PROGRESS_PERCENT`, with one
exception. A design step whose leader already has an In Progress design step
at `current_week` stays **Not Started** (waiting for the leader), and so does
a lab step for which no chamber of the project's lab region has a free
platform at `current_week`. Two anchored tails therefore never collide on one
engineer (I1) or overfill a chamber (I2). Projects are visited in scheduling
order (DOMAIN_RULES "Scheduling order"), so the higher-priority project gets
the free resource.

Weeks, consistent with the progress rules (DOMAIN_RULES "Per-stage progress
capture") and I21:
- In Progress: `remaining = ceil(duration × (1 − pct/100))`, and
  `actual_start_week = current_week − (duration − remaining)`. The tail starts
  at `current_week` and books exactly `remaining` weeks.
- Done steps are laid back to back, in sequence order, ending the week before
  the current step starts. If there is no In Progress step, they end at
  `current_week − 1`. Each Done step spans its lead-time duration. When that
  history would start before the project's request week, each step's span is
  shortened (never below one week) so that the history starts no earlier than
  the request week. It is never earlier than week 1. Every Done step therefore
  ends before `current_week`.
"""

from __future__ import annotations

import hashlib
import math
import uuid
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

import domain_constants as dc

#: The most open (scheduled) projects one engineer leads (module docstring).
MAX_OPEN_PROJECTS_PER_ENGINEER: int = 4

#: Target design booked % (yearly) per hub; ADR 0024. FTE is derived from it.
TARGET_DESIGN_BOOKED_PCT: Mapping[str, float] = {"R&D-India": 60.0}
DEFAULT_TARGET_DESIGN_BOOKED_PCT: float = 100.0

#: The highest FTE `tune_fte` gives one engineer.
MAX_FTE: float = 1.0

#: Target lab booked % (yearly) per lab region; ADR 0024.
TARGET_LAB_BOOKED_PCT: float = 100.0

#: The highest chamber efficiency `tune_efficiency` sets.
MAX_EFFICIENCY: float = 1.0

#: Candidate current steps (by letter) for an In Development project without
#: a Development Step. The project code picks one.
IN_DEVELOPMENT_POINTS: tuple[str, ...] = ("J", "K", "K")

#: percent_complete of an In Progress current step.
IN_PROGRESS_PERCENT: int = 50

ALL_CATEGORIES: tuple[str, ...] = ("A+", "A", "B", "C", "OEM")

_UNSCHEDULED = frozenset({"Commercialized", "On Hold", "Cancelled", "Draft"})
UNDER_INDUSTRIALIZATION_AFTER = "H"  # current step: the first non-skipped one after this letter


#: Namespace of the deterministic row ids (`uuid5`). The scheduler breaks
#: scheduling-order ties by project id and walks chambers in id order, so
#: fixed ids make every reseed produce the same run.
ID_NAMESPACE = uuid.UUID("6f3c2a1e-6b1d-5a4e-9d38-2026c11e2026")


def project_uuid(external_code: str) -> uuid.UUID:
    return uuid.uuid5(ID_NAMESPACE, f"project:{external_code}")


def engineer_uuid(name: str) -> uuid.UUID:
    return uuid.uuid5(ID_NAMESPACE, f"engineer:{name}")


def chamber_uuid(code: str) -> uuid.UUID:
    return uuid.uuid5(ID_NAMESPACE, f"chamber:{code}")


def _digest(code: str, salt: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{salt}:{code}".encode()).digest()[:8], "big")


# --- Engineers -------------------------------------------------------------


@dataclass
class EngineerSeed:
    name: str
    hub: str
    fte: float
    allowed_categories: tuple[str, ...]
    from_workbook: bool


#: Statuses that are scheduled (DOMAIN_RULES "Scheduling order").
OPEN_STATUSES = frozenset(dc.SCHEDULABLE_STATUS_ORDER)


def is_open(project: Mapping[str, object]) -> bool:
    return project["status"] in OPEN_STATUSES


def scheduling_order_key(
    project: Mapping[str, object], project_id: str
) -> tuple[int, int, int, str]:
    """DOMAIN_RULES "Scheduling order" (nothing is frozen in this dataset),
    with the same `project_id` tie-break the scheduler uses."""

    return (
        dc.PRIORITY_ORDER.index(str(project["priority"])),
        dc.SCHEDULABLE_STATUS_ORDER.get(str(project["status"]), len(dc.SCHEDULABLE_STATUS_ORDER)),
        dc.CATEGORY_ORDER.index(str(project["category"])),
        project_id,
    )


def assign_leaders(
    projects: Sequence[Mapping[str, object]],
    leaders: Iterable[Mapping[str, object]],
    order: Sequence[int],
) -> tuple[list[str], list[EngineerSeed]]:
    """(leader name per project in input order, engineer roster). `order` is
    the project indexes in scheduling order (module docstring)."""

    roster: dict[str, EngineerSeed] = {}
    for leader in leaders:
        name = str(leader["name"])
        roster[name] = EngineerSeed(name, str(leader["hub"]), 1.0, ALL_CATEGORIES, True)
    capacity_names: dict[str, list[str]] = {}
    open_load: Counter[str] = Counter()

    def new_capacity_engineer(hub: str) -> str:
        names = capacity_names.setdefault(hub, [])
        name = f"{hub} Engineer {len(names) + 1}"
        if name in roster:
            raise ValueError(f"capacity engineer {name!r} clashes with a workbook leader")
        names.append(name)
        roster[name] = EngineerSeed(name, hub, 1.0, ALL_CATEGORIES, False)
        return name

    def least_loaded(candidates: Iterable[str]) -> str | None:
        room = [n for n in sorted(candidates) if open_load[n] < MAX_OPEN_PROJECTS_PER_ENGINEER]
        return min(room, key=lambda n: open_load[n]) if room else None

    out: list[str | None] = [None] * len(projects)
    for i in order:
        p = projects[i]
        hub = str(p["hub"])
        excel = p.get("leader")
        if excel is not None and str(excel) not in roster:
            raise ValueError(f"leader {excel!r} is not in the leaders list")
        if not is_open(p):
            continue
        if excel and open_load[str(excel)] < MAX_OPEN_PROJECTS_PER_ENGINEER:
            chosen = str(excel)
        elif excel:
            chosen = least_loaded(capacity_names.get(hub, ())) or new_capacity_engineer(hub)
        else:
            hub_engineers = [e.name for e in roster.values() if e.hub == hub]
            chosen = least_loaded(hub_engineers) or new_capacity_engineer(hub)
        open_load[chosen] += 1
        out[i] = chosen

    # Closed projects (never scheduled): the Excel leader, else the hub's
    # least-loaded engineer, with no cap.
    for i, p in enumerate(projects):
        if out[i] is not None:
            continue
        excel = p.get("leader")
        if excel:
            out[i] = str(excel)
            continue
        hub = str(p["hub"])
        hub_engineers = sorted(e.name for e in roster.values() if e.hub == hub)
        if not hub_engineers:
            hub_engineers = [new_capacity_engineer(hub)]
        out[i] = min(hub_engineers, key=lambda n: open_load[n])

    for hub in dc.HUB_LAB_REGION:
        if not any(e.hub == hub for e in roster.values()):
            new_capacity_engineer(hub)
    return [str(n) for n in out], list(roster.values())


def working_weeks_per_engineer(hub: str) -> float:
    """ADR 0008 `52 − deduction_weeks` from `HUB_WORK_CALENDAR_SEED`."""

    for name, weekdays, *days in dc.HUB_WORK_CALENDAR_SEED:
        if name == hub:
            return dc.WEEKS_IN_YEAR - sum(days) / weekdays
    raise KeyError(hub)


def tune_fte(roster: list[EngineerSeed], design_load_by_hub: Mapping[str, int]) -> None:
    """Set FTEs so each hub's process-derived design load books its yearly
    design capacity at `TARGET_DESIGN_BOOKED_PCT` (module docstring). The hub
    total is rounded *down* to 0.01 FTE, so a 100 % hub is booked at or just
    above 100 % ("full"). It is spread evenly over the hub's engineers in name
    order. A hub that would need more than `MAX_FTE` per engineer gets
    capacity-only engineers ("<hub> Engineer <n>", leading nothing) until it
    does not. Mutates `roster`."""

    for hub in dc.HUB_LAB_REGION:
        load = design_load_by_hub.get(hub, 0)
        members = sorted((e for e in roster if e.hub == hub), key=lambda e: e.name)
        if load <= 0 or not members:
            continue
        target = TARGET_DESIGN_BOOKED_PCT.get(hub, DEFAULT_TARGET_DESIGN_BOOKED_PCT)
        hundredths = math.floor(load / (target / 100 * working_weeks_per_engineer(hub)) * 100)
        while hundredths > round(MAX_FTE * 100) * len(members):
            n = sum(1 for e in roster if e.hub == hub and not e.from_workbook) + 1
            extra = EngineerSeed(f"{hub} Engineer {n}", hub, 1.0, ALL_CATEGORIES, False)
            roster.append(extra)
            members = sorted((e for e in roster if e.hub == hub), key=lambda e: e.name)
        base, extra_hundredths = divmod(hundredths, len(members))
        for idx, e in enumerate(members):
            e.fte = (base + (1 if idx < extra_hundredths else 0)) / 100


def tune_efficiency(
    chambers: Sequence[tuple[str, str, float, float, int]],
    lab_load_by_region: Mapping[str, float],
) -> dict[str, float]:
    """New efficiency per chamber code (module docstring "Lab supply").

    `chambers` rows are (code, lab_region, efficiency, working_weeks_per_chamber,
    platforms), with working weeks as `services.capacity_supply` computes them.
    A region with no lab load keeps its efficiencies."""

    supply: dict[str, float] = {}
    for _code, region, eff, weeks, platforms in chambers:
        supply.setdefault(region, 0.0)
        supply[region] += weeks * eff * platforms
    out: dict[str, float] = {}
    for code, region, eff, _weeks, _platforms in chambers:
        load = lab_load_by_region.get(region, 0.0)
        if load <= 0 or supply[region] <= 0:
            out[code] = eff
            continue
        factor = load / (TARGET_LAB_BOOKED_PCT / 100) / supply[region]
        scaled = math.floor(eff * factor * 1000) / 1000
        out[code] = min(MAX_EFFICIENCY, max(0.001, scaled))
    return out


# --- Priority dimensions ---------------------------------------------------


def _target_pct(code: str, priority: str, marketing_priority: int | None) -> int:
    if priority == "P1":
        rank = marketing_priority if marketing_priority is not None else 5
        return 90 - 3 * (min(max(rank, 1), 5) - 1)
    if priority == "P2":
        rank = marketing_priority if marketing_priority is not None else 13
        return 66 - (min(max(rank, 6), 13) - 6)
    if priority == "P3":
        return 45 + _digest(code, "p3") % 8
    return 25 + _digest(code, "p4") % 12


def band_for(dims: Sequence[int]) -> tuple[int, int, str]:
    """(weighted_score, normalised_pct, band), DOMAIN_RULES "Prioritization scoring"."""

    # ADR 0029: points = score / 5 * weight; pct = round(sum / TOTAL_WEIGHT * 100).
    weighted = sum(
        s * w / dc.DIMENSION_SCORE_MAX
        for s, (*_r, w) in zip(dims, dc.PRIORITIZATION_DIMENSIONS, strict=True)
    )
    pct = round(weighted / dc.TOTAL_WEIGHT * 100)
    band = next(label for threshold, label in dc.PRIORITY_BAND_THRESHOLDS if pct >= threshold)
    return weighted, pct, band


def derive_dims(code: str, priority: str, marketing_priority: int | None) -> list[int]:
    """13 dimension scores whose band equals `priority` (module docstring)."""

    n = len(dc.PRIORITIZATION_DIMENSIONS)
    target = _target_pct(code, priority, marketing_priority)
    order = sorted(range(n), key=lambda i: _digest(code, f"dim{i}"))
    dims = [dc.SEED_DIMENSION_SCORE_FLOOR] * n
    i = 0
    while band_for(dims)[1] < target and any(d < dc.DIMENSION_SCORE_MAX for d in dims):
        idx = order[i % n]
        if dims[idx] < dc.DIMENSION_SCORE_MAX:
            dims[idx] += 1
        i += 1
    if band_for(dims)[2] != priority:
        raise AssertionError(f"{code}: derived dims band {band_for(dims)[2]} != {priority}")
    return dims


# --- Step progress ---------------------------------------------------------


@dataclass(frozen=True)
class StepSpec:
    """One of a project's 14 steps: template id, kind, and its duration for
    this project (0 = skipped, including a cert-off lab step)."""

    step_id: str
    kind: str
    duration: int


@dataclass(frozen=True)
class StepProgress:
    status: str
    percent_complete: int
    actual_start_week: int | None
    actual_end_week: int | None


NOT_STARTED = StepProgress("Not Started", 0, None, None)


class ResourceLedger:
    """Who is already busy at `current_week` with an In Progress tail: one
    design step per leader, and per lab region the free platforms of each
    chamber (`domain_constants.CHAMBER_SEED`, first fit by chamber code)."""

    def __init__(self) -> None:
        self.busy_leaders: set[str] = set()
        self.free_platforms: dict[str, int] = {
            code: plat for code, _r, plat, *_x in dc.CHAMBER_SEED
        }
        self.chambers: list[tuple[str, str, tuple[str, ...]]] = sorted(
            (code, region, stages) for code, region, _p, _e, _m, _b, _c, stages in dc.CHAMBER_SEED
        )

    def take(self, kind: str, step_id: str, leader: str, region: str) -> bool:
        if kind == "design":
            if leader in self.busy_leaders:
                return False
            self.busy_leaders.add(leader)
            return True
        if kind == "lab":
            for code, chamber_region, stages in self.chambers:
                if chamber_region == region and step_id in stages and self.free_platforms[code] > 0:
                    self.free_platforms[code] -= 1
                    return True
            return False
        return True  # elapsed: books nothing


def current_step_index(project: Mapping[str, object], steps: Sequence[StepSpec]) -> int | None:
    """Index into `steps` of the project's current step, or None when no
    step has started (In Queue / On Hold / Cancelled) and len(steps) when
    every step is done (Commercialized)."""

    status = project["status"]
    live = [i for i, s in enumerate(steps) if s.duration > 0]
    if not live:
        return None
    if status == "Commercialized":
        return len(steps)
    letter: str | None = None
    if status == "Under Industrialization":
        after = [i for i in live if steps[i].step_id[-1] > UNDER_INDUSTRIALIZATION_AFTER]
        return after[0] if after else live[-1]
    if status == "In Development":
        dev = project.get("development_step")
        if isinstance(dev, str) and dev:
            letter = dev[-1]
        else:
            code = str(project["external_code"])
            letter = IN_DEVELOPMENT_POINTS[_digest(code, "dev") % len(IN_DEVELOPMENT_POINTS)]
        at_or_after = [i for i in live if steps[i].step_id[-1] >= letter]
        return at_or_after[0] if at_or_after else live[-1]
    return None


def derive_progress(
    project: Mapping[str, object],
    steps: Sequence[StepSpec],
    *,
    leader: str,
    lab_region: str,
    current_week: int,
    ledger: ResourceLedger,
) -> list[StepProgress]:
    """Per-step progress for one project (module docstring). `steps` is the
    project's 14 steps in sequence order."""

    k = current_step_index(project, steps)
    out = [NOT_STARTED] * len(steps)
    if k is None:
        return out

    history_end = current_week - 1
    if k < len(steps):
        cur = steps[k]
        if ledger.take(cur.kind, cur.step_id, leader, lab_region):
            remaining = math.ceil(cur.duration * (1 - IN_PROGRESS_PERCENT / 100))
            start = current_week - (cur.duration - remaining)
            out[k] = StepProgress("In Progress", IN_PROGRESS_PERCENT, start, None)
            history_end = start - 1

    done = [i for i in range(min(k, len(steps))) if steps[i].duration > 0]
    if not done:
        return out
    request_week = int(str(project.get("request_week") or 1))
    floor = max(1, min(request_week, history_end - len(done) + 1))
    spans = [steps[i].duration for i in done]
    available = history_end - floor + 1
    if sum(spans) > available:
        # Shrink proportionally, at least one week each, to fit the window.
        scaled = [max(1, (d * available) // sum(spans)) for d in spans]
        while sum(scaled) > available and max(scaled) > 1:
            scaled[scaled.index(max(scaled))] -= 1
        spans = scaled
    end = history_end
    for i, span in zip(reversed(done), reversed(spans), strict=True):
        start = max(1, end - span + 1)
        out[i] = StepProgress("Done", 100, start, end)
        end = start - 1
    return out
