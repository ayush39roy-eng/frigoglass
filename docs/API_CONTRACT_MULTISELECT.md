# API contract — multi-select filters (owner ask 2026-11-13)

Owner: "everywhere we have a filter there we should have option to select multiple hub also and
multiple leader multiple status. simple make all the filters multiple select."

## 1. Wire format (every filtered GET endpoint, and the exports)

Every filter query parameter becomes **repeatable**. The parameter NAMES do not change:

```
?hub_id=<uuid>&hub_id=<uuid>      ?region=India&region=Romania
?status_=In%20Queue&status_=On%20Hold
?priority=P1&priority=P2          ?leader_engineer_id=<uuid>&leader_engineer_id=<uuid>
?current_step=PDD-A&current_step=PDD-B
audit log: ?action=..&action=..  ?entity_type=..&entity_type=..  ?actor_user_id=..&actor_user_id=..
check-ins: ?step_id=..&step_id=..
```

- One value is still valid (old clients and bookmarks keep working).
- Omitted or empty = not filtered (as today).
- Values within ONE parameter are ORed. Different parameters are ANDed (as today).
- `category` / `type` are already repeatable on the Dashboard endpoints (P31). Make them repeatable
  everywhere else they exist, with the same "Unmapped" sentinel.
- Validation: each value is validated as the single value was (enum or uuid, 422 on a bad value). The
  list length is capped at 50 per parameter (422 above that).

## 2. The global hub / country filter (ADR 0020 / 0025, amended)

- `hub_id` (list) and `region` (list) are combined by **UNION**: a project is in view when its hub is
  in `hub_id` OR its hub's lab region is in `region`. (Today the UI never sends both, so there is no
  behaviour to preserve. With multi-select, "India + R&D-Greece" must mean both.)
- RBAC is unchanged and always ANDed: `scope AND (hub ∈ hub_id OR region ∈ region)`. A requested
  hub or region outside the caller's scope contributes nothing: empty rows, never a 403, never a wider
  scope. This is the same rule as today, applied per value.
- `services/hub_scope.py` is the one place this lives: `global_hub_filter`, `narrowed_hub_filter`,
  `narrowed_lab_regions` take sequences. Every router passes lists through.
- Capacity lab regions (`narrowed_lab_regions`) = scoped regions ∩ (regions of the chosen hubs ∪ the
  chosen regions).

## 3. Frontend

- Hub filter store (`stores/hub-filter.ts`): `hubIds: string[]` and `regions: LabRegion[]`, replacing
  `hubId` / `region`. Persisted state migrates (`version: 2`: a single id becomes `[id]`, null becomes
  `[]`). `toHubFilterParams` / `useHubFilterParams` emit lists. Query keys hold SORTED lists.
- The header filter (HubFilterSelect / HubFilterChip / CountrySegmented) becomes one multi-select:
  countries and their hubs (checkboxes), "All hubs" clears. The chip summarises it ("India +
  R&D-Greece", "3 hubs").
- Every filter dropdown that today picks one value becomes a multi-select dropdown (a shared component:
  a popover with checkboxes, search when there are more than 8 options, "All" = none selected, the
  trigger summarises the selection). This covers Status, Leader, Current step, Hub, Priority
  (including the Gantt priority tabs, which become toggles), and the Audit log action, entity and user.
- Sort, view toggles and zoom are not filters and stay single-choice.
- Out of scope for this pass: the Matrix surface's filters. They are being reworked concurrently (P35
  grid editing, `matrix/lib/text-filters.ts`), so change none of `src/surfaces/matrix/**`.
