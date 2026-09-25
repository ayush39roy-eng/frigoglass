# `src/lib/api/`

This directory will hold the **generated** API client and its TanStack Query fetchers.

## Status at P4-T01

Empty of a client on purpose. P3 (the FastAPI layer, OpenAPI schema, auth) does not exist yet.
When P3-T01 lands its OpenAPI schema:

1. Generate the TypeScript client + types here (e.g. `openapi-typescript` / `orval`) into
   `src/types/` and `src/lib/api/`.
2. Delete every `// PLACEHOLDER` type file listed in the P4-T01 `docs/MEMORY.md` entry and
   re-point imports at the generated types.
3. Contract test (P3-T07) that the generated types match what the surfaces consume.

Query **keys** already have a stable home at `src/lib/query-keys.ts` and will not need to change.
