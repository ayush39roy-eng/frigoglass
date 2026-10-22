"""Shared fixtures for the informal `_selftest*` scripts and the pytest suite.

Not product code (matched by the `scheduling/_selftest*.py` coverage omit).
Two things live here so every self-test agrees on them:

1. `TEMPLATE` / `LEAD_TIMES`: the minimal two-step PDD workflow (one design
   step `PDD-A` of 2 weeks, one lab step `PDD-F` of 3 weeks, strict chain)
   that the P2 hand-traced scenarios were written against. Under ADR 0007
   durations come from a lead-time table, so the 2/3-week arithmetic those
   scenarios rely on is expressed as a tiny table covering every category
   (identical for all four PDD categories, so category never changes the
   arithmetic of a scenario that is not about categories).
2. `load_seed_schedule_input()`: the real 46-project seed dataset
   (`backend/seed/prototype_seed_data.json`) mapped onto the 2026-09-27
   contract — OEM-hub projects get `workflow_id="OEM"` and an `X-OEM`
   category; chamber `stages` letters map to the PDD step and, for the two
   lab steps, to the OEM step with the same code (`F` -> `PDD-F`/`OEM-E`,
   `H` -> `PDD-H`/`OEM-H`); `weeks_per_chamber` is dropped (ADR 0008). This
   JSON read happens only from script / test entry points, never inside a
   solver.
"""

from __future__ import annotations

import json
from pathlib import Path

from scheduling.types import (
    PDD_CATEGORIES,
    ChamberInput,
    EngineerInput,
    LeadTime,
    ProjectInput,
    ScheduleInput,
    WorkflowStepTemplate,
)

TEMPLATE: tuple[WorkflowStepTemplate, ...] = (
    WorkflowStepTemplate("PDD", "PDD-A", "MKTG_BRF", "Marketing Brief", "design", 1, ()),
    WorkflowStepTemplate("PDD", "PDD-F", "POC", "Proof of Concept", "lab", 2, ("PDD-A",)),
)

LEAD_TIMES: tuple[LeadTime, ...] = tuple(
    LeadTime("PDD", cat, step_id, weeks)
    for cat in PDD_CATEGORIES
    for step_id, weeks in (("PDD-A", 2), ("PDD-F", 3))
)

_STAGE_LETTER_TO_STEP_IDS: dict[str, tuple[str, ...]] = {
    "F": ("PDD-F", "OEM-E"),
    "H": ("PDD-H", "OEM-H"),
    "J": ("PDD-J",),
    "L": ("PDD-L",),
}

#: ADR 0041 §4 / R14: the client's spelling is `OEM-Seitek`. The prototype seed
#: JSON (`backend/seed/prototype_seed_data.json`, read by the backend's demo
#: seed too, which writes the hub enum) still says `OEM-Seltek` until the
#: P30-T02 enum rename; this loader maps it to the new spelling, so the
#: scheduler fixtures already use it (`scheduling.hubs` accepts both).
_OEM_HUBS = frozenset({"OEM-HCK", "OEM-Seitek"})
_HUB_SPELLING = {"OEM-Seltek": "OEM-Seitek"}
#: ADR 0042: both OEM hubs' capacity hub.
OEM_CAPACITY_HUB = "R&D-Greece"


def seed_path() -> Path:
    return Path(__file__).resolve().parent.parent / "seed" / "prototype_seed_data.json"


def load_seed_schedule_input() -> ScheduleInput:
    seed = json.loads(seed_path().read_text())

    engineers = tuple(
        EngineerInput(
            engineer_id=e["name"],
            name=e["name"],
            hub=e["hub"],
            allowed_categories=tuple(e["cats"]),
            fte=e["fte"],
        )
        for e in seed["engineers"]
    )
    chambers = tuple(
        ChamberInput(
            chamber_id=c["id"],
            code=c["id"],
            lab_region=c["labHub"],
            max_concurrent=c["max"],
            allowed_stages=tuple(
                sid for letter in c["stages"] for sid in _STAGE_LETTER_TO_STEP_IDS.get(letter, ())
            ),
            efficiency=c["eff"],
        )
        for c in seed["chambers"]
    )
    projects = []
    for p in seed["projects"]:
        hub = _HUB_SPELLING.get(p["hub"], p["hub"])
        is_oem = hub in _OEM_HUBS
        cat = p["cat"]
        if is_oem:
            cat = {"A+": "A-OEM", "A": "A-OEM", "B": "B-OEM", "C": "C-OEM"}[cat]
        projects.append(
            ProjectInput(
                project_id=p["id"],
                name=p["name"],
                hub=hub,
                status=p["status"],
                category=cat,
                priority=p["prio"],
                frozen=p["frozen"],
                leader_engineer_id=p["leader"],
                actual_start_week=p["actualStart"] if p["frozen"] else None,
                delay_weeks=p["delay"],
                workflow_id="OEM" if is_oem else "PDD",
                # ADR 0042 (P29): the OEM hubs are capacity children of
                # R&D-Greece. The prototype's OEM leaders (PD-India / Romania
                # engineers) are kept as they are: the scheduler books the
                # assigned leader, so the output is byte-identical either way.
                capacity_hub=OEM_CAPACITY_HUB if is_oem else hub,
            )
        )
    return ScheduleInput(projects=tuple(projects), engineers=engineers, chambers=chambers)
