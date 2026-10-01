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

**Update 2026-09-27:** the client has said *some* steps can run in parallel and asked for an
option to set which. ADR 0009 makes precedence a configurable DAG (Workflow Settings, Super Admin)
with the strict chain as the seeded default. Still open: which pairs Frigoglass actually wants
parallel by default — see #17.

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

**Update 2026-09-27:** answered by the client workbook for the *capacity supply* side — platform
count × efficiency × (52 − holidays − maintenance − breakdown − calibration) is the chamber's yearly
lab-week capacity (ADR 0008, `docs/CLIENT_FORMULAS.md` §2.2). `weeks_per_chamber` is retired.
Whether downtime/efficiency should also gate week-level *booking* remains open (ADR 0002/0003
booking behaviour unchanged).

---

### 4. Working calendars per hub — Greek, Indian and Romanian holidays differ substantially.

**Why it matters:** Week-based scheduling assumes uniform working weeks. Real holiday calendars
would shift effective capacity per hub per week.

**Assuming until answered:** No holiday calendar adjustment; all hubs use uniform 7-day/week
buckets for v1.

**Who must answer:** Client (HR/hub leads per region).

**Update 2026-09-27:** the client workbook supplies per-hub calendars (weekdays per week, national
holiday / medical / casual / annual leave days) and uses them for yearly capacity (ADR 0008). They
are now a `HubWorkCalendar` table feeding the Capacity surface. They still do not shift individual
week buckets in the scheduler.

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

---

## Added 2026-09-27 — from the client formula workbook and the feature requests of that day

### 11. Prioritization matrix — band rule vs the deck's own example

**Why it matters:** The deck (slide 4) scores an example project 103 weighted points and labels it
"Priority 1". Under the band rule we implement (`normalised_pct = weighted / 1400 × 100`; ≥70 → P1,
≥55 → P2, ≥40 → P3), 103 points is 7% → P4. Either the example is a stale mock-up or the bands are
meant on a different scale (e.g. raw points, or only the dimensions actually scored).

**Assuming until answered:** The 70/55/40 percentage bands as implemented (P4-T04), hard gates
override to P1.

**Who must answer:** Client (portfolio owner).

### 12. Which per-project design/lab man-week figure drives load?

**Why it matters:** `Final RPD` holds two different per-category numbers — the process-derived sum
of lead times (design 22/18/8/4, lab 12/10/6/1) and a hand-entered "Man Weeks/Project" (design
19/15/4/3, lab 16/14/10/2) — and the capacity pivot's per-project values match neither (e.g. Greece
A+ = 30), so the source sheet enters them per project.

**Assuming until answered:** The schedule and the "process-derived" load use the lead-time table;
an optional per-project `estimated_design_weeks` / `estimated_lab_weeks` feeds a second "Estimated"
column, exactly as the workbook shows both side by side.

**Who must answer:** Client (RPD process owner).

### 13. Design-time formula for B and C categories

**Why it matters:** The A+/A design-time formula counts Marketing Brief (A) and Pr. Pr (J); the B and
C formulas omit them although both are 1 week for B and C. Either B/C projects genuinely need no
engineer for those weeks, or the formula is inconsistent.

**Assuming until answered:** A and J are engineer-booked design steps for every category
(ADR 0007). Impact if wrong: 2 man-weeks per B project, 1 per C.

**Who must answer:** Client.

### 14. OEM workflow — which steps book an engineer, a chamber, or nothing?

**Why it matters:** The OEM lead-time rows have no design/lab split formula.

**Assuming until answered:** By analogous name — design = OEM-A, B, D, G, I, J, K, M; lab = OEM-E,
H; elapsed = OEM-C, F, L, N (ADR 0007). Also assumed: OEM categories rank after C in scheduling
order (`A+ → A → B → C → A-OEM → B-OEM → C-OEM`).

**Who must answer:** Client (OEM programme owner).

### 15. Lab consumption per project-week

**Why it matters:** The prototype charged 0.5 chamber-units per project-week; the client's load is a
plain sum of lab weeks against platform-weeks of supply.

**Assuming until answered:** 1.0 platform-week per project-week (ADR 0007). Capacity numbers on the
surface change accordingly.

**Who must answer:** Client (lab manager).

### 16. Workbook inconsistencies to confirm as errors

`docs/CLIENT_FORMULAS.md` §2.4 lists them: Greece/Romania lab-load cells summing design weeks;
Greece/Romania using India's remaining-year fraction; India dividing medical leave by 5 but other
leave by 6; India lab holidays 13/5 with 6 weekdays; current week 15 vs 17 in one workbook. Also, every chamber uses 13/5 = 2.6 holiday weeks while Greece's engineer calendar has 12 national-holiday days (12/5 = 2.4). Under ADR 0008 chamber holiday weeks come from the region's calendar, so Greece lab capacity is 73.34 (workbook 72.96) and India 188.30 (workbook 186.22); found by workflow-auditor at the P9 gate.

**Assuming until answered:** All are errors; ADR 0008's normalised formulas apply.

**Who must answer:** Client (workbook owner — "Gahlot Sachin" per the cell comments).

### 17. Which workflow steps should be parallel by default?

**Assuming until answered:** Strict chain seeded; the client configures pairs on Workflow Settings.
Likely candidates from the step semantics: Certification (H) ∥ TF-1 (I) / Pr. Pr (J); Online CAPEX
approval (G) ∥ Proof of Concept (F). A per-project override of the DAG is not offered.

**Who must answer:** Client (RPD process owner).

### 18. Super Admin vs Admin

**Assuming until answered:** Super Admin = every right, sole manager of admin roles and Workflow
Settings; Admin = the existing matrix row plus read on Workflow Settings (ADR 0010).

**Who must answer:** Client IT / application owner.

### 19. "Expected completion" on the Gantt

**Why it matters:** The client asked for two lines per project — "expected completion" and "will be
completed" — in different colours.

**Assuming until answered:** *Expected* = the project's entered target end week (`Project End Date
- LATEST` in the charter; `target_end_week`, editable on Registration and the Workspace), falling
back to the unconstrained process-derived finish (start + critical path of lead times, ignoring
resource contention) when no target is entered. *Will be completed* = the active run's projected
finish (`last_step_end + delay`, ADR 0004). Both are served by the API, never computed in the
browser (I16).

**Who must answer:** Client — confirm the fallback and whether they want a calendar date rather than
a week number.

### 20. Current week

**Why it matters:** `CURRENT_WEEK = 31` is a constant; the workbook uses 15 (India) and 17
(Greece/Romania) in the same file. A live system should derive the current ISO week from the date.

**Assuming until answered:** One global `CURRENT_WEEK`, still a configured constant for v1.

**Who must answer:** Client + orchestrator (an ADR is needed either way before it becomes live).

### 21. Safety certification

**Why it matters:** The workbook counts "Safety Certification Required" per project and has an
empty "Safety Time" column. It is unclear whether safety certification adds lead time, needs a
separate resource, or is a flag only.

**Assuming until answered:** Flag only; no scheduling effect.

**Who must answer:** Client (certification lead).

### 22. Charter fields not yet in Project Registration

Product Type (ICM/HA/VF/CF/Other), Requesting Department, Plant/OEM, Part of "IMPACT", Marketing
Brief Yes/No, Testing Required (POC/Performance/Energy/Comparison/Reliability), Project Status
"Cancelled" and "Delayed".

**Assuming until answered:** `Cancelled` is added as a non-schedulable status now (cheap, clearly
needed); the rest wait for the client to say which are required at registration.

**Who must answer:** Client (portfolio manager).

## Added 2026-09-30 — from the project owner's access-control and "Ask the agent" request

### 23. External LLM API for "Ask the agent" — Groq, for now

**Why it matters:** this application is delivered on-premise, behind Frigoglass's corporate
network, explicitly not a SaaS product (`CLAUDE.md`). "Ask the agent" (ADR 0014) sends a
redacted context (never financial fields, never real engineer names) about one project to Groq, a
third-party, US-hosted inference API, to answer a free-text question. That is a real departure
from the on-premise posture, even with the redaction — the question and the non-financial context
still leave the corporate network.

**Assuming until answered:** built and enabled for the dev/demo environment now, at the project
owner's explicit instruction ("we can use groq api key for that now"). Ships **off** (503
`AGENT_UNAVAILABLE`) unless `RPD_GROQ_API_KEY` is explicitly configured, so no environment calls
out to Groq unless someone deliberately turns it on. Not assumed to be the production default.

**Who must answer:** the client (whoever owns the on-premise/data-residency posture — likely IT
security, the same audience as OQ #9). Is Groq (or any third-party API) acceptable for production,
or does "Ask the agent" need a self-hosted/on-premise model instead once it ships for real users.
