# ADR 0028: Per-engineer utilization (Engineers × Weeks) and leader names are enabled

## Status

Accepted (2026-10-19), by the project owner. Part of P15. Resolves OQ #8 for building purposes and
lifts the P4-T08 hold. `backend/scheduling/` is not touched.

## Context

OQ #8 treated per-engineer utilization and identified engineers as GDPR personal data, so P4-T08
(the Capacity "Engineers × Weeks" view) was withheld. P13 also withholds `leader_name` unless the
caller is the leader. On 2026-10-19 the owner, relaying the client, said: "you can use the personal
data, it is not a problem, start this now", with the Capacity placeholder "Per-engineer utilization
pending GDPR sign-off" in view.

## Decision

1. **Build the Engineers × Weeks heatmap** on Capacity (P4-T08), replacing the placeholder.
   - Served by a new endpoint, `GET /capacity/engineer-utilization`.
   - Per engineer and per week W1–52: booked weeks (from the active run), capacity weeks and
     utilization %. All figures are computed server-side (I9). The load basis is the same as the
     hub design load (I6).
   - Hub-scoped (ADR 0020 / 0025 filters apply). Permission: `CAPACITY` READ.
2. **Leader names are shown** to every caller who can read the project: Dashboard register,
   Gantt, Matrix, Priority board and Workspace. The P13 withholding is removed.
   Exports include the leader name. The OQ #8 addendum is resolved.
3. **Unchanged safeguards.**
   - Access is RBAC-scoped to hub; no cross-scope leakage (I23).
   - An Engineer-role user sees only their own row.
   - Every read of the per-engineer endpoint is audit-logged as `capacity.engineer_utilization.read`
     (the caller, the filters and the row count, never the figures).
   - Financial fields stay out of these payloads.

## Consequences

- This is an owner decision. A formal DPO sign-off and works council consultation (Greece, Romania)
  were the original condition. They are recorded as an **accepted residual risk**, not done.
  OQ #8 stays open as a confirmation, no longer blocking.
- Reversible: withholding and the placeholder can be restored by a flag-level change.

## Amendment (2026-10-19, P15 gate)

- **Engineer role.** The plain Engineer role has no CAPACITY READ and gets 403 on the heatmap. The
  "own row only" scope applies only to an Engineer who also holds a role that can read Capacity.
  Opening the heatmap to the Engineer role would also open the rest of Capacity, so it is not done.
  This fails closed. Revisit if the client wants engineers to see their own load.
- **Priority board.** It has no leader field, so there is nothing to un-withhold there.
- **Booking basis.** The booked resource of a design step is the project's leader (DOMAIN_RULES).
  Six projects are led by an engineer from another hub. So by engineer hub the heatmap differs
  from the Capacity hub table (for example OEM-HCK about 137 % against 100.4 %). By project hub
  every figure reconciles, and so does the portfolio total. The heatmap carries a footnote saying so.
