"""Service-layer helpers shared across `api/routers/*` modules (P3-T01).

Kept separate from `api/routers/` so business logic that multiple endpoints
need (audit-state serialization, the priority-scoring formula, mapping DB rows
into `scheduling/`'s pure dataclasses and persisting its output) has exactly
one home each, instead of being copy-pasted per router.

Nothing here imports FastAPI — these are plain functions taking an
`AsyncSession` (or plain values) and returning plain values/ORM objects, so
they are trivially unit-testable without spinning up the app (qa-inspector's
P3-T07 concern, not addressed by this task, but this layering is meant to make
it easy).
"""
