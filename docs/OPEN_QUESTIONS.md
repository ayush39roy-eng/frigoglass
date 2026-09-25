# Open Questions

Numbered. Each entry: the question, why it matters, what we're assuming until answered, and who
must answer it. These go to the client before P1 starts.

**Status note (2026-08-29):** The project owner has directed the team to proceed past P0 on the
stated default assumptions below rather than block on formal client sign-off, with the explicit
understanding that these are revisited once real answers arrive. See the `docs/MEMORY.md` entry
for this decision. Questions #2, #3, #5 additionally now have ADRs (`docs/ADR/0002`, `0003`,
`0004`) recording the provisional decision and what changes if the eventual answer differs.
Question #8 (GDPR) remains hard-blocking for P4-T08 specifically — provisional-proceed does not
apply to it, since it requires an actual DPO determination, not an engineering default.

---

### 1. Are the 14 steps strictly sequential, or is there a real precedence DAG with parallel branches?

**Why it matters:** Determines whether the scheduler models a simple chain (current
`docs/DOMAIN_RULES.md` Invariant I3) or needs a general precedence graph — a materially different
implementation in P2.

**Assuming until answered:** Strictly sequential, per Invariant I3.

**Who must answer:** Client (product/process owner).

---

### 2. Should FTE gate scheduling throughput? (0.5 FTE = half-speed, or half the available weeks?)

**Why it matters:** The prototype has a known defect here — Capacity Planning reports FTE-scaled
capacity but the scheduler ignores FTE entirely. This is a real behavioural divergence, not just
cosmetic.

**Assuming until answered:** FTE is not applied in scheduling (matches prototype defect #1 in
DOMAIN_RULES.md), pending an ADR either way.

**Who must answer:** Client + orchestrator (needs an ADR regardless of the answer).

---

### 3. Do chamber `efficiency` and `weeks_per_chamber` constrain booking, or are they reporting-only?

**Why it matters:** Prototype defect #2 — these fields are currently display-only; only `max`
concurrent gates booking. If they should constrain booking, the booking rule in DOMAIN_RULES.md
changes.

**Assuming until answered:** Reporting-only, matching current prototype behaviour.

**Who must answer:** Client (capacity planning process owner).

---

### 4. Working calendars per hub — Greek, Indian and Romanian holidays differ substantially.

**Why it matters:** Week-based scheduling assumes uniform working weeks. Real holiday calendars
would shift effective capacity per hub per week.

**Assuming until answered:** No holiday calendar adjustment; all hubs use uniform 7-day/week
buckets for v1.

**Who must answer:** Client (HR/hub leads per region).

---

### 5. Should delay propagate into downstream steps, or stay a terminal adjustment?

**Why it matters:** Prototype defect #3 — delay is currently applied once at the end
(`end + delay <= 52`) rather than pushed into downstream step start times. This changes whether a
delayed step pushes out every subsequent step in the same project.

**Assuming until answered:** Delay stays a terminal adjustment, matching current prototype
behaviour, pending an ADR either way.

**Who must answer:** Client + workflow-auditor (needs an ADR regardless of the answer).

---

### 6. What is the real horizon — the Gantt shows 2026–2027 but the logic caps at 78 weeks?

**Why it matters:** `HORIZON_WEEKS = 78` (~1.5 years) is shorter than a 2026–2027 display range
would imply (~104 weeks). Projects that would complete in year 2 under a longer horizon are
currently marked `LEFT_OUT`.

**Assuming until answered:** `HORIZON_WEEKS = 78`, per DOMAIN_RULES.md, exactly as extracted from
the prototype.

**Who must answer:** Client (portfolio planning owner).

---

### 7. Excel import/export contract — is the existing spreadsheet the system of record during transition?

**Why it matters:** Determines whether P5 (versioning/exports) needs a full round-trip-compatible
Excel format, or a one-way export only, and whether there's a cutover date after which the
spreadsheet is retired.

**Assuming until answered:** One-way export only (CSV/XLSX), no round-trip import contract, for v1.

**Who must answer:** Client (portfolio manager / IT).

---

### 8. GDPR: is per-engineer utilization personal data on EU employees (Greece, Romania)?

**Why it matters:** If yes, per-engineer utilization views/exports need a lawful basis, may require
DPO approval and works council consultation before P4 (design system + six surfaces) ships anything
showing named-engineer load.

**Scope extension (2026-09-08, Project Workspace / P8):** the same determination now also governs
(a) the display-only named engineer on the Project Workspace Progress panel, and (b) `@mention`
notifications and comment authorship, which attach an identified employee to a project record and
its activity feed. The withholding pattern from P3-T09 / P4-T08 applies to all of these until the
DPO signs off. **This is blocking for P8-T03's comment/@mention/named-engineer parts** as well as
for P4.

**Assuming until answered:** Treated as personal data requiring protection (encrypted at rest where
applicable, access-controlled, audit-logged) until the DPO confirms otherwise. **This is blocking
for P4 and for P8.**

**Who must answer:** Frigoglass DPO, with works council consultation as needed.

---

### 9. Which IdP, and can we get an app registration?

**Why it matters:** OIDC SSO integration (P6) is blocked without a concrete IdP target and app
registration/client credentials. `docs/PROJECT_AND_STACK.md` assumes Microsoft Entra ID with
Keycloak as fallback, but this needs confirmation and access before P6 can start.

**Assuming until answered:** Microsoft Entra ID as primary target; Keycloak as local/dev fallback
only.

**Who must answer:** Client IT/security team.

---

### 10. Should CP-SAT's optimizer be allowed to drop a schedulable P1 project entirely to lift other projects within-year?

**Why it matters:** Under ADR 0005's provisional objective (`band_weight × within_year`, summed over
outcomes), CP-SAT can score a P1 project exactly 0 whether it schedules it or not once that project
cannot finish within the year under any solver's contention profile — so reclaiming its engineer/
chamber capacity to lift other projects into within-year is a strict objective gain, not a bug.
Confirmed live on the real 46-project seed dataset: CP-SAT returns `left_out=True, steps=()` for
project `26-00201` (P1, category A, hub PD-India, customer Coca-Cola, hard-gated on "Customer
certification at risk (Coke/Pepsi)") while the greedy scheduler schedules the same project (all 14
steps booked, completing week 58, `spillover=True`). Both are invariant-clean (0 violations,
I1–I10) and both are correct implementations of their respective algorithms — this is ADR 0005
working exactly as specified, not a port bug. But "the optimizer silently produces zero scheduled
steps for a customer-certification-at-risk P1" is a materially different, more concerning UX than
greedy's "scheduled but late," and reaches an actual user for the first time in P4-T07 (Capacity
Planning's "Auto-assign," the first feature that would expose a CP-SAT-optimized schedule).
Identified by `algorithm-engineer` (P2-T07), reconfirmed by `rpd-orchestrator` and independently
re-derived and adjudicated by `workflow-auditor` (P2-T10) — see the P2-T07/T08/T10 `docs/MEMORY.md`
entries for full detail.

**Assuming until answered:** No change to ADR 0005's objective for P2 (already gated and closed).
This question is **blocking specifically for P4-T07** (Auto-assign), not for any task before it —
CP-SAT must not be wired into a user-facing "Auto-assign" action until this is resolved. Options on
the table, per P2-T07's review: (a) accept the behaviour, surfaced clearly in the UI (e.g. an
explicit "left out" reason distinguishing "infeasible" from "deprioritized for portfolio gain"); (b)
add a secondary objective term that still rewards scheduling high-priority-band projects even when
they land in spillover; (c) a soft or hard constraint that frozen/P1 (or hard-gated) projects are
always scheduled when feasible, even at the cost of the primary within-year objective. Whichever way
this is answered, it supersedes ADR 0005 via a new ADR — ADR 0005 itself documents this exact class
of outcome as a known, provisional consequence pending client resolution.

**Who must answer:** Client (portfolio/commercial owner — this is fundamentally "is it acceptable for
the system to deprioritize a customer-certification-at-risk P1 project for portfolio-level gain,
and if not, how should the trade-off be made instead").
