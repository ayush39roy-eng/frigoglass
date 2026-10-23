"""P31-T01: multi-select `category` / `type` filters (docs/API_CONTRACT_P31.md).

Contract, on every endpoint that filters by category or type:
- `category` and `type` are repeatable; OR within a param, AND across params;
- absent / empty = no filter; one value = the pre-P31 behaviour;
- the Dashboard (register, aggregates, facets, VIP) also accepts `Unmapped`
  (IS NULL) for both params;
- unknown values are 422; hub / RBAC scoping still applies and never widens.

Expectations come from the projects table (Python loops), not from the
endpoint code. Aggregates are checked by reconciliation: every count served
under a partition of the selection sums to the count served for the whole
(I9 / I23), and counts inside one response stay consistent.

Seed: the prototype demo seed with the real greedy run (as
`test_p13_region_filter.py`), then every third project's type nulled and two
projects' category nulled so `Unmapped` has members.
"""

from __future__ import annotations

import csv
import io
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from models.enums import ProjectCategory, ProjectType, RoleName
from models.project import Project
from services.category_type_filter import (
    any_of,
    as_list,
    category_type_filter,
    stored_filter,
)
from services.export_builder import build_export_sheets
from tests.auth_helpers import make_principal
from tests.test_p13_region_filter import (
    _act_as,
    _cleanup,  # noqa: F401  (autouse fixture)
    _client,
    _seeded,
)

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


async def _get(client: AsyncClient, path: str, **params: Any) -> Any:
    """GET with list-valued params sent as repeated keys (`?type=a&type=b`)."""

    resp = await client.get(path, params=_params(params))
    assert resp.status_code == 200, (path, params, resp.text)
    return resp.json()


def _csv_rows(resp: Any) -> list[dict[str, str]]:
    """A CSV export's rows (the file is UTF-8 with a BOM)."""

    return list(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))))


def _params(params: dict[str, Any]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for key, value in params.items():
        for v in value if isinstance(value, (list, tuple)) else [value]:
            out.append((key, v.value if hasattr(v, "value") else str(v)))
    return out


async def _world(db_session) -> SimpleNamespace:
    seeded = await _seeded(db_session)
    projects = list((await db_session.execute(select(Project).order_by(Project.id))).scalars())
    for i, p in enumerate(projects):
        if i % 3 == 0:
            p.type = None
    # Two projects with no category, so a category `Unmapped` slice exists.
    for p in projects[1:3]:
        p.category = None
    await db_session.flush()
    attrs = {str(p.id): p for p in projects}
    cats = sorted({p.category for p in projects if p.category is not None}, key=_order)
    types = sorted({p.type for p in projects if p.type is not None}, key=_order)
    assert len(cats) >= 2 and len(types) >= 2, "demo seed must have variety"
    return SimpleNamespace(hubs=seeded.hubs, projects=projects, attrs=attrs, cats=cats, types=types)


def _order(e: Any) -> int:
    return list(type(e)).index(e)


def _match(p: Project, cats: list[Any], types: list[Any]) -> bool:
    def ok(value: Any, wanted: list[Any]) -> bool:
        if not wanted:
            return True
        return (value is None and "Unmapped" in wanted) or (value is not None and value in wanted)

    return ok(p.category, cats) and ok(p.type, types)


#: Row-set endpoints: path -> (extra params, ids extractor). Each returns the
#: set of project ids the endpoint serves.
def _ids_dashboard(body: Any) -> set[str]:
    assert body["total_count"] == len(body["rows"])
    return {r["project_id"] for r in body["rows"]}


def _ids_gantt(body: Any) -> set[str]:
    assert body["total_count"] == len(body["rows"])
    return {r["project_id"] for r in body["rows"]}


def _ids_list(body: Any) -> set[str]:
    return {r.get("project_id") or r["id"] for r in body}


def _ids_board(body: Any) -> set[str]:
    ids = set()
    for column in body["columns"]:
        assert column["count"] == len(column["cards"])
        ids |= {c["project_id"] for c in column["cards"]}
    return ids


ROW_ENDPOINTS: dict[str, tuple[dict[str, Any], Any]] = {
    "/dashboard/projects": ({}, _ids_dashboard),
    "/projects": ({"limit": 500}, _ids_list),
    "/gantt": ({"limit": 500}, _ids_gantt),
    "/priorities": ({}, _ids_list),
    "/priority-board": ({}, _ids_board),
}

#: Additive Dashboard aggregates (every integer they serve is a count over the
#: filtered project set). VIP is a per-hub top-N, so it is not additive.
AGGREGATES = (
    "/dashboard/pipeline-totals",
    "/dashboard/status-overview",
    "/dashboard/completing-within-year",
    "/dashboard/hub-type-pipeline",
    "/dashboard/analytics",
    "/dashboard/region-summary",
    "/priorities/distribution",
)

_SKIP_KEYS = {
    "schedule_run_version",
    "last_step_end_week",
    "week_range",
    "limit",
    "bucket_from",
    "bucket_to",
}
_ID_FIELDS = ("key", "hub", "type", "priority", "region", "band", "bucket_from")


def _flat(obj: Any, prefix: str = "") -> dict[str, int]:
    """Every integer count in a response, keyed by its path. List elements are
    keyed by their identifying fields, so partitions line up."""

    out: dict[str, int] = {}
    if isinstance(obj, bool) or obj is None or isinstance(obj, (float, str)):
        return out
    if isinstance(obj, int):
        return {prefix: obj}
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in _SKIP_KEYS:
                continue
            if k == "rows" and isinstance(v, list) and v and "project_id" in v[0]:
                out[f"{prefix}.rows#"] = len(v)
                continue
            out.update(_flat(v, f"{prefix}.{k}"))
        return out
    if isinstance(obj, list):
        for i, item in enumerate(obj):
            if isinstance(item, dict):
                ident = "|".join(f"{f}={item[f]}" for f in _ID_FIELDS if f in item) or str(i)
            else:
                ident = str(i)
            out.update(_flat(item, f"{prefix}[{ident}]"))
    return out


def _nonzero(counts: dict[str, int]) -> dict[str, int]:
    return {k: v for k, v in counts.items() if v}


def _sum(parts: list[dict[str, int]]) -> dict[str, int]:
    total: dict[str, int] = {}
    for part in parts:
        for k, v in part.items():
            total[k] = total.get(k, 0) + v
    return _nonzero(total)


# --------------------------------------------------------------------------
# Predicate unit tests (no DB)
# --------------------------------------------------------------------------


def _sql(clause: Any) -> str:
    return str(clause.compile(dialect=postgresql.dialect()))


def test_predicate_shapes_are_bound_and_single_value_is_equality():
    assert any_of(Project.type, None) is None
    assert any_of(Project.type, []) is None
    # One value: exactly the pre-P31 `column = :param` predicate.
    single = _sql(any_of(Project.type, [ProjectType.NM]))
    assert single == _sql(Project.type == ProjectType.NM)
    # Duplicates collapse to the single-value predicate.
    assert _sql(any_of(Project.type, [ProjectType.NM, ProjectType.NM])) == single
    two = _sql(any_of(Project.type, [ProjectType.NM, ProjectType.CO]))
    # Bound, not inlined: no quoted literal in the SQL text.
    assert " IN " in two and "'NM'" not in two and "'CO'" not in two
    assert _sql(any_of(Project.type, ["Unmapped"])) == "projects.type IS NULL"
    mixed = _sql(any_of(Project.type, [ProjectType.NM, "Unmapped"]))
    assert "projects.type = " in mixed and "IS NULL" in mixed and " OR " in mixed
    both = _sql(category_type_filter([ProjectCategory.A], [ProjectType.NM]))
    assert " AND " in both
    assert category_type_filter(None, []) is None


def test_stored_filter_round_trip_keeps_the_pre_p31_shape():
    assert stored_filter(None) is None
    assert stored_filter([]) is None
    assert stored_filter([ProjectCategory.A]) == "A"  # pre-P31 bare string
    assert stored_filter([ProjectCategory.A, ProjectCategory.A]) == "A"
    assert stored_filter([ProjectType.NM, "Unmapped"]) == ["NM", "Unmapped"]
    assert as_list(None) == [] and as_list("") == []
    assert as_list("A") == ["A"] and as_list(["A", "B"]) == ["A", "B"]


# --------------------------------------------------------------------------
# Row endpoints: OR, AND, empty, single, Unmapped, scope
# --------------------------------------------------------------------------


async def test_row_endpoints_or_and_empty_single(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    c1, c2 = w.cats[0], w.cats[1]
    t1, t2 = w.types[0], w.types[1]
    async with _client(db_session) as client:
        for path, (extra, ids_of) in ROW_ENDPOINTS.items():

            async def ids(_p=path, _e=extra, _f=ids_of, **params: Any) -> set[str]:
                return _f(await _get(client, _p, **_e, **params))

            everything = await ids()
            assert everything, path
            # Empty = no filter.
            assert await ids(category=[], type=[]) == everything, path
            # Single value = the old `=` semantics, from the table.
            for cat in (c1, c2):
                expected = {i for i in everything if w.attrs[i].category == cat}
                assert await ids(category=cat) == expected, (path, cat)
                # Repeating the same value changes nothing.
                assert await ids(category=[cat, cat]) == expected, (path, cat)
            for t in (t1, t2):
                expected = {i for i in everything if w.attrs[i].type == t}
                assert await ids(type=t) == expected, (path, t)
            # OR within a param.
            a, b = await ids(category=c1), await ids(category=c2)
            assert await ids(category=[c1, c2]) == a | b, path
            assert not a & b
            ta, tb = await ids(type=t1), await ids(type=t2)
            assert await ids(type=[t1, t2]) == ta | tb, path
            # AND across params, both multi-valued.
            got = await ids(category=[c1, c2], type=[t1, t2])
            assert got == (a | b) & (ta | tb), path
            assert got == {i for i in everything if _match(w.attrs[i], [c1, c2], [t1, t2])}, path


async def test_register_unmapped_combines_with_real_values(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    t1 = w.types[0]
    async with _client(db_session) as client:
        everything = _ids_dashboard(await _get(client, "/dashboard/projects"))
        for path in ("/dashboard/projects",):
            body = await _get(client, path, type=["Unmapped", t1])
            expected = {str(p.id) for p in w.projects if p.type is None or p.type == t1}
            assert _ids_dashboard(body) == expected
            # Category Unmapped (Dashboard only), ANDed with a type selection.
            body = await _get(client, path, category="Unmapped", type=["Unmapped", t1])
            expected = {
                str(p.id)
                for p in w.projects
                if p.category is None and (p.type is None or p.type == t1)
            }
            assert _ids_dashboard(body) == expected
        # Unmapped + every type partitions the register.
        assert (
            _ids_dashboard(
                await _get(client, "/dashboard/projects", type=["Unmapped", *ProjectType])
            )
            == everything
        )
        # Dashboard export follows the same selection, row for row.
        export = await client.get(
            "/exports/dashboard", params=_params({"type": ["Unmapped", t1], "format": "csv"})
        )
        assert export.status_code == 200
        exported = {r["project_id"] for r in _csv_rows(export)}
        assert exported == {str(p.id) for p in w.projects if p.type is None or p.type == t1}


@pytest.mark.parametrize(
    "path",
    [
        "/dashboard/projects",
        "/dashboard/projects/facets",
        "/dashboard/pipeline-totals",
        "/dashboard/status-overview",
        "/dashboard/completing-within-year",
        "/dashboard/hub-type-pipeline",
        "/dashboard/analytics",
        "/dashboard/region-summary",
        "/vip-projects",
        "/projects",
        "/gantt",
        "/priorities",
        "/priorities/distribution",
        "/priority-board",
        "/exports/dashboard",
        "/exports/matrix",
        "/exports/gantt",
        "/exports/project-registration",
    ],
)
@pytest.mark.parametrize(
    "params",
    [
        {"category": "Z"},
        {"category": ["A", "Z"]},
        {"type": "XX"},
        {"type": ["NM", "XX"]},
        {"type": "unmapped"},
        {"type": ""},
    ],
)
async def test_unknown_values_are_422(db_session, path, params):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.get(path, params=_params(params))
    assert resp.status_code == 422, (path, params, resp.text)


@pytest.mark.parametrize(
    "path",
    [
        "/projects",
        "/gantt",
        "/priorities",
        "/priorities/distribution",
        "/priority-board",
        "/exports/matrix",
        "/exports/gantt",
        "/exports/project-registration",
    ],
)
async def test_unmapped_is_dashboard_only(db_session, path):
    """The contract admits `Unmapped` on the Dashboard only; elsewhere it is
    an unknown value (422), as before P31."""

    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.get(path, params={"type": "Unmapped"})
    assert resp.status_code == 422, (path, resp.text)


async def test_projects_accepts_the_legacy_type_underscore_name(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    t1, t2 = w.types[0], w.types[1]
    async with _client(db_session) as client:
        new = _ids_list(await _get(client, "/projects", limit=500, type=t1))
        old = _ids_list(await _get(client, "/projects", limit=500, type_=t1))
        both = _ids_list(await _get(client, "/projects", limit=500, type=t1, type_=t2))
        two = _ids_list(await _get(client, "/projects", limit=500, type=[t1, t2]))
        export = await client.get(
            "/exports/project-registration",
            params=_params({"type": t1, "type_": t2, "format": "csv"}),
        )
    assert new == old == {str(p.id) for p in w.projects if p.type == t1}
    assert both == two
    assert export.status_code == 200
    assert {r["id"] for r in _csv_rows(export)} == two


async def test_hub_planner_stays_scoped_under_a_selection(db_session):
    w = await _world(db_session)
    hubs = list(w.hubs.values())
    cats, types = w.cats[:2], w.types[:2]
    own = max(
        hubs,
        key=lambda h: sum(1 for p in w.projects if p.hub_id == h.id and _match(p, cats, types)),
    )
    other = next(h for h in hubs if h.id != own.id)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[own.id])
    expected = {str(p.id) for p in w.projects if p.hub_id == own.id and _match(p, cats, types)}
    assert expected
    async with _client(db_session) as client:
        reg = _ids_dashboard(await _get(client, "/dashboard/projects", category=cats, type=types))
        assert reg == expected
        for path in ("/projects", "/gantt", "/priorities", "/priority-board"):
            extra, ids_of = ROW_ENDPOINTS[path]
            got = ids_of(await _get(client, path, **extra, category=cats, type=types))
            assert got <= expected, path
            assert all(w.attrs[i].hub_id == own.id for i in got), path
        vip = await _get(client, "/vip-projects", category=cats, type=types)
        assert all(h["hub_id"] == str(own.id) for h in vip["hubs"])
        # An out-of-scope hub with a selection is empty, never widened.
        empty = await _get(
            client, "/dashboard/projects", category=cats, type=types, hub_id=other.id
        )
        assert empty == {"total_count": 0, "rows": []}
        totals = await _get(
            client, "/dashboard/pipeline-totals", category=cats, type=types, hub_id=other.id
        )
        assert totals["total_count"] == 0
        assert (await _get(client, "/priorities/distribution", category=cats, hub_id=other.id))[
            "total_projects"
        ] == 0


# --------------------------------------------------------------------------
# Dashboard aggregates: reconciliation (I9 / I23)
# --------------------------------------------------------------------------


async def test_aggregates_partition_by_single_values_sum_to_all(db_session):
    """Σ over each single type (plus Unmapped) of every served count equals
    the unfiltered count; same for categories; and category × type cells sum
    to their category."""

    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for path in AGGREGATES:
            dashboard = path.startswith("/dashboard")
            type_values: list[Any] = list(ProjectType)
            cat_values: list[Any] = list(ProjectCategory)
            if dashboard:
                type_values.append("Unmapped")
                cat_values.append("Unmapped")
            whole = _nonzero(_flat(await _get(client, path)))
            assert whole, path

            if dashboard:
                by_type = [_flat(await _get(client, path, type=t)) for t in type_values]
                assert _sum(by_type) == whole, (path, "type partition")
                by_cat = [_flat(await _get(client, path, category=c)) for c in cat_values]
                assert _sum(by_cat) == whole, (path, "category partition")
            else:
                # Non-Dashboard endpoints have no null bucket: the typed and
                # categorized projects only.
                typed = _flat(await _get(client, path, type=list(ProjectType)))
                assert _sum([_flat(await _get(client, path, type=t)) for t in ProjectType]) == (
                    _nonzero(typed)
                ), path

            # OR: two values = the sum of each.
            t1, t2 = w.types[0], w.types[1]
            assert _nonzero(_flat(await _get(client, path, type=[t1, t2]))) == _sum(
                [_flat(await _get(client, path, type=t1)), _flat(await _get(client, path, type=t2))]
            ), (path, "OR")
            # AND: category × type cells sum to the category.
            c1 = w.cats[0]
            cells = [_flat(await _get(client, path, category=c1, type=t)) for t in type_values]
            # (Off the Dashboard there is no `Unmapped`, so the whole is the
            # category's typed projects: `type` = every ProjectType.)
            cat_whole = await _get(
                client, path, category=c1, **({} if dashboard else {"type": list(ProjectType)})
            )
            assert _sum(cells) == _nonzero(_flat(cat_whole)), (path, "AND")
            # Empty lists = no filter.
            assert _nonzero(_flat(await _get(client, path, category=[], type=[]))) == whole


async def test_counts_within_and_across_responses_stay_consistent(db_session):
    """Under a multi-value selection: status cards + remainder == total; the
    register, pipeline totals, region summary and analytics charts all count
    the same set; the analytics completing figure equals the within-year
    count (I9); priority-delivery totals cover the prioritised set."""

    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    selections = [
        {},
        {"type": [w.types[0], w.types[1]]},
        {"category": [w.cats[0], w.cats[1]], "type": ["Unmapped", w.types[0]]},
        {"category": ["Unmapped"]},
    ]
    async with _client(db_session) as client:
        for sel in selections:
            expected = {
                str(p.id)
                for p in w.projects
                if _match(p, sel.get("category", []), sel.get("type", []))
            }
            reg = await _get(client, "/dashboard/projects", **sel)
            assert _ids_dashboard(reg) == expected, sel
            totals = await _get(client, "/dashboard/pipeline-totals", **sel)
            status = await _get(client, "/dashboard/status-overview", **sel)
            region = await _get(client, "/dashboard/region-summary", **sel)
            analytics = await _get(client, "/dashboard/analytics", **sel)
            completing = await _get(client, "/dashboard/completing-within-year", **sel)
            hub_type = await _get(client, "/dashboard/hub-type-pipeline", **sel)
            n = len(expected)
            assert totals["total_count"] == n == status["total_count"] == region["total_count"]
            assert (
                totals["spillover_count"] + totals["new_count"] + totals["unregistered_count"] == n
            )
            assert (
                status["in_development"]
                + status["under_industrialization"]
                + status["in_queue"]
                + status["commercialized_count"]
                + status["on_hold_count"]
                + status["other_statuses_count"]
            ) == n, sel
            assert sum(b["count"] for b in analytics["by_type"]) == n
            assert sum(b["count"] for b in analytics["by_category"]) == n
            assert sum(b["count"] for b in analytics["by_hub"]) == n
            assert sum(r["count"] for r in hub_type) == n
            assert sum(r["total_count"] for r in region["regions"]) == n
            # Completing rows are exactly the selected projects in the run.
            assert {r["project_id"] for r in completing["rows"]} <= expected
            within = sum(1 for r in completing["rows"] if r["within_year"] and not r["blocked"])
            assert completing["within_year_count"] == within
            assert (
                completing["within_year_count"]
                + completing["spillover_count"]
                + completing["left_out_count"]
                + completing["blocked_count"]
            ) <= len(completing["rows"])
            assert sum(r["completing_count"] for r in analytics["completing_by_type"]) == within
            prioritised = sum(1 for i in expected if w.attrs[i].priority is not None)
            assert sum(b["total"] for b in completing["priority_delivery"]) == prioritised


async def test_facets_and_vip_follow_the_selection(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    sel = {"category": [w.cats[0]], "type": [w.types[0], "Unmapped"]}
    async with _client(db_session) as client:
        reg = await _get(client, "/dashboard/projects", **sel)
        facets = await _get(client, "/dashboard/projects/facets", **sel)
        unfiltered_facets = await _get(client, "/dashboard/projects/facets")
        vip = await _get(client, "/vip-projects", **sel)
        vip_single = await _get(client, "/vip-projects", category=w.cats[0])
    leaders = {r["leader_engineer_id"] for r in reg["rows"] if r["leader_engineer_id"]}
    assert {f["id"] for f in facets["leaders"]} == leaders
    steps = {r["current_step_code"] for r in reg["rows"] if r["current_step_code"]}
    assert {s["code"] for s in facets["steps"]} == steps
    assert len(facets["leaders"]) <= len(unfiltered_facets["leaders"])
    for payload, cats, types in (
        (vip, sel["category"], sel["type"]),
        (vip_single, [w.cats[0]], []),
    ):
        for hub in payload["hubs"]:
            for row in hub["projects"]:
                assert _match(w.attrs[row["project_id"]], cats, types)
    assert any(hub["projects"] for hub in vip_single["hubs"])


# --------------------------------------------------------------------------
# Exports
# --------------------------------------------------------------------------


async def test_exports_carry_the_selection(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    cats, types = w.cats[:2], w.types[:2]
    async with _client(db_session) as client:
        matrix = _ids_list(await _get(client, "/priorities", category=cats, type=types))
        gantt = _ids_gantt(await _get(client, "/gantt", limit=500, category=cats, type=types))
        m_csv = await client.get(
            "/exports/matrix", params=_params({"category": cats, "type": types})
        )
        g_csv = await client.get(
            "/exports/gantt", params=_params({"category": cats, "type": types})
        )
    assert m_csv.status_code == 200 and g_csv.status_code == 200
    assert {r["project_id"] for r in _csv_rows(m_csv)} == matrix
    assert {r["project_id"] for r in _csv_rows(g_csv)} == gantt


async def test_builder_reads_pre_p31_and_p31_job_filters(db_session):
    """An async job persisted before P31 stores a bare string; a P31 job
    stores a list. Both build the same rows as the live endpoint."""

    w = await _world(db_session)
    user = await _act_as(db_session, RoleName.SUPER_ADMIN)
    principal = make_principal(RoleName.SUPER_ADMIN, user_id=user.id, email=user.email)
    c1, c2 = w.cats[0], w.cats[1]
    legacy = await build_export_sheets(
        db_session,
        principal,
        surface="dashboard",
        filters={"hub_id": None, "category": c1.value, "status_": None, "priority": None},
    )
    as_list_one = await build_export_sheets(
        db_session,
        principal,
        surface="dashboard",
        filters={"hub_id": None, "category": [c1.value], "status_": None, "priority": None},
    )
    assert legacy == as_list_one
    two = await build_export_sheets(
        db_session,
        principal,
        surface="project_registration",
        filters={
            "hub_id": None,
            "category": [c1.value, c2.value],
            "status_": None,
            "priority": None,
            "type_": None,
        },
    )
    _, rows = two["Projects"]
    assert {str(r["id"]) for r in rows} == {str(p.id) for p in w.projects if p.category in (c1, c2)}
