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

## Added 2026-10-09 — from the client's change requests (priority move, booked %, On Hold)

### 24. Should edits other than priority also recalculate automatically?

**Why it matters:** ADR 0015 makes a priority move recalculate the timeline at once, as asked.
Every other input edit still only marks the plan stale until someone presses Recalculate (ADR
0006). That covers stage progress, status, category, leader and Workflow Settings. Two rules for
similar edits may surprise users.

**Assuming until answered:** only priority recalculates by itself.

**Who must answer:** the client (portfolio owner). Should status, category or leader changes also
recalculate by themselves? Stage progress is updated often, so it would trigger many runs.

### 25. What does "booked %" mean, and are 85 % / 100 % the right "near full" / "full" lines?

**Why it matters:** "Europe design booked 90 percent and lab 50 percent" can be read three ways:
- (a) **Planned work ÷ capacity** — what ADR 0016 builds. It is the inverse of the workbook's
  completion %, and can go above 100 % when over-booked.
- (b) **Share of the calendar the scheduler has already filled** — engineer-weeks and
  chamber-weeks booked in the active plan ÷ weeks available. This cannot go above 100 %.
- (c) **An input**: only 90 % of Europe's design time and 50 % of its lab time is available to
  R&D, because the rest is reserved for other work. The planner should then treat that capacity as
  full at those levels.

Reading (c) would change capacity, and possibly booking. (a) and (b) are reporting only.

**Assuming until answered:** (a), with near full from 85 % and full from 100 %. Thresholds are
constants (`domain_constants.BOOKING_NEAR_FULL_PCT`, `BOOKING_FULL_PCT`).

**Who must answer:** the client (whoever sent the 90 % / 50 % example). Is it a reading or a
setting? If a setting, is it per area or per hub, and should the scheduler respect it?

### 26. Area grouping — is OEM part of India?

**Why it matters:** ADR 0016 groups hubs by lab region:
- **Europe:** R&D-Greece and PD-Romania.
- **India:** R&D-India, PD-India, OEM-HCK and OEM-Seltek.

The OEM hubs land in India only because their testing uses India's chambers (DOMAIN_RULES lab-
region table). The workbook gives OEM hubs no design capacity. Their design load would therefore
raise India's design booked % with no matching capacity.

**Assuming until answered:** OEM is part of India.

**Who must answer:** the client. Should OEM be its own area, or be left out of the design figure?
Are there more areas coming (China, Indonesia, …)?

### 27. Dashboard "On Hold" tile — stage holds only, or also projects with status On Hold?

**Why it matters:** ADR 0017 relabels "Blocked" as "On Hold". The app already has a project
*status* "On Hold", which takes the whole project out of the plan. The Dashboard tile, formerly
"Blocked", counts projects held at a stage that are still in the plan. Projects with status On Hold
are listed separately as paused.

**Assuming until answered:** the tile counts stage holds only. Its caption reads "In the plan,
waiting at a stage".

**Who must answer:** the client. Should one "On Hold" number include both?

## Added 2026-10-10 — from the client's second change batch (Kanban, Gantt drag, hub filter, live tracking, VIP)

### 28. Priority board — does order *inside* a column matter?

**Answered 2026-10-10 by the project owner:** "do whatever suits" → column = priority, order inside a column by score (ADR 0018 as written).

**Why it matters:** ADR 0018 lets a planner drag a card between P1/P2/P3/P4/Q. Inside a column,
cards are sorted by weighted score. The scheduler has no manual rank within a priority, so dragging
a card up inside P2 would mean nothing.

**Assuming until answered:** column = priority only; order inside a column is by score.

**Who must answer:** the client. Do they want to rank projects inside P1 by hand (which would make
that rank a new scheduling input)?

### 29. Gantt drag — should it recalculate immediately?

**Answered 2026-10-10 by the project owner:** "calculate straight away" → ADR 0019 as written; rapid drags coalesce into one follow-up run (ADR 0023).

**Why it matters:** ADR 0019 makes a dragged step duration or start recalculate the whole timeline
straight away (like a priority move), so other projects can shift. The alternative is to drag
several steps and press "Recalculate" once.

**Assuming until answered:** recalculate on each drop (greedy), with "deferred" when a run is
already in flight.

**Who must answer:** the client. Also: should a dragged duration be visible to the hub that owns
the lead-time table as a deviation report?

### 30. Weekly check-in — a fixed weekly recalculation?

**Answered 2026-10-10 by the project owner:** "recalculate and do whatever you think is best" → each check-in batch recalculates, with one coalesced follow-up run (ADR 0023); no fixed weekly cron needed.

**Why it matters:** ADR 0021 keeps a check-in as "mark stale" (no run per submission). Planners
press Recalculate. A fixed weekly run (e.g. Monday 12:00 after check-ins close) would keep the
plan live without anyone pressing a button.

**Assuming until answered:** no automatic weekly run.

**Who must answer:** the client — and which weekday/time the check-in window closes.

### 31. "The project itself should move through it" — auto-advance?

**Answered 2026-10-10 (owner delegated):** no automatic stage advance; the plan itself moves forward on every run and missed reports show as Due/Overdue with "per plan" progress (ADR 0023 §5). Reopen if the client wants auto-advance.

**Why it matters:** we show "per plan" progress next to the reported % when nobody has checked in,
but we never write it into the stage, because a stage marked Done becomes fixed history (I11). The
other reading is that stages should auto-advance (start / complete) at week close when no engineer
reports.

**Assuming until answered:** display only; no auto-advance.

**Who must answer:** the client. If auto-advance is wanted: after how many missed weeks, and should
it ever mark a stage Done on its own?

### 32. VIP projects — curated, automatic, or both?

**Why it matters:** ADR 0022 shows pinned projects first, then fills to 15 by priority and score.
"Critical" might instead be a list leadership picks by hand, per year.

**Assuming until answered:** pins plus automatic fill; any Hub Planner (own hub) or Portfolio
Manager may pin; a pin is not per year.

**Who must answer:** the client. Who decides a VIP, is the list per year, 10 or 15, and should VIP
projects be scheduled ahead of others in the same priority?

### 33. Check-in reminders — in-app only, or email too?

**Answered 2026-10-10 (owner delegated):** in-app only for now (ADR 0023 §6); email still needs Frigoglass IT's SMTP relay.

**Why it matters:** the app shows a due count and Overdue chips. Email reminders need the
corporate SMTP relay (not configured on-premise yet).

**Assuming until answered:** in-app only.

**Who must answer:** Frigoglass IT (SMTP relay) and the client (reminder day/time).

### 34. Plant and Requesting Department — where does the data come from?

**Why it matters:** the client's mock-up "All active registered projects" table and its
"Project Registered By Plant" and "Requested By" charts use a project's **Plant** (Multiplant, SAF,
IND, ROM, OEM, Egypt…) and its **Requesting Department** (Central Procurement Group, Marketing/Sales,
Central R&D…). Neither is in our model, and the 2026 workbook import does not store Plant (MEMORY
2026-10-13 "Not mapped").

**Assuming until answered:** both columns are hidden. We do not invent values.

**Who must answer:** the client. Is Plant the workbook's "Plant" column, and is Requesting Dept a
fixed list? Should both become required fields on Project Registration?

### 35. Matrix financial columns — ROI, payback, annual RM savings: which formulas?

**Why it matters:** the mock-up Matrix shows ROI `(Margin 3Y − CapEx) / CapEx`, Payback
`CapEx / avg annual margin` and Annual RM savings `Vol × RM/unit`. We store `capex_keur` and
`rm_savings_keur`, but not volume, RM/unit or a 3-year margin. RM Category and Component Group are
not stored either.

**Assuming until answered:** columns not shown.

**Who must answer:** the client. Confirm the formulas and the source columns (the
"RM Saving.xlsx" in their old app).

### 36. "Apply & Save All", global undo, and saved baselines

**Why it matters:** their old app staged every edit in the browser and saved in one batch, with
named baselines to revert to. Ours saves each change on the server immediately, with an audit
record, and recalculates.

**Assuming until answered:** keep immediate saves. Versions & History lists schedule runs and
scenario versions read-only.

**Who must answer:** the client. Do they need named baselines with a one-click revert of the whole
portfolio?

### 37. Gantt 2026–2027 two-year view

**Why it matters:** the mock-up has a "2026-2027" toggle. On 2026-10-13 the client asked for the
52-week year only (ADR 0024).

**Assuming until answered:** 52 weeks only.

**Who must answer:** the client.

### 38. Delete project, Excel import with merge, Weeks/Days, Manage Tabs, AI question bar

**Why it matters:** these all appear in the old app.
- **Deletion:** destroys audit history.
- **Import:** needs a merge policy.
- **Days:** needs the man-days-per-week factor. The mock-up implies about 5.0, for example
  291 wks ≈ 1457 days.
- **Manage Tabs:** per-user tab renaming conflicts with RBAC-driven navigation.
- **AI question bar:** portfolio-wide questions go beyond the per-project "Ask the agent".

**Assuming until answered:** none built. "Days" uses 5 days/week once confirmed.

**Who must answer:** the client.

**OQ #8 addendum (2026-10-19, P13 gate):** P13 withholds leader names unless the viewer is the
leader. It still serves `leader_engineer_id`, so Portfolio Manager, Hub Planner and Admin can map
an id to a name through `GET /engineers`. Registration already allows this. The DPO should confirm
whether showing leader names to these roles, as the client's mock-up does, is acceptable. If it is,
withholding can be relaxed for them.

### 39. VIP board: areas and meaning of highlights *(2026-10-19, P14, ADR 0027) — ANSWERED 2026-10-19: yellow = VIP; areas are Greece / India / Romania (ADR 0027 amendment)*

We built VIP as three areas, one per slide sent: **OEM** (OEM-HCK, OEM-Seltek), **Europe**
(R&D-Greece, PD-Romania) and **India** (PD-India, R&D-India). Please confirm:

1. Is that the grouping you mean by "2–3 VIP per hub", or do you want one tile per hub (six)?
2. Does a yellow highlight on the slide mean "VIP"? We show highlighted items with an accent and
   all other items plainly.
3. Many items are themes, not one project. Examples are "IC2-40 Coke Certification", "Family
   Fridge" and "ERX 3.0". We linked an item to a project only where the name clearly matched. Who
   should maintain these links? Today that is Portfolio Manager and Admin.

### 40. Freezing a project that never started *(2026-10-19, P14-T03 finding S2, non-blocking)*

Freeze locks a project's dates from a user-entered start week. Today an **In Queue** project can be
frozen at a week in the past. 26INN004 was frozen at W3, which makes it "finish" at W9 and count
as completing within the year, although no work has started. Should freezing be allowed only for
projects that have actually started (In Development or later), or should a past start week be
rejected?

**Also for the client, an observation:** the Capacity "remaining" booked % divides the full-year
load by the remaining weeks' capacity only (ADR 0016). At W42 this reads about 520 %. That is the
agreed formula. Please confirm this is how you want to read it.

**OQ #8 — RESOLVED FOR BUILDING (2026-10-19):** the owner, relaying the client, confirmed per-engineer
utilization and leader names may be used ("it is not a problem"). ADR 0028 enables them. The
DPO / works council confirmation is kept as an accepted residual risk and is no longer blocking.

### 41. Prioritization weights total 295, not 300 *(2026-10-19, P16, ADR 0029, non-blocking)*

With 3-Year Volume at 25 and CAPEX at 15, and every other weight unchanged (ROI keeps 25), the total
is **295**, not the 300 the client expects. The scoring is scaled to 100 whatever the total, so
nothing breaks. Which dimension should carry the missing 5 points (for example New Models 15 → 20,
or ROI 25 → 30)? Or is 295 acceptable?

### 42. Pipeline total: Cancelled projects, and where Spillover / Unregistered come from *(2026-10-20, P17, ADR 0030, non-blocking)*

The Dashboard total now counts every project. Two things the client should confirm.
(a) Should `Cancelled` projects count in the total? The client's 239 lists no cancelled projects;
our real-2026 seed has 29, so the total is 253.
(b) The client workbook we seeded has no carry-over or registration-date column, so the seed sets
`reg_year = 2026`, `carry_over = false` for every project and the row shows Spillover 0 / New 253 /
Unregistered 0. Where do their 76 spillover and 3 unregistered come from (a column in their
workbook, or a rule such as "request date before the plan year")? Until answered the owner can
set `carry_over` and `reg_year` on Project Registration.

### 43. What-if planner: how a hypothetical project gets a leader, and whether added designers take over existing work *(2026-10-20, P18, ADR 0031, non-blocking)*

The scheduler needs a leader per project. For a hypothetical project (and for the projects of a
removed designer) the engine picks, deterministically, the eligible designer of the hub with the
fewest led design-weeks per FTE (ties by id). Added designers start at zero, so they absorb the new
projects. Existing projects are not rebalanced onto added designers. Should "add a designer" also
take some existing projects off an overloaded leader? Until answered it does not (the effect of a
designer is then a lower bound for the existing portfolio).

### 44. What-if planner: defaults for a hypothetical project *(2026-10-20, P18, ADR 0031, non-blocking)*

A hypothetical project defaults to status `In Queue` and priority `P3` when the caller gives neither
a priority nor a score. A score (0..100) maps to a priority with the DOMAIN_RULES bands. Hard gates
are not modelled, so a hypothetical project is never forced to P1. Is `P3` the right default, and
should what-if projects be able to carry hard gates?

### 45. What-if planner: which capacity basis and what "below full" means *(2026-10-20, P18, ADR 0031, non-blocking)*

The instant formulas compare the lead-time demand of every schedulable project (the same Sum of
durations as I6/I7, including work already done) with year capacity (or remaining capacity, a
parameter), exactly as the Capacity surface does. "Stays below BOOKING_FULL_PCT" means the served
booked % is strictly less than 100 (status not `full`). Is year or remaining the basis the client
wants the headline recommendation on, and should the target be configurable (for example below 85)?
Both are parameters of the engine; the default is year and 100.

### 46. What-if planner: chamber downtime and the new-chamber norm *(2026-10-20, P18, ADR 0031, non-blocking)*

Downtime does not gate chamber booking (DOMAIN_RULES "Capacity supply"), so a what-if downtime change
moves supply and booked % but not the schedule. An added chamber with no explicit values takes the
region's norm: platforms = lower median, efficiency and the three downtime figures = mean, allowed
stages = union of the region's chambers. Should downtime instead reduce bookable platforms in the
simulation (a heavier model than the rules ask for)?

### 47. What-if planner: the 52-week year makes most new projects unreachable *(2026-10-20, P18, ADR 0031, non-blocking)*

With `CURRENT_WEEK = 42` and a 52-week year, a new project can only finish in the plan year if its
critical path is 11 weeks or less (PDD/C is 8, OEM/C-OEM is 4; PDD/B is 18, PDD/A 38). No amount of
added capacity changes that. The engine reports these as `unattainable` (and excludes them from the
minimum-additions search) rather than recommending impossible numbers. Should the planner offer a
"finish by W78 / next year" target as well?

### 48. What-if planner: cost of a designer versus a chamber, and search limits *(2026-10-20, P18, ADR 0031, non-blocking)*

"Smallest additions" counts a designer and a chamber as one unit each (ties prefer fewer chambers,
the dearer unit). Added designers are 1.0 FTE (a parameter). The search is capped at 60 greedy runs
and 25 additions per pool, and reports `capped` when that stops it. Does the client want weighted
costs (a chamber is worth several designers) or different limits?
