"""The initial scoring rubric (ADR 0029 / ADR 0033 weights) and the seed's
score writer (ADR 0037, P26-T01).

Since ADR 0037 the rubric lives in the `scoring_dimensions` /
`rubric_versions` tables; migration `p26a_scoring_rubric_tables` creates
version 1 with these 13 dimensions. This module is SEED DATA, not a runtime
constant: the API reads the rubric only from the tables.

- `INITIAL_SCORING_DIMENSIONS`: the 13, in their positional order (the order of
  the prototype's / client data's `dims` arrays).
- `initial_rubric()`: those 13 as a pure `Rubric` (version 1), used by
  `client_2026.derive_dims` to derive synthetic scores that land in a target
  band (the seed's data contract is the initial rubric, whatever an admin
  has changed since).
- `ensure_scoring_rubric(session)`: inserts version 1 when the tables are
  empty (a database built without the p26a data step), otherwise a no-op;
  returns the CURRENT rubric. The reseed never resets the rubric (it is
  configuration, like users).
- `seed_priority_score(...)`: a `PriorityScore` for positional `dims`, with
  the cached fields computed under the CURRENT rubric through
  `services.priority_scoring.compute_score` (so seed-time and request-time
  scoring are one implementation).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from models.enums import HardGateReason, ScoringTag
from models.priority import PriorityScore
from models.scoring_rubric import PriorityDimensionScore, RubricVersion, ScoringDimension
from services.priority_scoring import Rubric, RubricDimension, compute_score
from services.scoring_rubric import apply_result, load_rubric, snapshot

#: (key, label, pillar, weight, inverted), positional order. Keys are the
#: stable wire / export keys (ADR 0029: `gross_margins` = Gross Profitability,
#: `profitability` = ROI).
INITIAL_SCORING_DIMENSIONS: tuple[tuple[str, str, str, int, bool], ...] = (
    ("strategic_project", "Strategic Project", "Strategic Alignment", 25, False),
    ("new_customer", "New Customer", "Strategic Alignment", 25, False),
    ("new_options", "New Options", "Strategic Alignment", 25, False),
    ("regulatory_compliance", "Regulatory Compliance", "Regulatory & Quality", 25, False),
    ("quality_improvements", "Quality Improvements", "Regulatory & Quality", 25, False),
    ("rm_savings", "RM Savings", "Financial Return", 25, False),
    ("total_rm_savings", "Total RM Savings", "Financial Return", 25, False),
    ("gross_margins", "Gross Profitability", "Financial Return", 25, False),
    ("profitability", "ROI", "Investment & Feasibility", 25, False),
    ("annual_volume", "Annual Volume", "Market & Volume", 15, False),
    ("three_year_volume", "3-Year Volume", "Market & Volume", 25, False),
    ("new_models", "New Models", "Market & Volume", 15, False),
    ("capex_investment", "CAPEX Investment (inverted)", "Investment & Feasibility", 15, True),
)
INITIAL_KEYS: tuple[str, ...] = tuple(d[0] for d in INITIAL_SCORING_DIMENSIONS)

_NS = uuid.UUID("6f1d3b8e-2b8a-4c1e-9a57-3d0f0e2a7c26")


def initial_rubric() -> Rubric:
    return Rubric(
        version=1,
        dimensions=tuple(
            RubricDimension(
                id=uuid.uuid5(_NS, key),
                key=key,
                label=label,
                pillar=pillar,
                weight=weight,
                inverted=inverted,
                active=True,
                display_order=order,
            )
            for order, (key, label, pillar, weight, inverted) in enumerate(
                INITIAL_SCORING_DIMENSIONS, start=1
            )
        ),
    )


async def ensure_scoring_rubric(session: AsyncSession) -> Rubric:
    has_version = (await session.execute(select(func.count(RubricVersion.id)))).scalar_one()
    if not has_version:
        rubric = initial_rubric()
        for d in rubric.dimensions:
            session.add(
                ScoringDimension(
                    id=d.id,
                    key=d.key,
                    label=d.label,
                    pillar=d.pillar,
                    weight=d.weight,
                    inverted=d.inverted,
                    active=d.active,
                    display_order=d.display_order,
                )
            )
        session.add(
            RubricVersion(
                version=1,
                reason="Initial rubric (seed): the 13 dimensions of ADR 0029 / ADR 0033.",
                total_weight=rubric.total_weight,
                dimensions=snapshot(rubric),
            )
        )
        await session.flush()
    return await load_rubric(session)


def seed_priority_score(
    rubric: Rubric,
    project_id: uuid.UUID,
    dims: Sequence[int],
    hard_gates: Sequence[HardGateReason] = (),
    tags: Sequence[ScoringTag] = (),
) -> PriorityScore:
    """`dims` are positional over `INITIAL_KEYS`. ADR 0038: each of `tags`
    (the project's Registration tags) sets its mapped dimension to 5, the
    same rule as the p27a backfill and the Registration pre-fill."""

    scores: dict[str, int | None] = dict(zip(INITIAL_KEYS, dims, strict=True))
    for tag in tags:
        scores[dc.SCORING_TAG_DIMENSION_KEY[tag.value]] = dc.DIMENSION_SCORE_MAX
    by_key = {d.key: d for d in rubric.dimensions}
    score = PriorityScore(
        project_id=project_id,
        hard_gates=list(hard_gates),
        dimension_scores=[
            PriorityDimensionScore(dimension_id=by_key[k].id, score=v)
            for k, v in scores.items()
            if k in by_key
        ],
    )
    apply_result(score, compute_score(rubric, scores), rubric.version)
    return score
