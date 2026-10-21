# API contract — P21: Prioritization matrix (currencies, rubric columns, distribution, compare, score 0)

Owner: backend-builder (P21-T01). Consumer: frontend-builder (P21-T02). Date: 2026-10-21.
Rules: `docs/DOMAIN_RULES.md` "Prioritization scoring" and "Currency"; ADR 0029, ADR 0033.

Everything here is **additive** except two type widenings: `CurrencyRateRead.rate_to_eur` may now be
`null`, and dimension scores accept 0. Existing field names are reused, not duplicated (§0).

Error envelope (unchanged, `api/errors.py`): `{"detail": string | [{loc, msg, type}], "code"?: string}`.

## 0. Names: what the request asked for → the field that serves it

| Asked for | Served as | Where |
|---|---|---|
| currency `code` | **`currency_code`** (existing) | `GET /currency-rates` rows |
| row `normalized_score` (0..100) | **`normalized_pct`** (existing, integer, `round(raw / 295 × 100)`) | `PriorityMatrixRow`, `PriorityCompareItem` |
| row `band` | **`suggested_band`** (existing, `"P1".."P4"`, null when unscored) | `PriorityMatrixRow`, `PriorityCompareItem` |
| row `weighted_score` | **`weighted_score`** (existing, raw points out of 295) | same |
| compare `name` | **`project_name`** (same as the matrix row) | `PriorityCompareItem` |
| `dimension_scores` | **`dimension_scores`** (new) | `PriorityMatrixRow`, `PriorityCompareItem` |

So the frontend should drop the optional `band` / `normalized_score` it declared on
`PriorityMatrixRow` / `PriorityCompareProject` and read `suggested_band` / `normalized_pct`.

`suggested_band` ignores hard gates (unchanged since P3: the hard-gate override is applied by "Apply
Priorities"); the UI keeps annotating hard-gated rows from `hard_gates`.

## 1. Currencies

### `GET /currency-rates` (existing; any authenticated user)

The Matrix currency picker's list. Ordered by enum order (EUR, USD, INR, EGP, ZAR, IDR) where rows
exist. Response `CurrencyRateRead[]`:

```json
[
  {"id": "…", "currency_code": "EUR", "name": "Euro", "rate_to_eur": 1.0, "configured": true,
   "updated_by_user_id": null, "updated_at": "2026-10-21T…"},
  {"id": "…", "currency_code": "EGP", "name": "Egyptian pound", "rate_to_eur": null, "configured": false,
   "updated_by_user_id": null, "updated_at": "2026-10-21T…"}
]
```

| Field | Type | Notes |
|---|---|---|
| `currency_code` | `"EUR" \| "USD" \| "INR" \| "EGP" \| "ZAR" \| "IDR"` | the code (was already served) |
| `name` | string | **new**: Euro, US dollar, Indian rupee, Egyptian pound, South African rand, Indonesian rupiah |
| `rate_to_eur` | number \| **null** | **now nullable**: multiply EUR by this; `null` = not configured |
| `configured` | boolean | **new**: `rate_to_eur !== null`. Disable the option when false |

No rate is invented: EGP / ZAR / IDR have `rate_to_eur: null` until set (OQ #50).

### `PUT /currency-rates/{currency_code}` (existing path; Super Admin and Admin)

Body `{"rate_to_eur": number}`: **0.0001 ≤ rate < 1,000,000**, finite (NaN / Infinity → 422).
Response: the updated `CurrencyRateRead`. Writes one `currency_rate.update` audit row (before / after
state; `before_state.rate_to_eur` is `null` when the currency was unconfigured). 401 without a token,
403 for every other role (Portfolio Manager, Hub Planner, Executive Viewer, Auditor, Engineer), 404
when the code has no row, 422 for an unknown code or a bad rate.

Who may set: the existing rule (Admin **and** Super Admin, ADR 0010: Super Admin holds every Admin
right) is kept, because the Matrix FX editor (`fx-rate-editor.tsx`, P13-T14) already relies on it.
Making it Super Admin only is asked in OQ #50.

### Conversion with an unconfigured currency

`GET /priorities?currency=X`, `GET /priorities/{id}?currency=X` and `GET /exports/matrix?currency=X`
return **422** with `code: "CURRENCY_NOT_CONFIGURED"` when X has no row or a `null` rate:

```json
{"detail": "No exchange rate is configured for EGP. A Super Admin can set one under currency rates.",
 "code": "CURRENCY_NOT_CONFIGURED"}
```

The rate is resolved before any project is read; nothing falls back to EUR. `GET /exports/matrix`
with an unknown code is now 422 (was an unhandled error). Financial fields are unchanged:
encrypted at rest, never logged, served on matrix rows as before (not on compare, not on
distribution).

## 2. Score 0 (ADR 0033)

`PUT /priorities/{project_id}` (`PriorityScoreUpdateRequest`) and the scenario-apply score changes
(`ScenarioPriorityScoreChange`) accept each of the 13 scores as an integer **0..5** (422 outside).
`points = score / 5 × weight` (0 earns 0), `normalized_pct = round(Σ points / 295 × 100)`, bands
unchanged. Stored scores are unchanged (all are 1..5), so nothing is rescored or recalculated.

Worked example: scores `5,0,3,0,1,5,0,2,4,0,5,0,3` → points `25,0,15,0,5,25,0,10,20,0,25,0,9` →
`weighted_score 134`, `normalized_pct 45`, `suggested_band "P3"`. All zeros → `0`, `0`, `"P4"`.

## 3. `dimension_scores` on matrix rows

`GET /priorities` and `GET /priorities/{id}` rows (`PriorityMatrixRow`) gain a **required**
`dimension_scores: DimensionScore[]`, always 13 entries in the positional order of
`GET /priorities/dimensions` (strategic_project … capex_investment).

```ts
interface DimensionScore {
  key: string;            // e.g. "profitability"
  label: string;          // e.g. "ROI"
  pillar: string;         // e.g. "Investment & Feasibility"
  score: number | null;   // 0..5; null when the project is unscored
  weight: number;         // raw weight (25 or 15)
  points: number | null;  // score / 5 × weight, 2 dp; null when unscored
  max_points: number;     // = weight (the points at score 5)
}
```

`points` and `max_points` are on the raw scale, so `Σ points === weighted_score` exactly (every
weight is a multiple of 5). The scaled-to-100 figures stay where they were: per-dimension
`dimension_points[key].scaled_points`, per-dimension `scaled_weight` on `GET /priorities/dimensions`,
and the row total `normalized_pct`. Not financial: visible to every role with Matrix read (Portfolio
Manager, Hub Planner (own hubs), Executive Viewer, Admin, Super Admin). Exports skip this nested list
(the 13 flat scores are already columns).

## 4. `GET /priorities/distribution`

Matrix read permission. Query: exactly the filters of `GET /priorities` — `hub_id`, `region`,
`category`, `type`, `status_`, `q` — ANDed with the caller's hub scope (a hub filter never widens it).
`total_projects` always equals the length of `GET /priorities` with the same query.

```json
{
  "total_projects": 8,
  "scored_projects": 6,
  "band_distribution": [
    {"band": "P1", "count": 2, "share_pct": 25.0},
    {"band": "P2", "count": 1, "share_pct": 12.5},
    {"band": "P3", "count": 1, "share_pct": 12.5},
    {"band": "P4", "count": 2, "share_pct": 25.0},
    {"band": "Q", "count": 0, "share_pct": 0.0},
    {"band": "Unscored", "count": 2, "share_pct": 25.0}
  ],
  "score_histogram": [
    {"bucket_from": 0, "bucket_to": 10, "count": 1},
    "… 10 buckets …",
    {"bucket_from": 90, "bucket_to": 100, "count": 1}
  ]
}
```

- `band_distribution`: always the six buckets in this order. A band is the stored `suggested_band`;
  no score → `"Unscored"`. `"Q"` is a committed priority, never a score band, so its count is always
  0 under the current rules (listed for a stable legend). `share_pct = round(count × 100 /
  total_projects, 2)`, `0.0` when there are no rows. Shares are rounded independently, so their sum
  may differ from 100 by a few hundredths.
- `score_histogram`: always 10 buckets of `normalized_pct` over **scored** projects only;
  `[bucket_from, bucket_to)` except the last, `[90, 100]`, which includes 100. Σ count =
  `scored_projects`.
- Schemas: `PriorityDistribution`, `BandShare`, `ScoreHistogramBucket`. No financial field is read.

## 5. `GET /priorities/compare?project_id=…&project_id=…`

Matrix read permission. 2 to 5 **distinct** project ids (repeat the `project_id` query parameter).
Response `PriorityCompareResponse`, projects in the order given:

```json
{"projects": [
  {"project_id": "…", "project_name": "…", "hub": "R&D-Greece", "set_priority": "P2",
   "has_score": true, "weighted_score": 134.0, "normalized_pct": 45, "suggested_band": "P3",
   "dimension_scores": [ /* 13 × DimensionScore, as §3 */ ]}
]}
```

No financial fields (no currency, capex, RM savings, TCOGS, selling price, gross margin, customer).

Errors (422, coded):

| `code` | When |
|---|---|
| `COMPARE_COUNT` | fewer than 2 or more than 5 ids (0 ids is FastAPI's own 422, no `code`) |
| `COMPARE_DUPLICATE` | an id repeated |
| `COMPARE_PROJECT_UNAVAILABLE` | any id unknown **or** outside the caller's hub scope. Same body for both; it does not say which id, so existence is not revealed |

A malformed UUID is FastAPI's own 422.

## 6. Contract-test rows (`backend/tests/test_openapi_frontend_contract.py`)

TS interface names follow what P21-T02 had already declared in
`frontend/src/surfaces/matrix/api/types.ts`:

| TS (frontend) | Backend schema | Mode | Red until the frontend… |
|---|---|---|---|
| `PriorityMatrixRow` | `PriorityMatrixRow` | exact | removes `band`, `normalized_score`; makes `dimension_scores: DimensionScore[]` required |
| `DimensionScore` | `DimensionScore` | exact | (green) |
| `BandDistributionEntry` | `BandShare` | exact | (green) |
| `ScoreHistogramBucket` | `ScoreHistogramBucket` | exact | (green) |
| `PriorityDistribution` | `PriorityDistribution` | exact | adds `total_projects`, `scored_projects` |
| `PriorityCompareProject` | `PriorityCompareItem` | exact | replaces `band` / `normalized_score` with `suggested_band`, `normalized_pct`; adds `set_priority`, `has_score`, `weighted_score` |
| `PriorityCompareResponse` | `PriorityCompareResponse` | exact | (green) |
| `CurrencyOption` | `CurrencyRateRead` | subset | renames `code` → `currency_code` |
| `lib/api/reference.ts` `CurrencyRate` | `CurrencyRateRead` | exact (`test_currency_rate_mirror_p21`) | adds `name`, `configured`; `rate_to_eur: number \| null` |

## 7. Migration

`p21a_currencies_score_zero` (head, revises `p20a_run_step_span_fte`): adds `EGP`, `ZAR`, `IDR` to
the `currency_code` enum; `currency_rates.rate_to_eur` nullable; on an already-seeded rates table
inserts the three rows with a `null` rate (an empty table is left for `seed.seed_currency_rates`,
which now seeds six rows); the 13 `priority_scores` CHECK constraints become `BETWEEN 0 AND 5`.
Downgrade reverses all but the enum values.
