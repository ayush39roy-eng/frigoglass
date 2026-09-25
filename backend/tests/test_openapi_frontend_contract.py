"""P3-T07 (qa-inspector): contract tests confirming the real FastAPI OpenAPI
schema matches the hand-authored `// PLACEHOLDER` frontend TS types that every
P4 surface (Dashboard/Capacity/Matrix/Gantt) built against, per
`docs/IMPLEMENTATION_PLAN.md` P3-T07.

`frontend/`'s `api/types.ts` files were hand-authored by guessing at the
backend's Pydantic response shapes, because P3-T07 (this task) did not exist
yet when P4-T02..T05 were built (see each surface's own docs/MEMORY.md entry).
Since there is no generated OpenAPI TS client in this repo (see
`frontend/src/types/README.md`), this module is the mechanical check that
those hand-authored shapes have not drifted from the real schema.

Method: `api.main.app.openapi()` is generated fully in-process (FastAPI's
schema builder introspects the registered Pydantic models; it does not touch
the database, Redis, or any network resource), so this needs no
testcontainers fixture at all — it runs as a fast, DB-free unit test. Each
frontend `api/types.ts` file is parsed with a small brace-matching TS
interface parser (`_extract_ts_interfaces`, tested directly below) to get its
declared field set, `extends` included. For every (backend schema, frontend
interface) pair this task has identified as a full mirror, the two field-name
sets (and required-ness) must match EXACTLY — extra or missing fields on
either side fail the test with the concrete diff. A short explicit allowlist
covers the few interfaces that are DELIBERATE partial mirrors (documented in
their own frontend docstring, e.g. `FreezeToggleResponse` is a
`ProjectRead` subset "only the fields the surface reads are typed") — those
are checked as a subset relationship instead of full equality, never skipped
outright.

This test module owns no application code — it is read-only over both
`backend/schemas/*.py` (via the OpenAPI schema, not by re-parsing the source)
and `frontend/src/surfaces/*/api/types.ts` (via the small parser below). It
must never import anything from `backend/scheduling/` and does not touch it.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from api.main import app

FRONTEND_SRC = Path(__file__).resolve().parent.parent.parent / "frontend" / "src"


# --------------------------------------------------------------------------
# A small, purpose-built TS interface parser. Good enough for this repo's
# hand-authored `api/types.ts` files (no nested-brace field types like
# `{ foo: { bar: string } }` appear in any of them today; if one ever does,
# this brace-matching approach still finds the correct outer boundary since it
# counts `{`/`}` characters rather than assuming a single-line body).
# --------------------------------------------------------------------------


def _strip_ts_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    src = re.sub(r"//[^\n]*", "", src)
    return src


def _extract_ts_interfaces(path: Path) -> dict[str, dict[str, Any]]:
    """Parse every `export interface Name (extends Parent(, Parent2)*)? { ... }`
    block in a TS file.

    Returns ``{interface_name: {"extends": [...], "fields": {field_name:
    {"optional": bool, "type": str}}}}``. `extends` is NOT resolved here
    (fields from a parent interface are not merged in) — callers that need
    the flattened field set call `_resolve_ts_fields` below.
    """
    raw = path.read_text()
    out: dict[str, dict[str, Any]] = {}
    for m in re.finditer(r"export interface (\w+)(?:\s+extends\s+([\w,\s]+))?\s*\{", raw):
        name = m.group(1)
        extends = [e.strip() for e in (m.group(2) or "").split(",") if e.strip()]
        start = m.end()
        depth = 1
        i = start
        while depth > 0 and i < len(raw):
            if raw[i] == "{":
                depth += 1
            elif raw[i] == "}":
                depth -= 1
            i += 1
        body = _strip_ts_comments(raw[start : i - 1])
        fields: dict[str, dict[str, Any]] = {}
        for stmt in body.split(";"):
            stmt = stmt.strip()
            if not stmt:
                continue
            fm = re.match(r"(\w+)(\?)?\s*:\s*(.+)", stmt, flags=re.DOTALL)
            if not fm:
                continue
            fname, optional, ftype = fm.group(1), bool(fm.group(2)), fm.group(3).strip()
            fields[fname] = {"optional": optional, "type": ftype}
        out[name] = {"extends": extends, "fields": fields}
    return out


def _resolve_ts_fields(
    interfaces: dict[str, dict[str, Any]], name: str
) -> dict[str, dict[str, Any]]:
    """Flatten `extends` chains for `name` within `interfaces` (same file)."""
    info = interfaces[name]
    fields: dict[str, dict[str, Any]] = {}
    for parent in info["extends"]:
        if parent in interfaces:
            fields.update(_resolve_ts_fields(interfaces, parent))
    fields.update(info["fields"])
    return fields


# --------------------------------------------------------------------------
# OpenAPI-side helpers.
# --------------------------------------------------------------------------


def _openapi_schemas() -> dict[str, Any]:
    schema = app.openapi()
    components: dict[str, Any] = schema["components"]
    schemas: dict[str, Any] = components["schemas"]
    return schemas


def _backend_fields(schema_name: str) -> tuple[set[str], set[str]]:
    """Returns (all_property_names, required_property_names) for a component
    schema, resolving a top-level `allOf: [{$ref: ...}]` wrapper if present
    (Pydantic v2 emits that shape for models with a field-level description
    override; none of the schemas checked here currently need it, but this
    keeps the helper robust rather than silently mis-reading such a shape).
    """
    schemas = _openapi_schemas()
    node = schemas[schema_name]
    if "allOf" in node and "properties" not in node:
        # Merge every $ref'd component in the allOf list.
        props: dict[str, Any] = {}
        required: set[str] = set()
        for sub in node["allOf"]:
            ref = sub.get("$ref")
            if ref:
                sub_name = ref.rsplit("/", 1)[-1]
                sub_node = schemas[sub_name]
                props.update(sub_node.get("properties", {}))
                required |= set(sub_node.get("required", []))
        return set(props.keys()), required
    props = node.get("properties", {})
    required = set(node.get("required", []))
    return set(props.keys()), required


# --------------------------------------------------------------------------
# Per-surface (frontend file, mapping) tables.
#
# mode="exact": the TS interface must declare exactly the backend schema's
#   field set, and its required (non-`?`) fields must exactly equal the
#   backend's `required` list.
# mode="subset": the TS interface is a DELIBERATE partial mirror (its own
#   docstring in `api/types.ts` says so) — every TS field must exist on the
#   backend schema with the same required/optional-vs-nullable posture, but
#   the backend schema may have additional fields the TS interface omits.
# --------------------------------------------------------------------------

_DASHBOARD_TS = FRONTEND_SRC / "surfaces" / "dashboard" / "api" / "types.ts"
_CAPACITY_TS = FRONTEND_SRC / "surfaces" / "capacity" / "api" / "types.ts"
_MATRIX_TS = FRONTEND_SRC / "surfaces" / "matrix" / "api" / "types.ts"
_GANTT_TS = FRONTEND_SRC / "surfaces" / "gantt" / "api" / "types.ts"

# (frontend file, ts interface name, backend openapi schema name, mode)
CONTRACT_TABLE: list[tuple[Path, str, str, str]] = [
    # --- Dashboard (backend/schemas/dashboard.py + schedule_run.py) ---
    (_DASHBOARD_TS, "PipelineTotals", "PipelineTotals", "exact"),
    (_DASHBOARD_TS, "StatusOverview", "StatusOverview", "exact"),
    (_DASHBOARD_TS, "HubTypePipelineRow", "HubTypePipelineRow", "exact"),
    (_DASHBOARD_TS, "CompletingWithinYearRow", "CompletingWithinYearRow", "exact"),
    (_DASHBOARD_TS, "CompletingWithinYear", "CompletingWithinYear", "exact"),
    (_DASHBOARD_TS, "ProjectFilterRow", "ProjectFilterRow", "exact"),
    (_DASHBOARD_TS, "ProjectFilterResult", "ProjectFilterResult", "exact"),
    (_DASHBOARD_TS, "ScheduleRunSummary", "ScheduleRunSummary", "exact"),
    # --- Capacity (backend/schemas/capacity.py + schedule_run.py) ---
    (_CAPACITY_TS, "HubCapacityRow", "HubCapacityRow", "exact"),
    (_CAPACITY_TS, "HubCapacitySummary", "HubCapacitySummary", "exact"),
    (_CAPACITY_TS, "ClassBreakdownRow", "ClassBreakdownRow", "exact"),
    (_CAPACITY_TS, "ClassBreakdown", "ClassBreakdown", "exact"),
    # This is the known P3-T09 GDPR-remediation drift this task exists to
    # catch: `EngineerWeekLoad.name` was removed server-side; the frontend
    # type was fixed in this same task to match. `mode="exact"` here is
    # deliberate — this must stay a hard failure if it ever regresses.
    (_CAPACITY_TS, "EngineerWeekLoad", "EngineerWeekLoad", "exact"),
    (_CAPACITY_TS, "ChamberWeekLoad", "ChamberWeekLoad", "exact"),
    (_CAPACITY_TS, "UtilizationMatrix", "UtilizationMatrix", "exact"),
    (_CAPACITY_TS, "ScheduleRunSummary", "ScheduleRunSummary", "exact"),
    # --- Matrix (backend/schemas/priority.py) ---
    (_MATRIX_TS, "PriorityMatrixRow", "PriorityMatrixRow", "exact"),
    (_MATRIX_TS, "PriorityPortfolioSummary", "PriorityPortfolioSummary", "exact"),
    (_MATRIX_TS, "PriorityScoreUpdateRequest", "PriorityScoreUpdateRequest", "exact"),
    (_MATRIX_TS, "PriorityScoreRead", "PriorityScoreRead", "exact"),
    # --- Matrix: Scenario Apply + Versions & History (backend/schemas/scenario.py,
    # P5-T01/P5-T02/P5-T03) ---
    (_MATRIX_TS, "ScenarioPriorityScoreChange", "ScenarioPriorityScoreChange", "exact"),
    (_MATRIX_TS, "ScenarioApplyRequest", "ScenarioApplyRequest", "exact"),
    (_MATRIX_TS, "ScenarioApplyResponse", "ScenarioApplyResponse", "exact"),
    (_MATRIX_TS, "ScenarioApplyRunSummary", "ScenarioApplyRunSummary", "exact"),
    (_MATRIX_TS, "ScenarioApplyRunDetail", "ScenarioApplyRunDetail", "exact"),
    (_MATRIX_TS, "ScenarioApplyChangeDetail", "ScenarioApplyChangeDetail", "exact"),
    # `ScenarioApplyChangeSummary` (backend) is only ever used as the Pydantic
    # base class of `ScenarioApplyChangeDetail` — no route returns it
    # standalone, so FastAPI's OpenAPI generator never emits it as its own
    # `components/schemas` entry (confirmed by inspecting `app.openapi()`
    # directly: `"ScenarioApplyChangeSummary" not in components["schemas"]`,
    # while `ScenarioApplyChangeDetail` — the only schema that actually goes
    # over the wire — does include exactly these 5 fields plus
    # `before_state`/`after_state`). The frontend interface has the identical
    # base-class-only role (only ever `extends`ed by the frontend
    # `ScenarioApplyChangeDetail`, never constructed standalone either — see
    # `frontend/src/surfaces/matrix/api/types.ts`). Checked as a `"subset"` of
    # `ScenarioApplyChangeDetail`, the actual wire schema that contains it,
    # exactly like `GanttActiveRun` -> `ScheduleRunSummary` below.
    (_MATRIX_TS, "ScenarioApplyChangeSummary", "ScenarioApplyChangeDetail", "subset"),
    # --- Gantt (backend/schemas/gantt.py) ---
    (_GANTT_TS, "GanttStepRow", "GanttStepRow", "exact"),
    (_GANTT_TS, "GanttProjectRow", "GanttProjectRow", "exact"),
    (_GANTT_TS, "GanttResponse", "GanttResponse", "exact"),
    (_GANTT_TS, "FreezeToggleRequest", "FreezeToggleRequest", "exact"),
    # Deliberate partial mirrors — see each interface's own docstring in
    # `frontend/src/surfaces/gantt/api/types.ts`.
    (_GANTT_TS, "FreezeToggleResponse", "ProjectRead", "subset"),
    (_GANTT_TS, "GanttActiveRun", "ScheduleRunSummary", "subset"),
]


@pytest.fixture(scope="module")
def openapi_schemas() -> dict[str, Any]:
    return _openapi_schemas()


@pytest.fixture(scope="module")
def ts_interfaces_by_file() -> dict[Path, dict[str, dict[str, Any]]]:
    files = {row[0] for row in CONTRACT_TABLE}
    return {f: _extract_ts_interfaces(f) for f in files}


class TestTsParserSelfTest:
    """The parser is load-bearing for every other test in this module — prove
    it actually extracts what it claims to on a real file before trusting it.
    """

    def test_parses_capacity_engineer_week_load_with_no_name_field(self) -> None:
        interfaces = _extract_ts_interfaces(_CAPACITY_TS)
        fields = _resolve_ts_fields(interfaces, "EngineerWeekLoad")
        assert set(fields.keys()) == {"engineer_id", "hub", "busy_weeks"}
        assert "name" not in fields

    def test_resolves_extends_chain(self) -> None:
        interfaces = _extract_ts_interfaces(_MATRIX_TS)
        fields = _resolve_ts_fields(interfaces, "PriorityScoreRead")
        # Own fields.
        assert "id" in fields
        assert "weighted_score" in fields
        # Inherited from `extends PriorityScoreUpdateRequest`.
        assert "strategic_project" in fields
        assert "hard_gates" in fields

    def test_optional_marker_detected(self) -> None:
        interfaces = _extract_ts_interfaces(_GANTT_TS)
        fields = _resolve_ts_fields(interfaces, "FreezeToggleRequest")
        assert fields["actual_start_week"]["optional"] is True
        assert fields["frozen"]["optional"] is False


class TestOpenApiFrontendContract:
    @pytest.mark.parametrize(
        "ts_file,ts_interface,backend_schema,mode",
        CONTRACT_TABLE,
        ids=[f"{row[2]}::{row[1]}" for row in CONTRACT_TABLE],
    )
    def test_field_sets_match(
        self,
        ts_file: Path,
        ts_interface: str,
        backend_schema: str,
        mode: str,
        openapi_schemas: dict[str, Any],
        ts_interfaces_by_file: dict[Path, dict[str, dict[str, Any]]],
    ) -> None:
        assert backend_schema in openapi_schemas, (
            f"OpenAPI schema has no component named {backend_schema!r} — "
            f"has the backend model been renamed or removed?"
        )
        backend_props, backend_required = _backend_fields(backend_schema)

        interfaces = ts_interfaces_by_file[ts_file]
        assert ts_interface in interfaces, (
            f"{ts_file} no longer declares `export interface {ts_interface}`"
        )
        ts_fields = _resolve_ts_fields(interfaces, ts_interface)
        ts_names = set(ts_fields.keys())
        ts_required = {n for n, f in ts_fields.items() if not f["optional"]}

        if mode == "exact":
            extra_in_frontend = ts_names - backend_props
            missing_in_frontend = backend_props - ts_names
            assert not extra_in_frontend and not missing_in_frontend, (
                f"{ts_file.relative_to(FRONTEND_SRC.parent.parent)} "
                f"`{ts_interface}` drifted from backend `{backend_schema}`: "
                f"fields only in frontend TS: {sorted(extra_in_frontend)}; "
                f"fields only in backend OpenAPI schema: "
                f"{sorted(missing_in_frontend)}"
            )
            # Required-ness: the direction that actually risks a runtime bug
            # is the backend requiring a field the frontend TS type marks
            # optional (`?`) — that shape lets frontend code compile while
            # treating a value that can be `undefined` as always-present.
            # The opposite direction (TS marks a field required that the
            # backend declares optional, e.g. because it has a Pydantic
            # `Field(default=...)`) is not a bug: a request body the
            # frontend always populates fully is a stricter, not incorrect,
            # TS contract; a response field the backend always happens to
            # populate today is likewise not unsafe to treat as required. So
            # only the backend-requires-but-TS-optional direction fails here.
            required_mismatch_frontend_optional = backend_required - ts_required
            assert not required_mismatch_frontend_optional, (
                f"{ts_interface}: backend requires "
                f"{sorted(required_mismatch_frontend_optional)} but the TS "
                f"interface marks them optional (`?`)"
            )
        elif mode == "subset":
            extra_in_frontend = ts_names - backend_props
            assert not extra_in_frontend, (
                f"{ts_file} `{ts_interface}` (declared as a deliberate "
                f"subset of `{backend_schema}`) declares field(s) the "
                f"backend schema does not have at all: "
                f"{sorted(extra_in_frontend)}"
            )
        else:  # pragma: no cover - guards against a typo in CONTRACT_TABLE
            raise AssertionError(f"unknown contract mode {mode!r}")

    def test_every_p4_surface_types_file_is_covered(
        self, ts_interfaces_by_file: dict[Path, dict[str, dict[str, Any]]]
    ) -> None:
        """Every interface declared in each surface's `api/types.ts` is
        either checked above against a backend schema, or is explicitly
        acknowledged here as frontend-only (no backend counterpart to
        compare against). This stops a *new* hand-authored interface from
        silently going unchecked by this contract test in the future.
        """
        checked_by_file: dict[Path, set[str]] = {}
        for ts_file, ts_interface, _, _ in CONTRACT_TABLE:
            checked_by_file.setdefault(ts_file, set()).add(ts_interface)

        # Interfaces with no backend Pydantic-model counterpart at all —
        # pure frontend view/derived types, or request-query-param shapes
        # FastAPI takes as individual function args rather than a component
        # schema. Adding a new interface to a surface's `api/types.ts`
        # requires either adding it to CONTRACT_TABLE above or to this
        # allowlist with a one-line reason.
        frontend_only = {
            _DASHBOARD_TS: {"ProjectFilterParams"},
            _MATRIX_TS: {"DimensionMeta"},
        }

        for ts_file, interfaces in ts_interfaces_by_file.items():
            expected_covered = checked_by_file.get(ts_file, set())
            expected_frontend_only = frontend_only.get(ts_file, set())
            all_declared = set(interfaces.keys())
            unaccounted = all_declared - expected_covered - expected_frontend_only
            assert not unaccounted, (
                f"{ts_file} declares interface(s) {sorted(unaccounted)} that "
                f"are neither in CONTRACT_TABLE nor the frontend_only "
                f"allowlist in this test — add one or the other so drift on "
                f"this new type is actually caught."
            )
