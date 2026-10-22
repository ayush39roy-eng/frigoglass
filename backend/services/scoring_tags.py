"""Registration "project nature" tags pre-fill rubric scores (ADR 0038, P27-T01).

`Project.scoring_tags` holds zero or more `ScoringTag`s. Each maps by stable
dimension KEY to one rubric dimension (`domain_constants.SCORING_TAG_DIMENSION_KEY`;
`improvement` -> `quality_improvements`, the others by the same name).

The rule (`apply_tag_prefill`), called by `POST /projects` and
`PATCH /projects/{id}` in the same transaction as the Registration write:

- Only a tag that goes from NOT SET to SET writes its dimension's score as 5,
  creating the project's `PriorityScore` row if it has none, then recomputes
  the cached fields under the current rubric. Re-saving a tag already set
  writes nothing, so a manual edit of that score survives later Registration
  edits. Removing a tag leaves the score as it is.
- The mapped dimension is written even when an Admin has deactivated it; it
  counts again once reactivated (ADR 0038 §4, ADR 0037).
- One `priority_score.create` / `priority_score.update` audit row, shaped like
  the Matrix score PUT's, with `after_state.source = "registration_tag"` and
  `after_state.tags` = the tags that triggered the write.
- Never marks `schedule_stale`, never touches `Project.priority`: the
  scheduler does not read scores.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from core.principal import Principal
from models.audit import AuditLogEntry
from models.enums import ScoringTag
from models.priority import PriorityScore
from models.project import Project, canonical_tags
from models.scoring_rubric import PriorityDimensionScore
from services.audit_helpers import priority_score_audit_state
from services.priority_scoring import Rubric, compute_score
from services.scoring_rubric import apply_result, load_rubric, lock_rubric, project_scores

#: `after_state.source` of a tag-driven score write.
AUDIT_SOURCE = "registration_tag"
PREFILL_SCORE: int = dc.DIMENSION_SCORE_MAX


def dimension_key(tag: ScoringTag) -> str:
    return dc.SCORING_TAG_DIMENSION_KEY[tag.value]


def tags_for_type(type_value: str | None) -> list[ScoringTag]:
    """ADR 0038 §6: the backfill / seed rule from `Project.type`."""

    tag = dc.PROJECT_TYPE_SCORING_TAG.get(type_value) if type_value is not None else None
    return [ScoringTag(tag)] if tag is not None else []


def prefill_scores(rubric: Rubric, score: PriorityScore, tags: Iterable[ScoringTag]) -> list[str]:
    """Write `PREFILL_SCORE` on the dimension of each tag (active or not) and
    recompute the cached fields. Returns the keys written (a key whose
    dimension does not exist is skipped; a dimension is never deleted, so
    that only happens on a broken rubric). The caller holds the shared
    rubric lock and flushes."""

    by_key = {d.key: d for d in rubric.dimensions}
    by_dim = {s.dimension_id: s for s in score.dimension_scores}
    written: list[str] = []
    for tag in canonical_tags(tags):
        dim = by_key.get(dimension_key(tag))
        if dim is None:
            continue
        existing = by_dim.get(dim.id)
        if existing is None:
            row = PriorityDimensionScore(dimension_id=dim.id, score=PREFILL_SCORE)
            score.dimension_scores.append(row)
            by_dim[dim.id] = row
        else:
            existing.score = PREFILL_SCORE
        written.append(dim.key)
    if written:
        apply_result(
            score, compute_score(rubric, project_scores(rubric, score) or {}), rubric.version
        )
    return written


async def apply_tag_prefill(
    db: AsyncSession,
    project: Project,
    *,
    before: Iterable[ScoringTag],
    after: Iterable[ScoringTag],
    principal: Principal,
) -> list[ScoringTag]:
    """ADR 0038 §2: pre-fill 5 for each tag in `after` that is not in
    `before`. Stages the score write and its audit row on `db` (the caller
    commits). Returns the newly set tags (empty: nothing written)."""

    before_set = set(canonical_tags(before))
    added = [t for t in canonical_tags(after) if t not in before_set]
    if not added:
        return []

    await lock_rubric(db, exclusive=False)
    rubric = await load_rubric(db)
    existing = (
        await db.execute(select(PriorityScore).where(PriorityScore.project_id == project.id))
    ).scalar_one_or_none()
    before_state = priority_score_audit_state(existing, rubric) if existing else None
    score = existing or PriorityScore(project_id=project.id, hard_gates=[], dimension_scores=[])

    written = prefill_scores(rubric, score, added)
    if not written:
        return []
    score.scored_at = func.now()
    score.scored_by_user_id = principal.user_id
    if existing is None:
        db.add(score)
    await db.flush()

    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action="priority_score.update" if existing else "priority_score.create",
            entity_type="PriorityScore",
            entity_id=str(score.id),
            hub_id=project.hub_id,
            before_state=before_state,
            after_state={
                **priority_score_audit_state(score, rubric),
                "source": AUDIT_SOURCE,
                "tags": [t.value for t in added],
            },
        )
    )
    return added
