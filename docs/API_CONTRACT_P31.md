# API contract — P31: multi-select category and project-type filters

Owner: backend-builder (P31-T01). Consumer: frontend-builder (P31-T02). Date: 2026-10-23.
Rules: `docs/DOMAIN_RULES.md` I9, I19, I23 and "Global hub filter"; plan section P31.

Nothing about response shapes changes. Only query params change: no response model gains, loses or
retypes a field.

## 1. Semantics (every endpoint below)

- `category` and `type` are **repeatable** query params, for example
  `?category=A%2B&category=B&type=NM&type=CO`.
- Values within one param are ORed. Different params are ANDed with each other, with `hub_id` /
  `region`, and with every other filter.
- An absent param or an empty list means no filter. A repeated identical value counts once.
- **One value behaves exactly as before P31.** The server builds the same `column = :value`
  predicate, so old single-value links keep working. This was checked against the pre-change code:
  the same rows in the same order on every endpoint.
- An unknown value anywhere in the list gives **422**. For example, `?type=NM&type=XX` is 422 and
  `?type=` (empty string) is 422.
- **`Unmapped`** means the value is NULL. It is accepted **on the Dashboard endpoints only**
  (§2a), for both `category` and `type`. It is ORed with the other values, for example
  `?type=Unmapped&type=NM` means "type IS NULL OR type = NM". Elsewhere `Unmapped` is an unknown
  value and gives 422, as before.
  - The `category` `Unmapped` is new. It mirrors the `/dashboard/analytics` `by_category`
    "Unmapped" bucket, so a click on that pie slice can be sent back as a filter.
- RBAC hub scope is applied first, then `hub_id` / `region`, then the selection. The selection only
  narrows. An out-of-scope `hub_id` still gives empty rows and zero totals.
- Every total, count, share and chart bucket is computed by the server for the selected set
  (I9, I19, I23).

## 2. Endpoints

### 2a. Dashboard (`category` / `type` accept `Unmapped`)

| Endpoint | Notes |
|---|---|
| `GET /dashboard/pipeline-totals` | new params |
| `GET /dashboard/status-overview` | new params |
| `GET /dashboard/completing-within-year` | new params; the counts, `rows` and `priority_delivery` all cover the selection |
| `GET /dashboard/hub-type-pipeline` | new params |
| `GET /dashboard/analytics` | new params; every bucket, including `by_type` / `by_category`, and the completing cross-tabs |
| `GET /dashboard/region-summary` | new params |
| `GET /dashboard/projects` | was single-value; now a list (`type` already took `Unmapped`) |
| `GET /dashboard/projects/facets` | new params; leaders and steps present in the selected set |
| `GET /vip-projects` | new params; per-hub ranking and auto-fill run over the selected projects only |
| `GET /exports/dashboard` | was `category: str` (unvalidated) and a single `type`; now validated lists like the register |

Reconciliation is tested. Every integer these endpoints serve, summed over the single values of a
partition (each `ProjectType` plus `Unmapped`, or each `ProjectCategory` plus `Unmapped`), equals
the unfiltered value. Category × type cells sum to their category. Within one selection:

- the register `total_count` equals `pipeline-totals.total_count`, `status-overview.total_count`,
  `region-summary.total_count`, Σ `analytics.by_type`, Σ `by_category`, Σ `by_hub` and
  Σ `hub-type-pipeline.count`;
- the five status cards plus `other_statuses_count` equal `total_count`;
- Σ `analytics.completing_by_type.completing_count` equals `completing-within-year.within_year_count`
  (I9).

`/vip-projects` is a per-hub top-N, so it is not additive. Every row it serves matches the selection.

### 2b. Elsewhere (no `Unmapped`)

| Endpoint | Notes |
|---|---|
| `GET /projects` | was single-value. **The wire name of the type param was `type_`.** It is now `type`, per this contract. `type_` is still accepted (also repeatable) and is ORed into `type` |
| `GET /gantt` | was single-value; `total_count` and `weekly_active_counts` cover the selection |
| `GET /priorities` | was single-value |
| `GET /priorities/distribution` | was single-value; same row set as `GET /priorities` |
| `GET /priority-board` | was single-value; column `count`, `design_weeks` and `lab_weeks` cover the selection |
| `GET /exports/matrix` | `category` was an unvalidated string; now a validated list. **`type` is new** here: before P31 it was ignored |
| `GET /exports/gantt` | **`category` / `type` are new** (the Gantt toolbar selection) |
| `GET /exports/project-registration` | as `GET /projects`, including the `type_` legacy spelling |

These endpoints are unchanged: `GET /planning/resource-load` (it already takes lists:
`category`, `project_type`), and `GET /priorities/summary` and `/capacity/*` (they take no
category / type filter).

## 3. OpenAPI

Each param is declared as `array` of the enum. On the Dashboard it is an `array` of
(`ProjectCategory` | `"Unmapped"`) or (`ProjectType` | `"Unmapped"`). The schema says `anyOf
[array, null]` because the Python default is `None`, which means the same as `[]`. No component
schema changed, so `test_openapi_frontend_contract.py` is unaffected.

## 4. Async export jobs

The `filters` JSONB of an export job stores one selected value as the bare string, which is the
pre-P31 shape, and several values as a list. For example, `{"category": "A"}` or
`{"category": ["A", "B"]}`. The builders read both forms, so jobs queued before P31 still run.
