"""Registration "project nature" tags; backfill from `type` and pre-fill scores (P27-T01)

Revision ID: p27a_project_scoring_tags
Revises: p26a_scoring_rubric_tables
Create Date: 2026-10-22

ADR 0038. Adds `projects.scoring_tags`: an array of the new enum
`project_scoring_tag` (`new_customer`, `strategic_project`, `new_options`,
`regulatory_compliance`, `new_models`, `improvement`), NOT NULL, default `{}`.
The CHECK `ck_projects_scoring_tags_distinct` calls the IMMUTABLE SQL function
`rpd_scoring_tags_distinct(project_scoring_tag[])`: no duplicate and no null
element (a CHECK cannot hold a subquery directly).

Data step (ADR 0038 §6), every value a bound parameter:

1. `type` NM -> `new_models`, NO -> `new_options`, RC -> `regulatory_compliance`,
   IMP -> `improvement`; every other type and a null type get no tag.
2. For each tagged project, the mapped dimension (by stable KEY, ADR 0037;
   `improvement` -> `quality_improvements`) is set to score 5 in
   `priority_dimension_scores`, creating the `priority_scores` row if the
   project has none. The mapped dimension is written even when an Admin has
   deactivated it (ADR 0038 §4).
3. The project's cached `weighted_score` / `normalized_pct` / `suggested_band`
   are recomputed under the CURRENT rubric (the `scoring_dimensions` rows and
   the highest `rubric_versions.version`), with the same formula as
   `services.priority_scoring.compute_score` (frozen here, like p26a, so this
   revision never moves when code changes; a test pins equality).
4. One `priority_score.create` / `priority_score.update` audit row per touched
   project (actor null, `after_state.source = "registration_tag_backfill"`).
5. The count of projects whose stored score band changed is logged
   (`p27a: ... band changed for K project(s)`). The P1 capacity fill
   (ADR 0036) is computed on read, so its promoted band is not counted here.

`Project.priority` and `schedule_stale` are not touched (ADR 0038 §7).

Downgrade drops the column, the CHECK, the function and the enum. The scores
written by the backfill (and by any later tag edit) are NOT reverted: they are
ordinary scores now (ADR 0038 §3), and the pre-backfill values are only in the
audit rows' `before_state`.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "p27a_project_scoring_tags"
down_revision: str | Sequence[str] | None = "p26a_scoring_rubric_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_log = logging.getLogger("alembic.runtime.migration")

#: Frozen ADR 0038 values (canonical order).
_TAGS: tuple[str, ...] = (
    "new_customer",
    "strategic_project",
    "new_options",
    "regulatory_compliance",
    "new_models",
    "improvement",
)
_TAG_DIMENSION_KEY: dict[str, str] = {
    "new_customer": "new_customer",
    "strategic_project": "strategic_project",
    "new_options": "new_options",
    "regulatory_compliance": "regulatory_compliance",
    "new_models": "new_models",
    "improvement": "quality_improvements",
}
_TYPE_TAG: dict[str, str] = {
    "NM": "new_models",
    "NO": "new_options",
    "RC": "regulatory_compliance",
    "IMP": "improvement",
}
_PREFILL_SCORE = 5
_BANDS: tuple[tuple[int, str], ...] = ((70, "P1"), (55, "P2"), (40, "P3"), (0, "P4"))

_enum = postgresql.ENUM(*_TAGS, name="project_scoring_tag", create_type=False)


def _compute(
    dims: Sequence[tuple[uuid.UUID, int, bool]], scores: dict[uuid.UUID, int | None]
) -> tuple[Fraction | None, int | None, str | None]:
    """`compute_score` (ADR 0037): Σ active weights; points = score/5×weight;
    a null/absent active score counts 0; no active score = unscored."""

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


def upgrade() -> None:
    bind = op.get_bind()
    _enum.create(bind, checkfirst=False)
    op.execute(
        "CREATE FUNCTION rpd_scoring_tags_distinct(tags project_scoring_tag[]) "
        "RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ "
        "SELECT array_position(tags, NULL) IS NULL "
        "AND (SELECT count(*) = count(DISTINCT t) FROM unnest(tags) AS t) $$"
    )
    op.add_column(
        "projects",
        sa.Column(
            "scoring_tags",
            postgresql.ARRAY(_enum),
            nullable=False,
            server_default="{}",
        ),
    )
    op.create_check_constraint(
        op.f("ck_projects_scoring_tags_distinct"),
        "projects",
        "rpd_scoring_tags_distinct(scoring_tags)",
    )

    # --- 1. tags from `type` ---------------------------------------------------
    for type_value, tag in _TYPE_TAG.items():
        bind.execute(
            sa.text(
                "UPDATE projects SET scoring_tags = ARRAY[CAST(:tag AS project_scoring_tag)] "
                "WHERE type = CAST(:type AS project_type)"
            ),
            {"tag": tag, "type": type_value},
        )

    # --- 2./3. pre-fill 5 and recompute under the current rubric --------------
    version: int | None = bind.execute(
        sa.text("SELECT max(version) FROM rubric_versions")
    ).scalar_one()
    dim_rows = bind.execute(sa.text("SELECT id, key, weight, active FROM scoring_dimensions")).all()
    dim_by_key = {r.key: r for r in dim_rows}
    dims = [(r.id, r.weight, r.active) for r in dim_rows]
    key_of = {r.id: r.key for r in dim_rows}

    tagged = bind.execute(
        sa.text(
            "SELECT p.id, p.hub_id, CAST(p.scoring_tags AS text[]) AS tags, ps.id AS score_id "
            "FROM projects p LEFT JOIN priority_scores ps ON ps.project_id = p.id "
            "WHERE cardinality(p.scoring_tags) > 0 ORDER BY p.id"
        )
    ).all()
    if tagged and version is None:
        raise RuntimeError("p27a: no rubric version exists; run p26a first.")

    select_scores = sa.text(
        "SELECT dimension_id, score FROM priority_dimension_scores WHERE priority_score_id = :id"
    )
    select_cached = sa.text(
        "SELECT weighted_score, normalized_pct, CAST(suggested_band AS text) AS band, "
        "CAST(hard_gates AS text[]) AS hard_gates, rubric_version "
        "FROM priority_scores WHERE id = :id"
    )
    insert_score_row = sa.text(
        "INSERT INTO priority_scores (id, project_id, hard_gates) VALUES (:id, :project_id, '{}')"
    )
    upsert_dimension = sa.text(
        "INSERT INTO priority_dimension_scores (priority_score_id, dimension_id, score) "
        "VALUES (:sid, :did, :score) ON CONFLICT (priority_score_id, dimension_id) "
        "DO UPDATE SET score = EXCLUDED.score"
    )
    update_cached = sa.text(
        "UPDATE priority_scores SET weighted_score = :ws, normalized_pct = :pct, "
        "suggested_band = CAST(:band AS project_priority), rubric_version = :version "
        "WHERE id = :id"
    )
    insert_audit = sa.text(
        "INSERT INTO audit_log_entries "
        "(id, actor_user_id, action, entity_type, entity_id, hub_id, before_state, "
        "after_state, notes) VALUES (:id, NULL, :action, 'PriorityScore', :entity_id, :hub_id, "
        "CAST(:before AS jsonb), CAST(:after AS jsonb), :notes)"
    )

    def state(score_id: uuid.UUID, project_id: uuid.UUID) -> dict[str, object]:
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
    for row in tagged:
        score_id = row.score_id
        before: dict[str, object] | None = None
        if score_id is None:
            score_id = uuid.uuid4()
            bind.execute(insert_score_row, {"id": score_id, "project_id": row.id})
            created += 1
        else:
            before = state(score_id, row.id)
        for tag in row.tags:
            dim = dim_by_key.get(_TAG_DIMENSION_KEY[tag])
            if dim is None:  # a dimension is never deleted (ADR 0037); defensive
                continue
            bind.execute(
                upsert_dimension, {"sid": score_id, "did": dim.id, "score": _PREFILL_SCORE}
            )
        scores = {
            s.dimension_id: s.score for s in bind.execute(select_scores, {"id": score_id}).all()
        }
        raw, pct, band = _compute(dims, scores)
        bind.execute(
            update_cached,
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
        after = {
            **state(score_id, row.id),
            "source": "registration_tag_backfill",
            "tags": list(row.tags),
        }
        bind.execute(
            insert_audit,
            {
                "id": uuid.uuid4(),
                "action": "priority_score.update" if before else "priority_score.create",
                "entity_id": str(score_id),
                "hub_id": row.hub_id,
                "before": json.dumps(before) if before else None,
                "after": json.dumps(after),
                "notes": "p27a backfill: registration tags from project type (ADR 0038)",
            },
        )
    _log.info(
        "p27a: tagged %d project(s) from type; created %d score row(s); normalised %% changed "
        "for %d, score band changed for %d project(s)",
        len(tagged),
        created,
        pct_changed,
        band_changed,
    )


def downgrade() -> None:
    # Scores written by the backfill / tag edits are kept (ordinary scores now).
    op.drop_constraint(op.f("ck_projects_scoring_tags_distinct"), "projects", type_="check")
    op.drop_column("projects", "scoring_tags")
    op.execute("DROP FUNCTION rpd_scoring_tags_distinct(project_scoring_tag[])")
    _enum.drop(op.get_bind(), checkfirst=False)
