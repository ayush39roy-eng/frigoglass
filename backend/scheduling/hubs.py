"""Hub name handling inside the scheduler, tolerant of the OEM-Seitek rename.

ADR 0041 §4 / R14 (2026-10-23): the hub `OEM-Seltek` (the prototype's
spelling) is renamed **`OEM-Seitek`** (every client source writes Seitek).
The database enum rename lands in P30-T02's migration, outside this package,
and stored runs keep the old spelling for ever (I14: a historical
`ScheduleRun` and its input snapshot are byte-stable). So the scheduler must
accept **both** spellings, whatever `domain_constants` says at the time:

- before P30-T02, `domain_constants.HUB_LAB_REGION` has `OEM-Seltek`, and a
  scheduler fixture (or a new caller) may already pass `OEM-Seitek`;
- after P30-T02 it has `OEM-Seitek`, and a replay of an old run's input
  snapshot still passes `OEM-Seltek`.

`HUB_LAB_REGION` / `OEM_HUBS` here are `domain_constants`' tables with the
missing spelling of each renamed hub added, carrying the same lab region and
the same OEM flag. Nothing is rewritten: a project's `hub` string is never
changed by the scheduler, so an old snapshot replays byte-identically.
Outputs keyed by hub (the I6 per-hub aggregate) use the caller's spelling.
`canonical_hub_name` maps the old spelling to the new one for callers that
want to compare hubs across the rename.

Pure, no I/O. Every table is built once at import from constants.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

import domain_constants as dc

#: ADR 0041 §4: old spelling -> new spelling.
HUB_RENAMES: Final[Mapping[str, str]] = MappingProxyType({"OEM-Seltek": "OEM-Seitek"})


def _with_both_spellings(table: Mapping[str, str]) -> Mapping[str, str]:
    out = dict(table)
    for old, new in sorted(HUB_RENAMES.items()):
        if old in out and new not in out:
            out[new] = out[old]
        elif new in out and old not in out:
            out[old] = out[new]
    return MappingProxyType(dict(sorted(out.items())))


def _oem_with_both_spellings(hubs: frozenset[str]) -> frozenset[str]:
    out = set(hubs)
    for old, new in sorted(HUB_RENAMES.items()):
        if old in out or new in out:
            out.update((old, new))
    return frozenset(out)


#: Hub -> lab region, accepting both spellings of a renamed hub.
HUB_LAB_REGION: Final[Mapping[str, str]] = _with_both_spellings(dc.HUB_LAB_REGION)

#: The OEM-workflow hubs, accepting both spellings of a renamed hub.
OEM_HUBS: Final[frozenset[str]] = _oem_with_both_spellings(frozenset(dc.OEM_HUBS))


def canonical_hub_name(hub: str) -> str:
    """The current spelling of `hub` (`OEM-Seltek` -> `OEM-Seitek`); any other
    name is returned unchanged."""

    return HUB_RENAMES.get(hub, hub)


def constants_hub_name(hub: str) -> str:
    """The spelling `domain_constants` uses today for `hub` (either spelling
    of a renamed hub maps to whichever one `dc.HUB_LAB_REGION` carries; any
    other name is returned unchanged). For tables keyed by the canonical hub
    list, e.g. the what-if planner's per-hub calendar lookup."""

    if hub in dc.HUB_LAB_REGION:
        return hub
    for old, new in sorted(HUB_RENAMES.items()):
        if hub in (old, new):
            other = new if hub == old else old
            if other in dc.HUB_LAB_REGION:
                return other
    return hub


def is_known_hub(hub: str) -> bool:
    return hub in HUB_LAB_REGION


def is_oem_hub(hub: str) -> bool:
    return hub in OEM_HUBS
