"""P21-T01 (docs/API_CONTRACT_P21.md): Prioritization Matrix changes.

- §1 currencies: EGP / ZAR / IDR with no rate (`rate_to_eur: null`,
  `configured: false`), 422 `CURRENCY_NOT_CONFIGURED`, a Super Admin sets a
  rate (audited), other roles are denied, and the migration.
- §2 score 0 (ADR 0033): validation and points, with a hand-worked example.
- §3 `dimension_scores` on matrix rows: order, sums equal `weighted_score`.
- §4 `GET /priorities/distribution`: reconciles with `GET /priorities` under
  filters and hub scope.
- §5 `GET /priorities/compare`: limits, scope, no financial fields.
"""

from __future__ import annotations

import asyncio
import uuid
from decimal import Decimal

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from testcontainers.postgres import PostgresContainer

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.currency import CurrencyRate
from models.enums import (
    CurrencyCode,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    RoleName,
)
from services.priority_scoring import compute_priority_score
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.conftest import run_alembic
from tests.factories import make_hub, make_priority_score, make_project, make_user

_FINANCIAL_KEYS = (
    "capex_keur",
    "rm_savings_keur",
    "tcogs_eur",
    "selling_price_eur",
    "gross_margin_pct",
    "customer_name",
    "currency",
)
_KEYS = [key for _p, _l, key, _w in dc.PRIORITIZATION_DIMENSIONS]

#: Hand-worked example with zeros (ADR 0033). Points = score / 5 * weight:
#: 25 + 0 + 15 + 0 + 5 + 25 + 0 + 10 + 20 + 0 + 25 + 0 + 9 = 134;
#: round(134 / 295 * 100) = round(45.42) = 45 -> P3.
_ZERO_DIMS = [5, 0, 3, 0, 1, 5, 0, 2, 4, 0, 5, 0, 3]
_ZERO_POINTS = [25.0, 0.0, 15.0, 0.0, 5.0, 25.0, 0.0, 10.0, 20.0, 0.0, 25.0, 0.0, 9.0]


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles: RoleName, hub_ids: list[uuid.UUID] | None = None):
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=hub_ids is None)
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=hub_ids is None,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def _seed_rates(db_session) -> None:
    for code, rate in (
        (CurrencyCode.EUR, Decimal("1.0000")),
        (CurrencyCode.USD, Decimal("1.0800")),
        (CurrencyCode.INR, Decimal("97.0000")),
        (CurrencyCode.EGP, None),
        (CurrencyCode.IDR, None),
    ):  # ZAR deliberately has no row at all
        db_session.add(CurrencyRate(currency_code=code, rate_to_eur=rate))
    await db_session.flush()


async def _scored(db_session, hub, name, dims, **overrides):
    project = await make_project(db_session, hub, name=name, **overrides)
    weighted, pct, band = compute_priority_score(dims)
    await make_priority_score(
        db_session,
        project,
        dims=dims,
        weighted_score=weighted,
        normalized_pct=pct,
        suggested_band=ProjectPriority(band),
    )
    return project


# --------------------------------------------------------------------------
# §1 Currencies
# --------------------------------------------------------------------------


async def test_currency_list_serves_name_configured_and_null_rates(db_session):
    await _seed_rates(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[])
    async with _client(db_session) as client:
        resp = await client.get("/currency-rates")
    assert resp.status_code == 200
    by_code = {r["currency_code"]: r for r in resp.json()}
    assert set(by_code) == {"EUR", "USD", "INR", "EGP", "IDR"}
    for row in by_code.values():
        assert set(row) == {
            "id",
            "currency_code",
            "name",
            "rate_to_eur",
            "configured",
            "updated_by_user_id",
            "updated_at",
        }
    assert by_code["EGP"] == {**by_code["EGP"], "rate_to_eur": None, "configured": False}
    assert by_code["EGP"]["name"] == "Egyptian pound"
    assert by_code["IDR"]["name"] == "Indonesian rupiah"
    assert by_code["USD"]["rate_to_eur"] == 1.08 and by_code["USD"]["configured"] is True
    assert by_code["EUR"]["name"] == "Euro"


def test_seed_constants_have_no_invented_rates():
    for code in ("EGP", "ZAR", "IDR"):
        assert dc.CURRENCY_RATE_SEED[code] is None
        assert code in dc.CURRENCY_NAMES
    assert {c.value for c in CurrencyCode} == set(dc.CURRENCY_RATE_SEED)


@pytest.mark.parametrize("code", ["EGP", "ZAR", "IDR"])
async def test_converting_into_unconfigured_currency_is_422(db_session, code):
    await _seed_rates(db_session)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, tcogs_eur=100.0)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        listed = await client.get("/priorities", params={"currency": code})
        single = await client.get(f"/priorities/{project.id}", params={"currency": code})
        export = await client.get("/exports/matrix", params={"currency": code})
    for resp in (listed, single, export):
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "CURRENCY_NOT_CONFIGURED"
        assert "100" not in resp.text  # no financial value leaks into the error


async def test_unknown_export_currency_is_422_not_500(db_session):
    await _seed_rates(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.get("/exports/matrix", params={"currency": "GBP"})
    assert resp.status_code == 422


async def test_super_admin_sets_rate_audited_and_conversion_works(db_session):
    await _seed_rates(db_session)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, tcogs_eur=100.0)
    user = await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        put = await client.put("/currency-rates/EGP", json={"rate_to_eur": 52.5})
        assert put.status_code == 200, put.text
        body = put.json()
        assert body["currency_code"] == "EGP"
        assert body["rate_to_eur"] == 52.5
        assert body["configured"] is True
        assert body["name"] == "Egyptian pound"
        row = await client.get(f"/priorities/{project.id}", params={"currency": "EGP"})
    assert row.status_code == 200
    assert row.json()["tcogs_eur"] == pytest.approx(5250.0)
    assert row.json()["currency"] == "EGP"

    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "currency_rate.update")
        )
    ).scalar_one()
    assert audit.actor_user_id == user.id
    assert audit.before_state == {"currency_code": "EGP", "rate_to_eur": None}
    assert Decimal(audit.after_state["rate_to_eur"]) == Decimal("52.5")


@pytest.mark.parametrize(
    "role",
    [
        RoleName.PORTFOLIO_MANAGER,
        RoleName.HUB_PLANNER,
        RoleName.EXECUTIVE_VIEWER,
        RoleName.AUDITOR,
        RoleName.ENGINEER,
    ],
)
async def test_set_rate_denied_for_non_admin_roles(db_session, role):
    await _seed_rates(db_session)
    await _act_as(db_session, role, hub_ids=[] if role == RoleName.ENGINEER else None)
    async with _client(db_session) as client:
        resp = await client.put("/currency-rates/EGP", json={"rate_to_eur": 52.5})
    assert resp.status_code == 403
    rate = (
        await db_session.execute(
            select(CurrencyRate).where(CurrencyRate.currency_code == CurrencyCode.EGP)
        )
    ).scalar_one()
    assert rate.rate_to_eur is None
    audit = await db_session.execute(
        select(AuditLogEntry).where(AuditLogEntry.action == "currency_rate.update")
    )
    assert audit.scalars().all() == []


@pytest.mark.parametrize("bad", [0, -1, 0.00001, 1_000_000, "NaN", "Infinity"])
async def test_set_rate_rejects_non_positive_out_of_range_or_non_finite(db_session, bad):
    await _seed_rates(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        if isinstance(bad, str):
            resp = await client.put(
                "/currency-rates/EGP",
                content=f'{{"rate_to_eur": {bad}}}',
                headers={"content-type": "application/json"},
            )
        else:
            resp = await client.put("/currency-rates/EGP", json={"rate_to_eur": bad})
    assert resp.status_code == 422


# --------------------------------------------------------------------------
# §2 Score 0 (ADR 0033)
# --------------------------------------------------------------------------


def test_score_zero_points_hand_worked():
    weighted, pct, band = compute_priority_score(_ZERO_DIMS)
    assert weighted == 134.0
    assert pct == 45
    assert band == "P3"
    assert compute_priority_score([0] * 13) == (0.0, 0, "P4")
    assert compute_priority_score([5] * 13) == (295.0, 100, "P1")


def _body(dims):
    return {**dict(zip(_KEYS, dims, strict=True)), "hard_gates": []}


async def test_put_priorities_accepts_zero_and_stores_points(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.put(f"/priorities/{project.id}", json=_body(_ZERO_DIMS))
        assert resp.status_code == 200, resp.text
        assert resp.json()["weighted_score"] == 134.0
        assert resp.json()["normalized_pct"] == 45
        assert resp.json()["suggested_band"] == "P3"
        row = (await client.get(f"/priorities/{project.id}")).json()
    assert [d["score"] for d in row["dimension_scores"]] == _ZERO_DIMS
    assert [d["points"] for d in row["dimension_scores"]] == _ZERO_POINTS

    async with _client(db_session) as client:
        zeros = await client.put(f"/priorities/{project.id}", json=_body([0] * 13))
    assert zeros.status_code == 200
    assert (zeros.json()["weighted_score"], zeros.json()["suggested_band"]) == (0.0, "P4")


@pytest.mark.parametrize("bad", [-1, 6])
async def test_put_priorities_rejects_out_of_range(db_session, bad):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    dims = [3] * 13
    dims[4] = bad
    async with _client(db_session) as client:
        resp = await client.put(f"/priorities/{project.id}", json=_body(dims))
    assert resp.status_code == 422


# --------------------------------------------------------------------------
# §3 dimension_scores
# --------------------------------------------------------------------------


async def test_matrix_rows_dimension_scores_order_sum_and_unscored(db_session):
    await _seed_rates(db_session)
    hub = await make_hub(db_session)
    await _scored(db_session, hub, "Alpha", _ZERO_DIMS)
    await _scored(db_session, hub, "Beta", [4, 3, 2, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4])
    await make_project(db_session, hub, name="Gamma (unscored)")
    await _act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with _client(db_session) as client:
        rows = (await client.get("/priorities")).json()
    assert len(rows) == 3
    for row in rows:
        dims = row["dimension_scores"]
        assert [d["key"] for d in dims] == _KEYS
        assert [d["weight"] for d in dims] == [w for *_r, w in dc.PRIORITIZATION_DIMENSIONS]
        assert [d["max_points"] for d in dims] == [d["weight"] for d in dims]
        assert set(dims[0]) == {"key", "label", "pillar", "score", "weight", "points", "max_points"}
        if row["has_score"]:
            assert sum(d["points"] for d in dims) == pytest.approx(row["weighted_score"])
            assert row["normalized_pct"] == round(row["weighted_score"] / dc.TOTAL_WEIGHT * 100)
        else:
            assert all(d["score"] is None and d["points"] is None for d in dims)
            assert row["weighted_score"] is None and row["suggested_band"] is None
    labels = {d["key"]: (d["label"], d["pillar"]) for d in rows[0]["dimension_scores"]}
    assert labels["profitability"] == ("ROI", "Investment & Feasibility")
    assert labels["gross_margins"] == ("Gross Profitability", "Financial Return")


# --------------------------------------------------------------------------
# §4 Distribution
# --------------------------------------------------------------------------


async def _portfolio(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    await _scored(db_session, hub_a, "A-P1", [5] * 13)  # 100 -> P1
    await _scored(db_session, hub_a, "A-P2", [3] * 13, type=ProjectType.CO)  # 60 -> P2
    await _scored(db_session, hub_a, "A-P4", [0] * 13)  # 0 -> P4
    await _scored(db_session, hub_a, "A-P3", _ZERO_DIMS, category=ProjectCategory.B)  # 45 -> P3
    await make_project(db_session, hub_a, name="A-unscored")
    await _scored(db_session, hub_b, "B-P1", [4] * 13, status=ProjectStatus.IN_DEVELOPMENT)  # 80
    await _scored(db_session, hub_b, "B-P4", [1] * 13)  # 20 -> P4
    await make_project(db_session, hub_b, name="B-unscored", type=ProjectType.CO)
    return hub_a, hub_b


def _assert_reconciles(dist, rows):
    assert dist["total_projects"] == len(rows)
    assert dist["scored_projects"] == sum(1 for r in rows if r["has_score"])
    by_band = {b["band"]: b for b in dist["band_distribution"]}
    assert [b["band"] for b in dist["band_distribution"]] == [
        "P1",
        "P2",
        "P3",
        "P4",
        "Q",
        "Unscored",
    ]
    assert sum(b["count"] for b in dist["band_distribution"]) == len(rows)
    for band in ("P1", "P2", "P3", "P4"):
        assert by_band[band]["count"] == sum(1 for r in rows if r["suggested_band"] == band)
    assert by_band["Unscored"]["count"] == sum(1 for r in rows if not r["has_score"])
    assert by_band["Q"]["count"] == 0
    for b in dist["band_distribution"]:
        expected = round(b["count"] * 100 / len(rows), 2) if rows else 0.0
        assert b["share_pct"] == expected
    hist = dist["score_histogram"]
    assert [(h["bucket_from"], h["bucket_to"]) for h in hist] == [
        (i, i + 10) for i in range(0, 100, 10)
    ]
    assert sum(h["count"] for h in hist) == dist["scored_projects"]
    for h in hist:
        last = h["bucket_to"] == 100
        assert h["count"] == sum(
            1
            for r in rows
            if r["has_score"]
            and h["bucket_from"] <= r["normalized_pct"]
            and (r["normalized_pct"] <= 100 if last else r["normalized_pct"] < h["bucket_to"])
        )


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"type": "CO"},
        {"category": "B"},
        {"status_": "In Development"},
        {"q": "A-"},
    ],
)
async def test_distribution_reconciles_with_matrix_rows(db_session, params):
    await _portfolio(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        rows = (await client.get("/priorities", params=params)).json()
        resp = await client.get("/priorities/distribution", params=params)
    assert resp.status_code == 200, resp.text
    _assert_reconciles(resp.json(), rows)


async def test_distribution_unfiltered_numbers(db_session):
    await _portfolio(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        dist = (await client.get("/priorities/distribution")).json()
    counts = {b["band"]: (b["count"], b["share_pct"]) for b in dist["band_distribution"]}
    assert counts == {
        "P1": (2, 25.0),
        "P2": (1, 12.5),
        "P3": (1, 12.5),
        "P4": (2, 25.0),
        "Q": (0, 0.0),
        "Unscored": (2, 25.0),
    }
    hist = {h["bucket_from"]: h["count"] for h in dist["score_histogram"]}
    assert hist[0] == 1 and hist[20] == 1 and hist[40] == 1 and hist[60] == 1
    assert hist[80] == 1 and hist[90] == 1  # 100 lands in the last bucket


async def test_distribution_is_hub_scoped_and_narrowed(db_session):
    hub_a, hub_b = await _portfolio(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub_b.id])
    async with _client(db_session) as client:
        rows = (await client.get("/priorities")).json()
        dist = (await client.get("/priorities/distribution")).json()
        # A hub filter outside the scope never widens it.
        widened = (
            await client.get("/priorities/distribution", params={"hub_id": str(hub_a.id)})
        ).json()
    assert {r["hub"] for r in rows} == {"PD-Romania"}
    _assert_reconciles(dist, rows)
    assert dist["total_projects"] == 3
    assert widened["total_projects"] == 0
    assert all(b["share_pct"] == 0.0 for b in widened["band_distribution"])


async def test_distribution_denied_without_matrix_read(db_session):
    await _act_as(db_session, RoleName.AUDITOR)
    async with _client(db_session) as client:
        resp = await client.get("/priorities/distribution")
    assert resp.status_code == 403


# --------------------------------------------------------------------------
# §5 Compare
# --------------------------------------------------------------------------


async def test_compare_returns_projects_in_order_without_financials(db_session):
    hub = await make_hub(db_session)
    p1 = await _scored(db_session, hub, "One", _ZERO_DIMS, tcogs_eur=123.0, selling_price_eur=456.0)
    p2 = await _scored(db_session, hub, "Two", [5] * 13)
    p3 = await make_project(db_session, hub, name="Three")
    await _act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with _client(db_session) as client:
        resp = await client.get(
            "/priorities/compare",
            params=[
                ("project_id", str(p2.id)),
                ("project_id", str(p1.id)),
                ("project_id", str(p3.id)),
            ],
        )
    assert resp.status_code == 200, resp.text
    projects = resp.json()["projects"]
    assert [p["project_id"] for p in projects] == [str(p2.id), str(p1.id), str(p3.id)]
    assert set(projects[0]) == {
        "project_id",
        "project_name",
        "hub",
        "set_priority",
        "has_score",
        "weighted_score",
        "normalized_pct",
        "suggested_band",
        "dimension_scores",
    }
    for key in _FINANCIAL_KEYS:
        assert key not in resp.text
    assert "123" not in resp.text and "456" not in resp.text
    one = projects[1]
    assert (one["normalized_pct"], one["suggested_band"], one["weighted_score"]) == (
        45,
        "P3",
        134.0,
    )
    assert [d["points"] for d in one["dimension_scores"]] == _ZERO_POINTS
    assert projects[2]["has_score"] is False
    assert len(projects[2]["dimension_scores"]) == 13


@pytest.mark.parametrize("n", [0, 1, 6])
async def test_compare_count_limits(db_session, n):
    hub = await make_hub(db_session)
    ids = [str((await make_project(db_session, hub, name=f"P{i}")).id) for i in range(n)]
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.get("/priorities/compare", params=[("project_id", i) for i in ids])
    assert resp.status_code == 422
    if n:
        assert resp.json()["code"] == "COMPARE_COUNT"


async def test_compare_five_is_allowed_and_duplicates_rejected(db_session):
    hub = await make_hub(db_session)
    ids = [str((await make_project(db_session, hub, name=f"P{i}")).id) for i in range(5)]
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        ok = await client.get("/priorities/compare", params=[("project_id", i) for i in ids])
        dup = await client.get(
            "/priorities/compare", params=[("project_id", ids[0]), ("project_id", ids[0])]
        )
    assert ok.status_code == 200 and len(ok.json()["projects"]) == 5
    assert dup.status_code == 422 and dup.json()["code"] == "COMPARE_DUPLICATE"


async def test_compare_out_of_scope_and_unknown_are_indistinguishable(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    mine = await make_project(db_session, hub_b, name="Mine")
    mine2 = await make_project(db_session, hub_b, name="Mine 2")
    theirs = await make_project(db_session, hub_a, name="Theirs")
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub_b.id])
    async with _client(db_session) as client:
        ok = await client.get(
            "/priorities/compare",
            params=[("project_id", str(mine.id)), ("project_id", str(mine2.id))],
        )
        out = await client.get(
            "/priorities/compare",
            params=[("project_id", str(mine.id)), ("project_id", str(theirs.id))],
        )
        unknown = await client.get(
            "/priorities/compare",
            params=[("project_id", str(mine.id)), ("project_id", str(uuid.uuid4()))],
        )
    assert ok.status_code == 200
    assert out.status_code == unknown.status_code == 422
    assert out.json() == unknown.json()
    assert out.json()["code"] == "COMPARE_PROJECT_UNAVAILABLE"
    assert str(theirs.id) not in out.text and "Theirs" not in out.text


async def test_compare_denied_without_matrix_read(db_session):
    await _act_as(db_session, RoleName.AUDITOR)
    async with _client(db_session) as client:
        resp = await client.get(
            "/priorities/compare",
            params=[("project_id", str(uuid.uuid4())), ("project_id", str(uuid.uuid4()))],
        )
    assert resp.status_code == 403


# --------------------------------------------------------------------------
# Migration p21a (own container: it walks the chain)
# --------------------------------------------------------------------------


def _dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


def _sql(url: str, *statements: str, fetch: str | None = None):
    async def _run():
        conn = await asyncpg.connect(_dsn(url))
        try:
            for s in statements:
                await conn.execute(s)
            return await conn.fetch(fetch) if fetch else None
        finally:
            await conn.close()

    return asyncio.run(_run())


def test_migration_p21a_adds_unconfigured_currencies_and_score_zero():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "p20a_run_step_span_fte"], url)
        assert r.returncode == 0, r.stderr
        _sql(
            url,
            "INSERT INTO currency_rates (id, currency_code, rate_to_eur) VALUES "
            "(gen_random_uuid(), 'EUR', 1.0), (gen_random_uuid(), 'USD', 1.08), "
            "(gen_random_uuid(), 'INR', 97)",
        )
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        rows = _sql(
            url,
            fetch="SELECT currency_code::text, rate_to_eur FROM currency_rates ORDER BY 1",
        )
        assert {row[0]: row[1] for row in rows} == {
            "EGP": None,
            "EUR": Decimal("1.0000"),
            "IDR": None,
            "INR": Decimal("97.0000"),
            "USD": Decimal("1.0800"),
            "ZAR": None,
        }
        checks = _sql(
            url,
            fetch=(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conname = 'ck_priority_scores_strategic_project_score_range'"
            ),
        )
        assert "0" in checks[0][0] and "5" in checks[0][0] and ">= 1" not in checks[0][0]

        # Idempotent re-run: downgrade, upgrade, no duplicate rows.
        r = run_alembic(["downgrade", "p20a_run_step_span_fte"], url)
        assert r.returncode == 0, r.stderr
        rows = _sql(url, fetch="SELECT currency_code::text FROM currency_rates ORDER BY 1")
        assert [row[0] for row in rows] == ["EUR", "INR", "USD"]
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        rows = _sql(url, fetch="SELECT count(*) FROM currency_rates")
        assert rows[0][0] == 6


def test_migration_p21a_leaves_an_empty_rates_table_for_the_seed():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        rows = _sql(url, fetch="SELECT count(*) FROM currency_rates")
        assert rows[0][0] == 0
