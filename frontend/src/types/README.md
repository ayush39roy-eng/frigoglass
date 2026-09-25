# `src/types/` — PLACEHOLDER types (P4-T01)

> Per the `frontend-builder` skill, this directory is **normally generated from the backend
> OpenAPI schema, never hand-authored.**

P4-T01 was started out of phase sequence (project-owner direction) while P3 — the API layer and
its OpenAPI schema — does not yet exist. Every file here is therefore hand-authored as a
**placeholder**, carries the `// PLACEHOLDER` header, and is tracked as debt in the P4-T01
`docs/MEMORY.md` entry.

## Reconciliation (P3-T07 / each P4 surface task)

When P3-T01 publishes the OpenAPI schema:

- regenerate types into this directory,
- delete these hand-authored files,
- fix up imports,
- the contract test in P3-T07 asserts the generated types match what the surfaces consume.

## Ground truth used to author these

Enum **values** are copied verbatim from `backend/models/enums.py` (which is itself pinned to
`docs/DOMAIN_RULES.md`). Shapes are a best-effort read of `docs/PROJECT_AND_STACK.md` §2 and
`docs/DOMAIN_RULES.md`; they are deliberately minimal — only what the shared components in
`src/components/shared/` need to compile. Surfaces will extend/replace them.
