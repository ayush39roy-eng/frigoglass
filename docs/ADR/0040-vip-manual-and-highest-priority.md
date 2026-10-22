# ADR 0040 — VIP is a manual pin, and VIP projects schedule first

Date: 2026-10-22. Status: Accepted. Supersedes in part ADR 0022 ("VIP never changes scheduling
order") and the ADR 0027 amendment ("a link on a highlighted VIP item sets `projects.is_vip`").

## Context

On the dev data, 39 projects were VIP, 28 of them because one India VIP board bullet ("BEE 5-star
labelling…") links the whole BEE programme. The owner ruled (2026-10-22): "I will add the VIP
projects manually. For now don't keep any VIP. Give an option to add to VIP in Projects and the
Prioritisation Matrix, and the VIP project will have highest priority."

## Decision

1. **Manual only.** `projects.is_vip` changes only through `PUT /projects/{id}/vip` (audited,
   Project Registration write, hub admin grant, as today). Linking a project to a VIP board item
   (`vip_item_projects`, highlighted or not) no longer sets or clears `is_vip`. The links stay, as
   references on the board.
2. **Reset.** Every current `is_vip` is cleared once on the dev DB (owner ruling). The seed sets no
   VIP.
3. **Highest priority in scheduling.** The scheduling order (DOMAIN_RULES "Scheduling order")
   becomes:
   1. `frozen` descending (dates locked, unchanged)
   2. **`is_vip` descending** (new)
   3. Priority `P1 → P2 → P3 → P4 → Q`
   4. Status
   5. Category

   A VIP project is therefore placed before every non-VIP project, whatever its band. The CP-SAT
   model follows the same rule: its within-year objective weighs a VIP project at its band weight
   plus a bonus of (sum of every non-VIP band weight + 1), so one VIP finishing in the year outweighs
   any mix of non-VIP projects (`cp_sat.objective_weights`). With no VIP the weights are the plain
   band weights. Its
   committed priority and score band are not rewritten. VIP outranks priority only in the
   scheduler's sort and in list order.
4. **A pin is a scheduling input.** Pinning or unpinning marks the schedule stale and follows the
   same recalculation path as a committed-priority change (P11 priority move). It is no longer a
   "never recalculates" display flag.
5. **Lists.** The Matrix scoring grid and the Projects page list VIP projects first, each group in
   its own order, and both offer the pin toggle and a VIP filter.

## Consequences

- The golden files and the I1–I10 invariants still hold. Only the sort key gains a term, and with
  no VIP the schedule is byte-identical to before.
- The VIP board (Dashboard) still shows its items and links. Its "VIP" counts now mean manual pins.
- DOMAIN_RULES "Scheduling order" and "VIP projects" are amended accordingly.
