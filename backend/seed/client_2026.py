"""Seed inputs the client's 2026 workbook does not carry, derived
deterministically from `client_2026_seed_data.json` (ADR 0024, ADR 0035).

Pure functions and constants only: no database access and no I/O. Both
`seed_demo_data.py` and the tests use them. Every rule here is a *seed
input*. No scheduling or capacity formula is changed: the figures the app
shows are what the scheduler and the ADR 0008/0016 formulas compute from
these inputs.

ADR 0035 (2026-10-21) retires ADR 0024's demo tuning. The seed no longer
caps a leader's projects, creates no "<hub> Engineer <n>" rows, and no
longer tunes FTE or chamber efficiency toward a target booked %.

Engineers (`build_roster`)
--------------------------
- **Roster.** The formula workbook's engineer table (`RPD Capacity!I42:T50`,
  extracted into the JSON's `roster`): name, hub and FTE exactly as the
  workbook gives them (Rishi 1.0, Atul 0.5, Ashish in R&D-India, ...).
- **Zero-FTE placeholders are not created.** The workbook's "New Hiring"
  and "New engineer-Contractual" rows have a Resource Count of 0. An
  engineer needs FTE >= 0.01 (the API bound; ADR 0032 makes a 0-FTE leader a
  `data_error`), so they are skipped and listed in `RosterBuild.placeholders`
  (docs/OPEN_QUESTIONS.md).
- **Allowed categories.** The formula workbook gives none per engineer, so
  every roster engineer takes the client app's chips
  (`CLIENT_APP_ALLOWED_CATEGORIES`, from the client's older app,
  `Engineer.allowedTypes`). Rishi's chip "M" has no app category and is
  dropped. A mismatch only raises the CAT_NOT_ALLOWED warning; it never
  blocks scheduling (DOMAIN_RULES "Booking rules").
- **Leader aliases.** The project file writes some roster people by first
  name (`LEADER_ALIASES`: Rahul, Stef, Alin, Adrian).
- **Provisional leaders.** A workbook project leader who is not on the
  roster (Dipak, Elena Micu, Theoni, Marian, Sailesh, Antonis) is added as
  an engineer **flagged provisional** (`EngineerSeed.provisional`; the
  `engineers` table has no notes or flag column, so the flag lives here and
  in ADR 0035). Their hub is the hub where they lead the most projects of
  the dataset (the extractor's `leaders[].hub`; ties alphabetically), FTE
  `PROVISIONAL_LEADER_FTE` = 1.0, and their allowed categories are the
  categories of the projects they lead. The client must confirm their FTE
  and that they are design engineers (docs/OPEN_QUESTIONS.md).
- **Assignments.** A project's leader is its workbook leader, through the
  alias map. Nothing is reassigned or capped. **A blank leader stays
  blank** (`leader_engineer_id` null): the scheduler leaves the project
  out with `no_leader` (DOMAIN_RULES "Booking rules"). No assignment is
  invented.
- **OEM hubs** have no roster engineers. Their projects are led only by
  the provisional leaders named on them (Theoni); the rest have no leader.

Chambers
--------
Seeded from `domain_constants.CHAMBER_SEED` exactly: the formula workbook's
platforms, efficiency (0.7 / 0.6 / 0.6 / 0.5, ...) and downtime. Allowed
stages stay ours (docs/OPEN_QUESTIONS.md).

Priority dimensions (`derive_dims`) — SYNTHETIC
-----------------------------------------------
**The 13 dimension scores are synthetic** (`SYNTHETIC_DIMENSION_SCORES`).
The workbook and every other client source hold no rubric scores; the
real scores are asked in docs/OPEN_QUESTIONS.md. They are kept, not
blanked, because blank scores would put every project in "Unscored" and
empty the Matrix. Each project gets 13 scores in 1..5 whose band
(DOMAIN_RULES "Prioritization scoring") equals the project's `priority`.
The score starts at all 1s and is raised one dimension at a time, in an
order seeded from the project code, until the weighted score reaches the
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
the free resource. A project with no leader books nothing in a run, so the
seed derives its progress against a private ledger.

Weeks, consistent with the progress rules (DOMAIN_RULES "Per-stage progress
capture") and I21:
- In Progress: `remaining = ceil(duration × (1 − pct/100))`, and
  `actual_start_week = current_week − (duration − remaining)`. The tail starts
  at `current_week` and books `remaining` weeks of effort (stretched by the
  leader's FTE in the run, ADR 0032).
- Done steps are laid back to back, in sequence order, ending the week before
  the current step starts. If there is no In Progress step, they end at
  `current_week − 1`. Each Done step spans its lead-time duration. When that
  history would start before the project's request week, each step's span is
  shortened (never below one week) so that the history starts no earlier than
  the request week. It is never earlier than week 1. Every Done step therefore
  ends before `current_week`.

Project fields (ADR 0035)
-------------------------
- `plant`, `requesting_department`, `product_type`: the workbook values.
- `carry_over` / `reg_year` (`carry_over_and_reg_year`): a project the
  project file flags `Spillover '25` is `carry_over = true`, `reg_year =
  2025`; every other project is `carry_over = false`, `reg_year = 2026`.
- `target_end_week`: the extractor's plan week of "Project End Date -
  LATEST" (2025 dates are not imported; see the extractor docstring).
"""

from __future__ import annotations

import hashlib
import math
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

import domain_constants as dc
from seed.initial_scoring_rubric import INITIAL_KEYS, initial_rubric
from services.priority_scoring import compute_score

#: ADR 0035: every seeded rubric score is synthetic (module docstring).
SYNTHETIC_DIMENSION_SCORES: bool = True

#: Candidate current steps (by letter) for an In Development project without
#: a Development Step. The project code picks one.
IN_DEVELOPMENT_POINTS: tuple[str, ...] = ("J", "K", "K")

#: percent_complete of an In Progress current step.
IN_PROGRESS_PERCENT: int = 50

#: The smallest FTE an engineer may have (the API bound, `schemas/engineer.py`).
MIN_FTE: float = 0.01

#: FTE of a provisional leader (ADR 0035; the client must confirm it).
PROVISIONAL_LEADER_FTE: float = 1.0

#: The project file writes these roster people by a short name.
LEADER_ALIASES: Mapping[str, str] = {
    "Rahul": "Rahul-Contractual",
    "Stef": "Stef Marius",
    "Alin": "Alin Boboc",
    "Adrian": "Adrian Bortoc",
}

#: Allowed categories per roster engineer. The formula workbook gives none,
#: so these are the client app's chips (its `Engineer.allowedTypes`, the
#: older app's April–May 2026 data). Rishi's "M" chip is not an app category
#: and is dropped; Dimopoulou's chip "OEM" means any OEM category.
CLIENT_APP_ALLOWED_CATEGORIES: Mapping[str, tuple[str, ...]] = {
    "Rishi": ("A", "B", "C"),
    "Lokesh": ("B", "C"),
    "Zakir": ("B", "C"),
    "Pawan": ("B", "C"),
    "Nikhil": ("B", "C"),
    "Atul": ("B", "C"),
    "Rahul-Contractual": ("B", "C"),
    "Ashish": ("A+", "A"),
    "Praveer Kumar Singh": ("A",),
    "Ayush Kumar": ("A",),
    "Dimopoulou": ("A+", "A", "OEM"),
    "Lioumis": ("A+", "A"),
    "Kanarios": ("A+", "A"),
    "Stef Marius": ("B", "C"),
    "Alin Boboc": ("B", "C"),
    "Adrian Bortoc": ("B", "C"),
    "Bianca": ("C",),
}

_UNSCHEDULED = frozenset({"Commercialized", "On Hold", "Cancelled", "Draft"})
UNDER_INDUSTRIALIZATION_AFTER = "H"  # current step: the first non-skipped one after this letter

#: Registration year of a project flagged `Spillover '25`, and of the rest.
CARRY_OVER_REG_YEAR: int = 2025
PLAN_REG_YEAR: int = 2026


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
    #: True for a workbook leader who is not on the roster (ADR 0035).
    provisional: bool = False
    #: Where the row comes from: the roster cell, or "provisional leader".
    source: str = ""


@dataclass
class RosterBuild:
    engineers: list[EngineerSeed]
    #: Roster rows not created because their FTE is below `MIN_FTE`.
    placeholders: list[dict[str, object]] = field(default_factory=list)


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


def canonical_leader(raw: object) -> str | None:
    """The engineer name for a workbook leader value (alias map applied)."""

    if not raw:
        return None
    name = str(raw)
    return LEADER_ALIASES.get(name, name)


def _ordered_categories(categories: set[str]) -> tuple[str, ...]:
    order = [*dc.CATEGORY_ORDER, "OEM"]
    return tuple(c for c in order if c in categories)


def build_roster(data: Mapping[str, object]) -> RosterBuild:
    """The engineers of the seed (module docstring "Engineers")."""

    roster_rows = data["roster"]
    leaders = data["leaders"]
    projects = data["projects"]
    assert isinstance(roster_rows, list) and isinstance(leaders, list)
    assert isinstance(projects, list)

    out = RosterBuild(engineers=[])
    names: set[str] = set()
    for row in roster_rows:
        name, hub, fte = str(row["name"]), str(row["hub"]), float(row["fte"])
        if fte < MIN_FTE:
            out.placeholders.append(dict(row))
            continue
        if name not in CLIENT_APP_ALLOWED_CATEGORIES:
            raise ValueError(f"roster engineer {name!r} has no allowed categories")
        if name in names:
            raise ValueError(f"roster engineer {name!r} appears twice")
        names.add(name)
        out.engineers.append(
            EngineerSeed(
                name,
                hub,
                fte,
                CLIENT_APP_ALLOWED_CATEGORIES[name],
                provisional=False,
                source=f"RPD Capacity!{row['cell']}",
            )
        )

    for leader in leaders:
        leader_name = canonical_leader(leader["name"])
        if leader_name is None or leader_name in names:
            continue
        led = {
            str(p["category"]) for p in projects if canonical_leader(p.get("leader")) == leader_name
        }
        names.add(leader_name)
        out.engineers.append(
            EngineerSeed(
                leader_name,
                str(leader["hub"]),
                PROVISIONAL_LEADER_FTE,
                _ordered_categories(led),
                provisional=True,
                source="provisional leader (not on the RPD Capacity roster)",
            )
        )
    return out


def project_leaders(
    projects: Sequence[Mapping[str, object]], engineers: Sequence[EngineerSeed]
) -> list[str | None]:
    """Each project's leader name (the workbook leader via the alias map), or
    None when the workbook leaves it blank. Never reassigned."""

    known = {e.name for e in engineers}
    out: list[str | None] = []
    for p in projects:
        name = canonical_leader(p.get("leader"))
        if name is not None and name not in known:
            raise ValueError(f"leader {name!r} is not an engineer of the seed")
        out.append(name)
    return out


def carry_over_and_reg_year(project: Mapping[str, object]) -> tuple[bool, int]:
    """(carry_over, reg_year) for a project (module docstring, ADR 0035)."""

    if project.get("spillover_2025"):
        return True, CARRY_OVER_REG_YEAR
    return False, PLAN_REG_YEAR


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


_INITIAL_RUBRIC = initial_rubric()


def band_for(dims: Sequence[int]) -> tuple[float, int, str]:
    """(weighted_score, normalised_pct, band) of positional `dims` under the
    INITIAL rubric (ADR 0029 weights, ADR 0037 `seed.initial_scoring_rubric`),
    through the one scoring implementation (`services.priority_scoring`)."""

    result = compute_score(_INITIAL_RUBRIC, dict(zip(INITIAL_KEYS, dims, strict=True)))
    assert result.weighted_score is not None and result.normalized_pct is not None
    assert result.band is not None
    return float(result.weighted_score), result.normalized_pct, result.band


def derive_dims(code: str, priority: str, marketing_priority: int | None) -> list[int]:
    """13 dimension scores whose band equals `priority` (module docstring)."""

    n = len(INITIAL_KEYS)
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

    def take(self, kind: str, step_id: str, leader: str | None, region: str) -> bool:
        if kind == "design":
            if leader is None:
                return True  # no leader: the run books nothing for this project
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
    leader: str | None,
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
