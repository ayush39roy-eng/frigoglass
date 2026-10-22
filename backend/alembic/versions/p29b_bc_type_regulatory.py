"""The client's `BC` type is the app's `RC` (ADR 0038 amendment 2026-10-22, P29-T04)

Revision ID: p29b_bc_type_regulatory
Revises: p29a_capacity_hubs
Create Date: 2026-10-22

Owner ruling: the client codes its Regulatory / Business Compliance projects
`BC` ("Business Continuity"); the app's `RC` matched no client row, so the 59
projects imported with `type = NULL` and never got the ADR 0038
`regulatory_compliance` tag or its score. The raw workbook code (`excel_type`)
is not stored in the database (it lives in `seed/client_2026_seed_data.json`),
so this revision is keyed on the frozen external codes of the projects whose
`excel_type` is `BC` (`_BC_EXTERNAL_CODES`, extracted 2026-10-22).

For each such project that still has `type IS NULL` (a type set since by a
person is left alone):

1. `type = 'RC'` (one `project.update` audit row, actor null,
   `after_state.source = "bc_type_regulatory_adr_0038"`). `type` is not a
   scheduler input: nothing is marked stale.
2. `regulatory_compliance` is added to `scoring_tags` when not already set
   (stored in the ADR 0038 canonical order).
3. The ADR 0038 §2 pre-fill for that not-set -> set transition: the
   `regulatory_compliance` dimension (by stable key) is set to 5, creating
   the `priority_scores` row if needed; the cached `weighted_score` /
   `normalized_pct` / `suggested_band` are recomputed under the CURRENT rubric
   with the same frozen formula as p27a (`services.priority_scoring.compute_score`;
   a test pins equality). One `priority_score.create` / `.update` audit row
   with `after_state.source = "registration_tag_backfill"` and `tags`.
4. The log line reports the projects retyped and the stored score band changes.

`Project.priority` and `schedule_stale` are never touched (ADR 0038 §7).

Downgrade: `type` back to NULL and the tag removed for the same projects when
they are still `RC` (audited). The scores are NOT reverted (ordinary scores
now, as in p27a); the before values are in the audit rows.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from typing import Any

import sqlalchemy as sa

from alembic import op

revision: str = "p29b_bc_type_regulatory"
down_revision: str | Sequence[str] | None = "p29a_capacity_hubs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_log = logging.getLogger("alembic.runtime.migration")

#: External codes of the 2026 pipeline projects whose workbook type is `BC`.
_BC_EXTERNAL_CODES: tuple[str, ...] = (
    "26-00383", "26-S0221", "26-S0222", "26-S0320", "26-S0321", "26-S0327", "26-S0328",
    "26-S0329", "26-S0330", "26-S0331", "26-S0332", "26-S0333", "26-S0334", "26-S0335",
    "26-S0336", "26-S0337", "26-S0338", "26-S0339", "26-S0340", "26-S0341", "26-S0342",
    "26-S0343", "26-S0344", "26-S0345", "26-S0346", "26-S0347", "26-S0348", "26-S0349",
    "26-S0350", "26-S0351", "26-S0352", "26-S0353", "26-S0354", "26-S0358", "26-S0359",
    "26-S0360", "26-S0361", "26-S0362", "26-S0363", "26-S0364", "26-S0365", "26-S0366",
    "26-S0367", "26-S0368", "26-S0369", "26-S0370", "26-S0371", "26-S0372", "26-S0373",
    "26-S0374", "26-S0375", "26-S0376", "26-S0377", "26-S0378", "26-S0379", "26-S0380",
    "26-S0399-2", "26-S0400", "26-S0401",
)  # fmt: skip

_TYPE = "RC"
_TAG = "regulatory_compliance"
#: ADR 0038 canonical tag order (`models.enums.ScoringTag` declaration order).
_CANONICAL_TAGS: tuple[str, ...] = (
    "new_customer",
    "strategic_project",
    "new_options",
    "regulatory_compliance",
    "new_models",
    "improvement",
)
_DIMENSION_KEY = "regulatory_compliance"
_PREFILL_SCORE = 5
_BANDS: tuple[tuple[int, str], ...] = ((70, "P1"), (55, "P2"), (40, "P3"), (0, "P4"))
_SOURCE_TYPE = "bc_type_regulatory_adr_0038"
_SOURCE_SCORE = "registration_tag_backfill"
_SOURCE_DOWN = "bc_type_regulatory_adr_0038_downgrade"


def _compute(
    dims: Sequence[tuple[uuid.UUID, int, bool]], scores: dict[uuid.UUID, int | None]
) -> tuple[Fraction | None, int | None, str | None]:
    """`compute_score` (ADR 0037), frozen (the p27a copy): Σ active weights;
    points = score/5×weight; a null/absent active score counts 0; no active
    score = unscored."""

    active = [(dim_id, weight) for dim_id, weight, is_active in dims if is_active]
    present = [(scores.get(dim_id), weight) for dim_id, weight in active]
    if not any(s is not None for s, _w in present):
        return None, None, None
    total = sum(w for _d, w in active)
    raw = sum((Fraction(s * w, 5) for s, w in present if s is not None), Fraction(0))
    pct = int(raw * 100 / total + Fraction(1, 2))
    band = next(label for threshold, label in _BANDS if pct >= threshold)
    return raw, pct, band


def _2dp(value: Fraction) -> float:
    return float(
        (Decimal(value.numerator) / Decimal(value.denominator)).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
    )


_INSERT_AUDIT = sa.text(
    "INSERT INTO audit_log_entries "
    "(id, actor_user_id, action, entity_type, entity_id, hub_id, before_state, "
    "after_state, notes) VALUES (:id, NULL, :action, :entity_type, :entity_id, :hub_id, "
    "CAST(:before AS jsonb), CAST(:after AS jsonb), :notes)"
)


def _audit(bind: sa.Connection, **values: Any) -> None:
    bind.execute(
        _INSERT_AUDIT,
        {
            "id": uuid.uuid4(),
            **values,
            "before": json.dumps(values["before"]) if values["before"] is not None else None,
            "after": json.dumps(values["after"]),
        },
    )


def _project_state(row: sa.Row, type_value: str | None, tags: list[str]) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "external_code": row.external_code,
        "hub_id": str(row.hub_id),
        "type": type_value,
        "scoring_tags": tags,
    }


def upgrade() -> None:
    bind = op.get_bind()
    projects = bind.execute(
        sa.text(
            "SELECT p.id, p.name, p.external_code, p.hub_id, "
            "CAST(p.scoring_tags AS text[]) AS tags, ps.id AS score_id "
            "FROM projects p LEFT JOIN priority_scores ps ON ps.project_id = p.id "
            "WHERE p.type IS NULL AND p.external_code = ANY(:codes) ORDER BY p.id"
        ),
        {"codes": list(_BC_EXTERNAL_CODES)},
    ).all()
    if not projects:
        _log.info("p29b: no BC project with a null type; nothing retyped")
        return

    version: int | None = bind.execute(
        sa.text("SELECT max(version) FROM rubric_versions")
    ).scalar_one()
    dim_rows = bind.execute(sa.text("SELECT id, key, weight, active FROM scoring_dimensions")).all()
    dims = [(r.id, r.weight, r.active) for r in dim_rows]
    key_of = {r.id: r.key for r in dim_rows}
    dim = next((r for r in dim_rows if r.key == _DIMENSION_KEY), None)

    select_scores = sa.text(
        "SELECT dimension_id, score FROM priority_dimension_scores WHERE priority_score_id = :id"
    )
    select_cached = sa.text(
        "SELECT weighted_score, normalized_pct, CAST(suggested_band AS text) AS band, "
        "CAST(hard_gates AS text[]) AS hard_gates, rubric_version "
        "FROM priority_scores WHERE id = :id"
    )

    def score_state(score_id: uuid.UUID, project_id: uuid.UUID) -> dict[str, Any]:
        cached = bind.execute(select_cached, {"id": score_id}).one()
        scores = bind.execute(select_scores, {"id": score_id}).all()
        return {
            "id": str(score_id),
            "project_id": str(project_id),
            "scores": dict(sorted((key_of[s.dimension_id], s.score) for s in scores)),
            "hard_gates": list(cached.hard_gates or []),
            "weighted_score": (
                float(cached.weighted_score) if cached.weighted_score is not None else None
            ),
            "normalized_pct": cached.normalized_pct,
            "suggested_band": cached.band,
            "rubric_version": cached.rubric_version,
        }

    created = band_changed = pct_changed = 0
    for row in projects:
        tags_before = list(row.tags or [])
        newly_set = _TAG not in tags_before
        tags_after = [t for t in _CANONICAL_TAGS if t in {*tags_before, _TAG}]
        bind.execute(
            sa.text(
                "UPDATE projects SET type = CAST(:type AS project_type), "
                "scoring_tags = CAST(:tags AS project_scoring_tag[]) WHERE id = :id"
            ),
            {"type": _TYPE, "tags": tags_after, "id": row.id},
        )
        _audit(
            bind,
            action="project.update",
            entity_type="Project",
            entity_id=str(row.id),
            hub_id=row.hub_id,
            before=_project_state(row, None, tags_before),
            after={**_project_state(row, _TYPE, tags_after), "source": _SOURCE_TYPE},
            notes="p29b: workbook type BC is Regulatory / Business Compliance (ADR 0038 amendment)",
        )
        if not newly_set or dim is None or version is None:
            continue  # only a not-set -> set tag pre-fills (ADR 0038 §2)

        score_id = row.score_id
        before: dict[str, Any] | None = None
        if score_id is None:
            score_id = uuid.uuid4()
            bind.execute(
                sa.text(
                    "INSERT INTO priority_scores (id, project_id, hard_gates) "
                    "VALUES (:id, :project_id, '{}')"
                ),
                {"id": score_id, "project_id": row.id},
            )
            created += 1
        else:
            before = score_state(score_id, row.id)
        bind.execute(
            sa.text(
                "INSERT INTO priority_dimension_scores (priority_score_id, dimension_id, score) "
                "VALUES (:sid, :did, :score) ON CONFLICT (priority_score_id, dimension_id) "
                "DO UPDATE SET score = EXCLUDED.score"
            ),
            {"sid": score_id, "did": dim.id, "score": _PREFILL_SCORE},
        )
        scores = {
            s.dimension_id: s.score for s in bind.execute(select_scores, {"id": score_id}).all()
        }
        raw, pct, band = _compute(dims, scores)
        bind.execute(
            sa.text(
                "UPDATE priority_scores SET weighted_score = :ws, normalized_pct = :pct, "
                "suggested_band = CAST(:band AS project_priority), rubric_version = :version "
                "WHERE id = :id"
            ),
            {
                "ws": _2dp(raw) if raw is not None else None,
                "pct": pct,
                "band": band,
                "version": version,
                "id": score_id,
            },
        )
        prior_band = before["suggested_band"] if before else None
        prior_pct = before["normalized_pct"] if before else None
        band_changed += prior_band != band
        pct_changed += prior_pct != pct
        _audit(
            bind,
            action="priority_score.update" if before else "priority_score.create",
            entity_type="PriorityScore",
            entity_id=str(score_id),
            hub_id=row.hub_id,
            before=before,
            after={**score_state(score_id, row.id), "source": _SOURCE_SCORE, "tags": [_TAG]},
            notes="p29b backfill: regulatory_compliance tag from workbook type BC (ADR 0038)",
        )
    _log.info(
        "p29b: retyped %d BC project(s) to RC; created %d score row(s); normalised %% changed "
        "for %d, score band changed for %d project(s)",
        len(projects),
        created,
        pct_changed,
        band_changed,
    )


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, name, external_code, hub_id, CAST(scoring_tags AS text[]) AS tags "
            "FROM projects WHERE CAST(type AS text) = :type AND external_code = ANY(:codes) "
            "ORDER BY id"
        ),
        {"type": _TYPE, "codes": list(_BC_EXTERNAL_CODES)},
    ).all()
    for row in rows:
        tags_before = list(row.tags or [])
        tags_after = [t for t in tags_before if t != _TAG]
        bind.execute(
            sa.text(
                "UPDATE projects SET type = NULL, "
                "scoring_tags = CAST(:tags AS project_scoring_tag[]) WHERE id = :id"
            ),
            {"tags": tags_after, "id": row.id},
        )
        _audit(
            bind,
            action="project.update",
            entity_type="Project",
            entity_id=str(row.id),
            hub_id=row.hub_id,
            before=_project_state(row, _TYPE, tags_before),
            after={**_project_state(row, None, tags_after), "source": _SOURCE_DOWN},
            notes="p29b downgrade: type and tag removed; scores kept (ADR 0038 §3)",
        )
