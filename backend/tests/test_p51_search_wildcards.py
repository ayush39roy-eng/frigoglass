"""P51-T02: project search wildcards (DOMAIN_RULES "Project search";
API_CONTRACT_P13 §3 `q`).

- `*` matches any run of characters, `?` exactly one; every other character
  (`%`, `_`, `\\`, `-`, `/`, `>`, non-ASCII, ...) is literal.
- Still a case-insensitive substring match of name OR external code.
- One shared helper (`services.text_search`) behind every project `q`.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects import postgresql

from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, RoleName
from services import project_filters, text_search
from services.text_search import escape_like, project_search_filter, search_like_pattern
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_user

# --- helper ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("q", "pattern"),
    [
        (None, None),
        ("", None),
        ("   ", None),
        ("SP", "%SP%"),
        ("  SP*  ", "%SP%%"),
        ("S*45", "%S%45%"),
        ("S?45", "%S_45%"),
        ("*", "%%%"),
        ("100%", "%100\\%%"),
        ("a_b", "%a\\_b%"),
        ("a\\b", "%a\\\\b%"),
        ("EEI>15%", "%EEI>15\\%%"),
        ("PepsiCo / Fresh", "%PepsiCo / Fresh%"),
        ("(x) [y] . & ' \" # < = + -", "%(x) [y] . & ' \" # < = + -%"),
        ("Ψυγείο*", "%Ψυγείο%%"),
        ("\\*", "%\\\\%%"),
    ],
)
def test_search_like_pattern(q: str | None, pattern: str | None) -> None:
    assert search_like_pattern(q) == pattern


def test_escape_like_escapes_only_like_specials() -> None:
    assert escape_like("a%b_c\\d*e?f") == "a\\%b\\_c\\\\d*e?f"


def test_one_shared_helper() -> None:
    assert project_filters.search_predicate is text_search.project_search_filter
    assert project_filters.escape_like is text_search.escape_like
    assert project_filters.Q_MAX_LENGTH == text_search.Q_MAX_LENGTH == 100


def test_predicate_is_bound_parameter_with_escape() -> None:
    predicate = project_search_filter("x'; DROP TABLE projects; --*")
    assert predicate is not None
    compiled = predicate.compile(dialect=postgresql.dialect())
    sql = str(compiled)
    assert "DROP" not in sql
    assert "ESCAPE" in sql.upper()
    assert set(compiled.params.values()) == {"%x'; DROP TABLE projects; --%%"}
    assert project_search_filter("  ") is None


# --- endpoints ------------------------------------------------------------------------


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


async def _act_as(db_session, *roles: RoleName, hub_ids=None):
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


NAMES = {
    "sp": ("SPX 400 Cooler", "24-0001"),
    "s45": ("S-45 SZ Glass Door", "24-0002"),
    "eei": ("EEI>15% upgrade", "24-0003"),
    "pepsi": ("PepsiCo / Fresh", "24-0004"),
    "under": ("ICOOL_2", "24-0005"),
    "slash": ("Back\\slash", "24-0006"),
    "greek": ("Ψυγείο Αθήνα", "24-0007"),
    "plain": ("Other fridge", "XSP-9"),
}


async def _seed(db_session):
    greece = await make_hub(db_session)
    romania = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    ids = {}
    for key, (name, code) in NAMES.items():
        project = await make_project(db_session, greece, name=name, external_code=code)
        ids[str(project.id)] = key
    # Out of the caller's scope: a wildcard never widens the hub scope.
    await make_project(db_session, romania, name="SP Romania", external_code="24-9999")
    await db_session.flush()
    return greece, ids


CASES = [
    # (q, expected keys)
    ("SP*", {"sp", "plain"}),  # name "SPX…" and code "XSP-9"
    ("sp*", {"sp", "plain"}),  # case-insensitive
    ("SP", {"sp", "plain"}),  # no wildcard: substring, unchanged
    ("S*45", {"s45"}),
    ("S?45", {"s45"}),  # `?` = exactly one character ("-")
    ("S??45", set()),
    ("?COOL", {"under", "sp"}),  # "ICOOL" and "SPX 400 Cooler" (" Cool")
    ("?COOL_", {"under"}),
    ("24-000?", {"sp", "s45", "eei", "pepsi", "under", "slash", "greek"}),
    ("%", {"eei"}),  # literal
    ("_", {"under"}),  # literal
    ("\\", {"slash"}),  # literal
    ("EEI>15%", {"eei"}),
    ("eei>15% up*", {"eei"}),
    ("PepsiCo / Fresh", {"pepsi"}),
    ("pepsico*fresh", {"pepsi"}),
    ("ψυγείο*αθήνα", {"greek"}),
    ("  s*45  ", {"s45"}),
    ("nothing*here", set()),
]


@pytest.mark.parametrize("path", ["/projects", "/dashboard/projects"])
async def test_endpoint_wildcards_and_literals(db_session, path: str) -> None:
    greece, ids = await _seed(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with _client(db_session) as client:
        for q, expected in CASES:
            resp = await client.get(path, params={"q": q})
            assert resp.status_code == 200, (q, resp.text)
            body = resp.json()
            rows = body if isinstance(body, list) else body["rows"]
            got = {ids.get(r.get("id") or r.get("project_id"), "OUT_OF_SCOPE") for r in rows}
            assert got == expected, (path, q, got)
        resp = await client.get(path, params={"q": "*" * 101})
        assert resp.status_code == 422


async def test_priority_board_uses_the_shared_search(db_session) -> None:
    greece, ids = await _seed(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with _client(db_session) as client:
        for q, expected in CASES:
            resp = await client.get("/priority-board", params={"q": q})
            assert resp.status_code == 200, (q, resp.text)
            got = {
                ids.get(card["project_id"], "OUT_OF_SCOPE")
                for column in resp.json()["columns"]
                for card in column["cards"]
            }
            assert got == expected, (q, got)
