# ADR 0050: Every filter is multi-select; the hub and country filters are a union

## Status

Accepted (2026-11-13) by owner ask. Amends ADR 0020 §1 and §3 (one hub → a list of hubs) and ADR
0025 §1 and §2 (one country, mutually exclusive with the hub, ANDed → a list of countries, UNIONED
with the hubs). RBAC hub scoping is unchanged. No scheduler change. Contract:
`docs/API_CONTRACT_MULTISELECT.md`.

## Context

The owner, relaying the client on 2026-11-13:

> everywhere we have a filter there we should have option to select multiple hub also and multiple
> leader multiple status. simple make all the filters multiple select.

P31 already made `category` and `type` repeatable. Every other filter still took one value: the
global hub filter (`hub_id`, ADR 0020), the country filter (`region`, ADR 0025), and the per-surface
filters `status_`, `priority`, `leader_engineer_id`, `current_step`, the check-in history's
`step_id`, and the audit log's `action`, `entity_type`, `actor_user_id` and `hub_id`.

ADR 0025 ANDed `hub_id` with `region`. The UI never sent both, because picking a country cleared the
hub. With multi-select, a choice such as "India + R&D-Greece" has to mean both. Under AND it would
mean nothing.

## Decision

1. **Wire format.** Every filter query parameter is repeatable and keeps its name (`?hub_id=a&hub_id=b`,
   `?status_=In%20Queue&status_=On%20Hold`). One value is still valid, so old clients and
   bookmarks keep working. An absent or empty parameter means no filter.
   - Within one parameter, values are ORed (`IN`).
   - Different parameters are ANDed.
   - Each value is validated as the single value was: an unknown enum value, a malformed UUID, or a
     step code over 10 characters gives a 422.
   - A parameter is capped at 50 values. More than that gives a 422.
   - The declarations live in `api/query_params.py`.
2. **Hub and country are a union, inside the scope.** The project set is:

   ```
   scope AND (hub ∈ hub_id OR hub.lab_region ∈ region)
   ```

   - The RBAC scope is always ANDed onto the whole union. A requested hub or country outside the
     caller's scope therefore adds nothing.
   - A list made only of out-of-scope values gives empty rows and zero totals. It never gives a 403,
     and it never widens the scope. This is ADR 0020 §3's rule, applied to each value.
   - The rule lives in one place: `services/hub_scope.py`. `global_hub_filter`,
     `narrowed_hub_filter` and `narrowed_lab_regions` take sequences, and every router passes its
     lists through.
3. **Capacity lab regions.** `narrowed_lab_regions` returns:

   ```
   scoped regions ∩ (regions of the chosen in-scope hubs ∪ chosen regions)
   ```

   Lab figures stay region-wide (ADR 0020 §4).
4. **Capacity rows.** A capacity-hub row is shown when any of its hubs is in the filtered set (ADR
   0042 §8, unchanged).
   - With hubs requested, the members breakdown lists all of the row's in-scope hubs.
   - `selected_member` stays a single field. It names the first requested hub that is in the row.
5. **Engineer lists** (`engineer_hub_filter`, P30-R01). Each requested hub is checked against the
   scope before the member → capacity-hub resolution.
   - Out-of-scope hubs are dropped.
   - If every requested hub is out of scope and no country is requested, the list is empty.
6. **Exports mirror the screens.** Each export takes the same lists as the screen it exports.
   - A stored export job keeps one value as a bare string, so the job shape before this ADR is
     unchanged.
   - Several values are stored as a list. This is the P31 `stored_filter` convention.
7. **Read-audit rows.** Two endpoints write a coalesced read-audit row: the engineer-utilization
   read and the resource-load read.
   - They record a list filter as its sorted values.
   - The single `hub_id` FK column names a hub only when exactly one existing hub was requested.
8. **Not filters.** Sort, view toggles, zoom, `limit` / `offset`, `basis`, the VIP `year` and the
   audit log's `entity_id` (a specific row) stay single-valued.
9. **Frontend.** The frontend changes are in `docs/API_CONTRACT_MULTISELECT.md` §3. The Matrix
   surface's own filters are out of scope for this pass.

## Consequences

- **Wider results under the old pair.** A request with both `hub_id` and `region` now returns a
  wider set than before. The shipped UI never sent both, so no screen changes.
- **I23 per value.** For every hub `h` in scope, the I23 reconciliation still holds for `h`. For a
  list it holds for the union, because every Dashboard total is a count over the filtered set.
- **Echoed filters are lists.** `GET /planning/resource-load` returns `filters_applied.hub_id` and
  `.region` as lists, sorted and de-duplicated, like the other echoed filters. The frontend type
  `ResourceLoadFiltersApplied` changes to match.
- **Check-in history.** `GET /check-ins/history` with several `step_id`s returns the stages'
  check-ins merged, newest first, with up to 52 rows per requested stage. The row schema has no
  `step_id`, so the frontend should request one stage at a time when it needs to tell the stages
  apart.
