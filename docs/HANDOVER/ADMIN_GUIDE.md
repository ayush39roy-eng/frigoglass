# RPD Web Application — Admin & End-User Guide

**Audience:** Frigoglass admins, Hub Planners, Portfolio Managers, and other business end users of
the RPD Web Application. This document explains how to use the application day to day.

**Not this document:** deployment, infrastructure, secrets, and backup/restore procedures are
covered in `docs/HANDOVER/DEPLOYMENT_RUNBOOK.md` and `docs/HANDOVER/BACKUP_RESTORE.md` — those are
written for whoever operates the servers, not for the people using the application. If you are
looking for "how do I deploy/restart/back up this application," go there instead.

**Basis for this document:** every feature described below was verified against the actual code in
`frontend/src/surfaces/` and the RBAC table in `backend/core/rbac.py` as of 2026-09-07 — not against
the aspirational description in `docs/PROJECT_AND_STACK.md`. Where the built application currently
does less than the spec describes, or ships a feature as a labelled placeholder, this document says
so explicitly rather than promising something that isn't there yet. If a future release changes
this, this document should be updated alongside it — it is not itself the contract (`docs/
DOMAIN_RULES.md` and `docs/PROJECT_AND_STACK.md` are).

---

## 1. Signing in

**Honest status as of this writing: this is not yet your real Frigoglass corporate login.**

The application uses a standard OIDC/SSO sign-in screen, and the mechanism behind it (token
verification, issuer/audience checks) has been independently security-reviewed and is sound. But
**which identity provider it points at is not yet Frigoglass's own** — `docs/OPEN_QUESTIONS.md` #9
(which IdP, Microsoft Entra ID vs. Keycloak, and the app registration/credentials to use it) is
still unanswered by Frigoglass IT/security, and the corresponding cutover task (P6-T03) is
correspondingly blocked, not merely unfinished.

What this means in practice today:

- The login screen you see during testing/UAT points at a **dev/staging identity instance**, set up
  only so the application can be exercised end to end before the real cutover. It is not connected
  to Frigoglass's Active Directory / Entra ID, and accounts on it are test accounts, not real
  Frigoglass employee identities.
- **Do not treat this login as your permanent corporate credential**, and do not expect your real
  Frigoglass network username/password to work on it. Whoever set up your test account for UAT will
  tell you what to use.
- Once Frigoglass IT/security answers `docs/OPEN_QUESTIONS.md` #9 and the real cutover is done, your
  everyday sign-in will most likely become the same single-sign-on flow you already use for other
  Frigoglass corporate applications (Entra ID is the assumed target) — you should not need a
  separate password to remember for this application specifically. Until then, if you are asked to
  sign in for UAT, treat it as a temporary test credential.
- If you cannot sign in at all, or you sign in but every page shows "your session has expired,"
  see §4 (Troubleshooting) below before assuming it's a personal account problem.

Your **role** (what you can see and do once signed in) and your **hub scope** (which hub(s)'
projects you can see) are not something you set yourself — they are assigned by an Admin against
your account inside the application (see §2). If your access looks wrong on day one, that is almost
always a role/hub assignment that needs correcting by an Admin, not a login problem.

---

## 2. Roles and hub scoping — what you can see and do

The application has six roles. Every screen and every write action is gated by your role, and most
screens are additionally filtered to the hub(s) you're scoped to — you will simply never see a
project, engineer, or chamber that belongs to a hub outside your scope; there is no "access denied"
wall to work around, the data outside your scope is not returned to your browser at all.

The six hubs are: **R&D-Greece**, **R&D-India**, **PD-India**, **PD-Romania**, **OEM-HCK**,
**OEM-Seltek**.

| Role | Dashboard | Capacity | Prioritization Matrix | Gantt / Timeline | Project Registration | Capacity Planning | Audit Log |
|---|---|---|---|---|---|---|---|
| **Admin** | View + edit | View + edit | View + edit | View + edit | View + edit | View + edit | View (all hubs) |
| **Portfolio Manager** | View (all hubs) | View (all hubs) | View + edit (all hubs) | View (all hubs) | View + edit (all hubs) | View (all hubs) | No access |
| **Hub Planner** | View (own hub) | View + edit (own hub) | View (own hub) | View + edit (own hub) | View + edit (own hub) | View + edit (own hub) | No access |
| **Executive Viewer** | View (all hubs) | View (all hubs) | View (all hubs) | View (all hubs) | No access | No access | No access |
| **Engineer** | No access | No access | No access | View own assignments only | No access | No access | No access |
| **Auditor** | No access | No access | No access | No access | No access | No access | View (all hubs) |

A few things worth understanding about how this plays out day to day:

- **Athens HQ vs. a regional hub, in practice:** someone working at Frigoglass HQ in Athens with
  portfolio-wide responsibility would typically be a **Portfolio Manager** (edits priority scores
  and registers/edits projects across every hub, but only *views* Capacity/Gantt/Planning — those
  stay editable by the hub's own planner) or an **Executive Viewer** (read-only, across every hub —
  the right role for someone who needs the full picture but should never accidentally change
  anything). Someone based at a regional hub — say, PD-Romania or R&D-India — running that hub's day
  to day would typically be a **Hub Planner**, scoped to their own hub: they can register/edit
  projects, manage engineers and chambers, and adjust the Gantt (including freezing/unfreezing
  projects) for their hub, but the Matrix (portfolio prioritization) is read-only for them — scoring
  changes are a Portfolio Manager or Admin action.
- **Engineers** get exactly one thing: a read-only view of their own assignments on the Gantt/
  Timeline. They do not see the Dashboard, Capacity, Matrix, Registration, or Planning surfaces at
  all — if you're an engineer and someone tells you to "go check the Dashboard," that's not a role
  you have; ask whoever assigned your access whether you actually need a different role.
- **Auditor** is an audit/compliance role, not a portfolio role — it has no access to any of the six
  portfolio surfaces described in §3.1–§3.6. It exists specifically for read access to the
  application's immutable audit log (who changed what, when) — see §3.7, added in P7-T05 (this used
  to be a documented gap in an earlier revision of this guide: the API-level access existed but no
  screen consumed it; that gap is closed as of this revision).
- **Admin** is the only role with write access everywhere, plus the only role that can manage other
  users' role/hub assignments and, like Auditor, read the audit log (§3.7). Admin access should be
  limited to a small number of people for this reason.
- If you ever see a screen that should be visible to your role but instead shows a plain "your role
  does not have access" message, or a page that loads but every "Edit"/"New"/"Delete" button is
  missing where you expected one, that is the application correctly enforcing this table — see §4
  for what to do about it.

**One specific, known exception worth knowing about, so it isn't mistaken for a bug:** on the
Capacity Planning surface, a Hub Planner can see and use "New engineer," "New chamber," and edit/
delete on both — but the **"Apply Logic" button (which recomputes the whole-portfolio schedule) is
restricted to Admin only**, even though Hub Planners otherwise have write access to this surface.
This is a deliberate, reviewed design choice (recomputing and activating a new schedule affects
every hub's Dashboard/Capacity/Timeline at once, not just the Hub Planner's own hub) — if you're a
Hub Planner and clicking "Apply Logic" gives you a permission error, that is expected; ask an Admin
to run it.

---

## 3. The surfaces

All six surfaces described in the original spec have been built and are reachable from the sidebar,
plus one additional read-only surface (§3.7, Audit Log) added in P7-T05 for the Auditor/Admin roles
— not one of the original six, so it is documented separately at the end of this section rather than
renumbered into §3.1–§3.6. A few individual features within the original six are deliberately not
enabled yet, pending specific client decisions — each is called out below exactly where it applies,
with the reason, so it's clear this is a considered gap and not a bug.

Every number, chart, and table on every surface is read directly from the API — nothing is
recalculated in your browser. If a figure looks wrong, the fix is either the underlying project/
scheduling data or an API-side issue, never something to "correct" by cross-checking a spreadsheet
against the screen (see §4).

### 3.1 Global RPD Dashboard

**What it's for:** the portfolio-wide, at-a-glance view of how the current schedule is performing —
this is the screen a Portfolio Manager or executive opens first.

**What's on it:**
- How many projects are completing within the current year vs. spilling into next year vs. left out
  entirely (with a note on which schedule run — greedy or CP-SAT — produced the numbers, and when it
  was run).
- Pipeline and completion totals, and a per-status breakdown (In Queue, In Development, Under
  Industrialization, In Buyoff).
- A hub × project-type pipeline table.
- A filterable/virtualized project breakdown table with an export option.

**Core workflow:** this is a read-only surface for every role that can see it (Portfolio Manager,
Hub Planner, Executive Viewer, Admin) — you review it, you don't act on it directly. If a number here
looks stale, it's tied to whichever schedule run is currently "active"; re-running the schedule (via
Capacity Planning's Apply Logic, an Admin action) is what changes it, not anything on this page
itself.

### 3.2 RPD Capacity

**What it's for:** comparing engineering design load and lab (chamber) load against available
capacity, per hub, for the active schedule run.

**What's on it:**
- Per-hub design-load-vs-capacity and lab-load-vs-capacity panels.
- A class (A+/A/B/C) breakdown of what's deliverable vs. left out.
- A chamber utilization heatmap.
- An explicit on-screen notice explaining that the "capacity" figures are a reporting estimate
  (scaled by engineer FTE and chamber efficiency) while the "load" figures come from what the
  scheduler actually booked — **the scheduler itself does not apply FTE or chamber-efficiency
  scaling when booking**, so load exceeding capacity on this screen does not mean the schedule is
  broken, and spare capacity does not mean the scheduler will use it. This is a known, documented
  behavior (`docs/DOMAIN_RULES.md`'s "known defects," ADR 0002/0003), not a defect in this screen.

**Known gap, not yet enabled:** the utilization matrix on this surface intentionally shows only
**chamber (equipment)** utilization, not named-engineer utilization. Per-engineer utilization is
withheld pending a Frigoglass Data Protection Officer determination on whether it constitutes GDPR
personal data (`docs/OPEN_QUESTIONS.md` #8) — you will see a placeholder in that spot explaining
this, not a broken or empty chart.

**Core workflow:** read-only review for everyone who can see it; export is available for reporting
outside the application.

### 3.3 Prioritization Matrix

**What it's for:** scoring and prioritizing all active projects across the 13 dimensions defined in
`docs/DOMAIN_RULES.md`, and reviewing the resulting priority bands (P1–P4) portfolio-wide.

**What's on it and what you can do:**
- A virtualized scoring grid (236 projects × 13 dimensions), filterable by hub and category, with a
  server-driven currency toggle (EUR/USD/INR — the conversion happens on the server, the screen just
  displays whichever currency you pick).
- Editing a project's score: opens a dialog for the 13 dimensions plus hard-gate flags (regulatory
  deadline within 6 months, customer certification at risk, active safety non-compliance — any of
  these forces the project's band to P1 regardless of its numeric score). Saving recomputes that
  project's weighted score/percentage/suggested band immediately.
- **Scenario mode:** a toggle that changes editing from "saves immediately" to "stage a set of
  proposed changes, review them as a batch (with undo/redo and a running diff of every field you've
  changed), add a note, and then Apply them all together (or discard the whole batch)." Useful for
  a portfolio review meeting where several scores might change together before anyone commits.
- Version history: a browsable log of previously applied scenario batches.
- A portfolio decision summary (how many projects are scored, how many aren't, how many are
  hard-gate-forced to P1) and a band-distribution chart.
- Export.

**Important distinction to understand, so this isn't misread as broken:** editing a score here (or
applying a scenario) changes that project's *computed/suggested* band — it does **not** change the
project's officially *committed* priority (the value the scheduler actually uses), and it does
**not** trigger a new schedule run. The summary panel shows both numbers side by side and labels
them explicitly ("Computed band (from current score)" vs. "Committed priority") for exactly this
reason. A separate, portfolio-wide "Apply Priorities" action — which would commit the computed bands
as the projects' real priorities — is described in the original spec but **has not been built yet**;
it's a planned future action, not something currently reachable from this screen. If you change a
score and the Dashboard/Gantt don't reflect a different priority, that is expected today, not a bug.

**Who can edit:** Portfolio Manager and Admin have full read/write across all hubs; Hub Planner is
read-only here (scoped to their own hub); Executive Viewer is read-only across all hubs.

### 3.4 Project Execution Timeline (Gantt)

**What it's for:** the visual, week-by-week execution timeline — all 14 workflow steps for every
project, across the 78-week planning horizon, as produced by the active schedule run.

**What's on it and what you can do:**
- A hand-built, virtualized Gantt chart (handles the full 236-project × 14-step dataset without
  loading everything into the DOM at once) with a hub filter, expand/collapse per project, and a
  zoom control.
- Each project row shows its planned bar (solid) from the active schedule run, and — where the real
  project has drifted from plan — an actual/delayed bar (hatched) with a connector showing the delay.
  A dashed line marks week 52 (year-end); whether a project lands within-year, spills over, or is
  left out is a badge read directly from the schedule run, never computed on screen.
- A legend explaining every bar style/color/badge.
- **Freeze / unfreeze a project:** locks (or unlocks) a project's dates so a future schedule
  recompute won't move them. This is a Hub Planner/Admin action, hub-scoped for Hub Planners.
  Freezing or unfreezing does **not** immediately recalculate anyone's dates on screen — you'll see
  an explicit banner reminding you that a Hub Planner or Admin still needs to run a schedule
  recalculation (Apply Logic, on Capacity Planning) before the freeze actually changes what's
  displayed.
- Export.

**Core workflow for a Hub Planner:** review your hub's timeline, freeze a project if its dates need
to be protected from the next recompute (e.g. a customer-committed date), then coordinate with
whoever runs Apply Logic next so the freeze takes effect.

### 3.5 Project Registration

**What it's for:** creating and maintaining the project records that everything else in the
application is built from — hub, category, financials, status, priority, workflow assignment.

**What's on it and what you can do:**
- A filterable (hub/category/status/priority/type), virtualized project list.
- Create/edit a project via a form. Certain fields are **hard-gated**: a new project starts in
  `Draft` status, and the application will show you exactly which required fields (category,
  financial fields, etc.) are still missing before it will let you submit the project out of Draft
  into a schedulable status (In Queue and beyond). This gate is enforced by the API, not just the
  form — the same missing-fields check is re-verified server-side, so you can't bypass it by editing
  around the form.
- Export.

**Who can edit:** Portfolio Manager and Admin (all hubs), Hub Planner (own hub, read/write). This is
the one core surface Executive Viewer and Engineer have no access to at all.

### 3.6 Capacity Planning

**What it's for:** maintaining the engineers and lab chambers the scheduler assigns work to, and
running the deterministic scheduling logic across the whole portfolio.

**What's on it and what you can do:**
- **Engineers tab:** list (filterable by hub), create/edit/delete. Deleting an engineer who is still
  referenced by a project, workflow step, or schedule-run snapshot will fail with a clear message
  rather than silently breaking existing data.
- **Chambers tab:** same pattern — list, create/edit/delete, with the same referential-integrity
  protection on delete.
- **Apply Logic & Auto-assign tab:**
  - **Apply Logic** recomputes the schedule for the entire portfolio (every hub, not just yours)
    using the deterministic, rule-based scheduling logic in `docs/DOMAIN_RULES.md`, and immediately
    activates it as the live schedule — the Dashboard, RPD Capacity, and Timeline surfaces will all
    reflect the new run the moment it completes. Because this is whole-portfolio and immediate, the
    button asks for confirmation before running, and it currently requires the **Admin** role
    specifically (see §2's callout above). The result summary (projects scheduled, within-year,
    spillover, left-out counts) is shown right after it runs.
  - **Auto-assign is not enabled.** You'll see a clearly labelled placeholder explaining why: the
    underlying CP-SAT optimizer can, in some real cases, deliberately drop a schedulable P1
    project entirely in order to finish other projects within the year — a trade-off the
    portfolio/commercial owner has not yet been asked to approve (`docs/OPEN_QUESTIONS.md` #10).
    Apply Logic (above) is the scheduling action available today; Auto-assign is a future feature
    pending that decision, not something currently missing due to a bug.
- Export (separately for engineers and chambers).

### 3.7 Audit Log (Auditor / Admin only)

**What it's for:** a read-only, filterable record of every mutation the application has made —
who changed what, when, and (where recorded) from where. This is the compliance/audit trail behind
CLAUDE.md's "immutable append-only audit log" requirement: every write across every surface (project
create/update/submit, engineer/chamber create/update/delete, priority-score edits, schedule runs,
freeze/unfreeze, currency-rate updates, and more) writes exactly one row here, and rows can never be
edited or deleted afterward, even by an Admin — not through this screen, and not directly against the
database (a database-level trigger rejects any `UPDATE`/`DELETE`/`TRUNCATE` against the underlying
table).

**Who sees it:** Auditor and Admin only (§2's table) — every other role gets the same "your role does
not have access" screen described in §4. Unlike every other surface in this application, it is **not
hub-scoped**: an Auditor or Admin sees audit history across all six hubs by design (this role's access
qualifier is "all," not "own hub" — there is no partial-audit-visibility Auditor).

**What's on it and what you can do:**
- A table of audit entries, newest first, each showing when it happened, who did it (or "System" for
  an unattended background action, e.g. a scheduled recompute with no human actor), what action was
  taken (e.g. `project.update`, `engineer.create`, `schedule_run.greedy_recalc`), and which record it
  affected.
- Click a row to expand it and see the full detail: the request ID and IP address recorded at the
  time (where available), any notes, and the before/after snapshot of the record's fields.
- **Filters:** entity type, entity ID, actor (by user ID), action, hub (a narrowing convenience here,
  not an access restriction — see above), and a from/to date range. Filters combine (all must match);
  clear them with the "Clear" button once any are set.
- Pagination: results page 100 at a time, newest first, with Previous/Next controls and a running
  "X–Y of Z" count.
- **This screen has no edit, export, or delete actions of any kind** — it is intentionally read-only,
  consistent with the audit log's own append-only, tamper-evident design.

**Financial data is never shown here, even to an Admin.** Customer name, TCOGS, selling price, and
gross margin are commercially sensitive fields (CLAUDE.md). If a change to a project ever touched one
of those fields, the before/after snapshot on this screen shows the literal text `<redacted>` in place
of the real value — the application never stores the real value in the audit trail in the first place
(it is redacted before the audit row is even written), so there is no real number to accidentally
expose here, for either role.

---

## 4. Basic troubleshooting

This section is for an admin/planner facing a confusing screen, not for diagnosing the application
itself — if a problem persists after the checks below, escalate to whoever supports the deployment
(see `docs/HANDOVER/DEPLOYMENT_RUNBOOK.md`'s §11 for the technical/ops side of these same symptoms).

**"My project isn't showing up in the schedule / isn't scheduling at all."**
1. Check its status on Project Registration. Projects with status `Commercialized` or `On Hold` are
   intentionally excluded from scheduling entirely — that's not a bug.
2. If it's still in `Draft`, it hasn't been submitted yet — open it on Project Registration and check
   the hard-gate panel for which required fields are still missing.
3. If it's submitted and schedulable but still doesn't show a schedule, the schedule may simply not
   have been recomputed since the project was added/changed — Capacity Planning's "Apply Logic" (an
   Admin action) is what (re)computes the schedule; ask an Admin whether/when it was last run.
4. If it shows up but with a "left out" badge, that means the scheduler could not find a feasible
   window for it before the end of the 78-week horizon — this is a genuine capacity/contention
   outcome from the current engineer/chamber configuration and project mix, not an error to "fix" on
   the screen; it may require a capacity conversation (more engineers/chambers, or reprioritizing).

**"I can't see project X" (or a whole surface looks empty/inaccessible).**
1. Check whether project X belongs to a hub outside your scope — most roles other than Portfolio
   Manager/Executive Viewer/Admin only see their own hub's data, by design (§2). Ask an Admin to
   confirm your hub scope if you believe it's wrong.
2. If an entire surface shows "your role does not have access," that's the RBAC table in §2 working
   as intended — check the table for what your role can see, and ask an Admin if you believe your
   role assignment itself is wrong.
3. If you see "your session has expired" instead, sign in again — see §1 if that keeps recurring.

**"The Gantt looks wrong" (bars, dates, or badges don't match what I expect).**
1. Check which schedule run the Gantt is showing — the timeline reads from a specific active
   schedule run (shown in a provenance note above the chart), not live from every edit you've made.
   If you changed engineers, chambers, or froze a project since that run, the timeline won't reflect
   it until Apply Logic is run again.
2. A hatched bar is the *actual* (real-world, possibly delayed) dates, separate from the solid
   *planned* bar — if a project looks like it has two different timelines, that's the legend's
   planned-vs-actual distinction working correctly, not a duplicate entry.
3. If you froze or unfroze a project and the Gantt didn't move, that's expected — see §3.4; a
   recalculation still needs to run.
4. If the load/capacity figures on RPD Capacity seem to disagree with what the Gantt shows, re-read
   the on-screen notice on that surface (§3.2) before assuming either number is wrong — they are
   computed two different ways on purpose.

**"A number on one screen doesn't match a number on another screen, or doesn't match my own
spreadsheet count."**
Every figure in this application traces to a single API field — nothing is independently
recalculated in the browser, by design. If two on-screen numbers genuinely disagree with each other,
or a figure doesn't match your own records, don't try to reconcile it by editing data around the
discrepancy — capture which two numbers/screens disagree (with the schedule-run version shown in the
provenance note, if visible) and escalate it as a data/backend question rather than a display
question.

**"I got a permission error I didn't expect" (a button worked yesterday, or should work per the role
table).**
1. Check the exact wording of the error against §2's table — a few actions are intentionally
   stricter than the surface-level role table suggests (the Apply Logic / Admin-only case is the one
   documented exception as of this writing).
2. If it genuinely doesn't match §2's table, this is worth escalating — capture the exact screen,
   action, and role, and pass it to whoever supports the deployment.

**When to escalate beyond this guide:**
- Anything that looks like incorrect scheduling math, scoring math, or an invariant violation (e.g.
  an engineer double-booked, a chamber over capacity without a frozen project involved) is a backend/
  scheduling question, not something to work around in the UI — escalate through your normal project
  support channel rather than editing data repeatedly to try to fix it.
- Login/SSO problems beyond "I need to sign in again" — see §1's honest framing; while the
  application still points at a non-production identity instance, access/account issues should go to
  whoever is administering that test environment for UAT, not to Frigoglass corporate IT helpdesk.
- Anything involving backups, restores, deployment, or server health is out of scope for this guide —
  see `docs/HANDOVER/DEPLOYMENT_RUNBOOK.md` and `docs/HANDOVER/BACKUP_RESTORE.md`.
