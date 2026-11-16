# API contract P36 — rank within a priority band (ADR 0050, R36-1..R36-10)

Binding for P36-T03 (backend) and P36-T04 (frontend). Orchestrator, 2026-11-15.

## 1. `GET /priority-board` (changed)

- Each card gains `band_rank: int | null` and `frozen: bool`.
- Cards in a column are sorted by `band_rank` asc (null last), then status ordinal, category rank
  (from the `categories` table), `project_id` — scheduling keys 3a–5 + id. The browser never re-sorts.
- Filters never change a served `band_rank` (it is the position in the full band).
- Column `count` / weeks unchanged.

## 2. `POST /projects/{id}/band-rank/preview`

Body:
```json
{ "before_project_id": "uuid | null", "after_project_id": "uuid | null" }
```
At most one is non-null; both null = move to last in the band. Placement: directly before / after
that project in the full band; all other projects keep their relative order.

Response: **the same `PriorityPreviewResponse` shape as `POST /projects/{id}/priority/preview`**
(`result`, `preview_token`, `summary`, `changes`, …). `result = "unchanged"` when the placement
leaves the order as it is. The token covers the band's ranks (I37d).

Errors: 403 (RBAC / hub scope — same as the priority move), 404, 409 `NOT_RANKABLE` (no priority or
non-schedulable status), 422 `NOT_SAME_BAND` (anchor not ranked in the same band, or is the project
itself), 422 `BOTH_ANCHORS` (both given), 429 as the priority preview.

## 3. `POST /projects/{id}/band-rank`

Body: the §2 body plus `"preview_token": "string"`. Response: **the same `PriorityMoveResponse`
shape as `POST /projects/{id}/priority`**, plus `X-Schedule-Recalc` / `X-Schedule-Run-Id` / `X-Schedule-Baseline-Run-Id` (PATCH rules; band-rank only, the priority POST sends none) (`recalc_status`, run id, …).
409 `PREVIEW_STALE` on a stale token (the frontend re-previews once, as for the priority move).
Audit `project.band_rank_move` `{band, from_rank, to_rank, before_project_id, after_project_id}`.
Recalc: the priority move's auto-recalc dispatch (greedy).

## 4. RBAC

Registration write + hub scope on the moved project; the anchor must also be in the caller's scope
(else 422 `NOT_SAME_BAND`, no existence leak). A hard-gated P1 project may be re-ranked within P1.

## 5. `503 BAND_RANK_BUSY` (P36-R01, security M-1)

Every write that may change a band rank takes one global band-rank lock: `POST /projects`,
`PATCH /projects/{id}` with `status` or `priority` in the body, `POST /projects/{id}/priority`
(plain and confirm), `POST /projects/{id}/band-rank`, `POST /projects/register-edits`,
`POST /projects/{id}/submit`. It is taken only **after** the project lookup (404), authorisation
(403) and rate limit (429), so those answers never wait on it; then the project is re-read and its
scope / permission re-checked under the lock (an out-of-scope result is the usual 404 / 403).

The wait is bounded (`lock_timeout` 5 s, transaction-local, restored once granted). On timeout:
`503` with `Retry-After: 5`, body `{"code": "BAND_RANK_BUSY", "detail": "Another priority change
is being saved. Please try again in a moment."}`; nothing was written (the transaction is rolled
back). Clients show the message and let the user retry; do not auto-retry a confirm with the same
token more than once (re-preview instead if the retry answers 409 `PREVIEW_STALE`).

## 6. Amendment 2026-11-17 — `to_rank` (arrow buttons / typed position)

Owner ask 2026-11-17. Additive; anchor bodies and their tokens are unchanged.

Body of §2 (and §3, plus `preview_token`) gains an alternative to the anchors:
```json
{ "to_rank": 3 }
```
- `to_rank: int | null` (JSON integer, strict: no string, no bool) = the target position **1..n in the
  full band** (the same numbering as the card's `band_rank`, not a filtered / scoped position).
- Placement: the project ends at exactly `to_rank`; every other member keeps its relative order
  (I37c). Server-side it resolves to the equivalent anchor placement (rank n = last; otherwise
  "before the member now at that slot once the project is lifted out"), so a scoped caller may land
  next to a project outside its hub scope without naming it.
- Resolution order (P36-R01 kept): lookup 404 → authz 403 → rate limit 429 → (confirm only) the
  global band-rank lock + re-read + scope re-check → `ANCHOR_AND_RANK` → `NOT_RANKABLE` → `BAD_RANK`
  → placement. The confirm resolves `to_rank` against the band read under the lock.
- `to_rank` equal to the current rank → `result = "unchanged"` (preview, no token) /
  `recalc_status = "unchanged"` (confirm, nothing written).
- Errors: 422 `ANCHOR_AND_RANK` when `to_rank` is given with `before_project_id` or
  `after_project_id`; 422 `BAD_RANK` when `to_rank` is outside 1..n. **No clamping**: a typed 0 or
  n+1 is refused, not silently moved to first / last. The `BAD_RANK` message never states n.
- Token: binds `to_rank` as well as the resolved placement. Confirm with the same body (`to_rank` +
  `preview_token`); confirming a `to_rank` preview with the equivalent anchor body (or vice versa)
  is 409 `PREVIEW_STALE`, as is any band change since the preview (re-preview once, as today).
- Responses unchanged: **no band-size field is added** (P36-R02: never reveal "of M").
- Audit `project.band_rank_move`: `before_project_id` / `after_project_id` as sent (null) plus
  `requested_rank`; `to_rank` (the resulting rank) as before.
