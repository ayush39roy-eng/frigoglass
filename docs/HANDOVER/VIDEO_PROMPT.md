# RPD Web Application — Explainer Video Prompt

A self-contained brief for an AI video generator, or for a human motion designer. It assumes the
reader has never seen the application. Section A is the global style brief. Section B is a short
master prompt for tools that accept a single prompt. Section C is the scene-by-scene script with
visuals, on-screen text, voiceover and timing. Section D lists what must never appear.

All figures below are **illustrative sample data** for the video. They are internally consistent,
but they are not live Frigoglass figures.

---

## A. Global brief

**Purpose.** Explain what the RPD Web Application is, why Frigoglass needs it, and how its five
main areas work together: the Dashboard, Prioritization Matrix, Capacity, Project Workspace and
"Ask the agent".

**Audience.** Frigoglass leadership, portfolio managers, hub planners and R&D engineers. They know
the business well but have not seen the tool.

**Length.** About 6 minutes (12 scenes). Aspect ratio 16:9, 1920×1080, 30 fps.

**Tone.** Calm, confident, precise, like a well-made enterprise product film. No hype, no
exclamation marks, no stock-footage clichés (handshakes, people pointing at glass walls).

**Visual style.**
- Mostly clean UI-led motion graphics: realistic screens of a modern web dashboard, shown on a
  floating browser frame or full-bleed, with slow push-ins and gentle parallax.
- Short abstract sequences explain concepts, such as projects as blocks sliding onto a timeline,
  or capacity as a filling gauge.
- Light theme by default. Show one brief switch to dark theme in Scene 11.
- Flat, crisp, generous whitespace, rounded cards (12–16 px radius), soft shadows. No glossy 3D,
  neon glow or heavy gradients.

**Palette.**
| Role | Light theme | Dark theme |
|---|---|---|
| Background | #F7F8FA off-white | #08080A near-black graphite |
| Cards | #FFFFFF | #19191C |
| Primary (cobalt blue) | #1B5198 | #387DD0 |
| Text | #111318 | #E6E6E8 |
| Positive / on track | green #2E9E5B | same |
| Warning / at risk | amber #D99A1E | same |
| Negative / off track | red #D6453D | same |
| Left out | charcoal #3A3A40 | grey #8A8A92 |

The blue must be a deep, slightly muted cobalt, not a bright default "tech blue".

**Typography.** Plus Jakarta Sans for headings, bold and tight. Inter for body text and numbers.
Numbers use tabular figures.

**Motion.** Ease-out cubic, 300–500 ms for UI elements, with counters ticking up to their value.
Nothing bounces. Transitions between scenes are soft cross-dissolves or a slide in the direction
of the sidebar navigation.

**Voiceover.** One neutral, warm, professional voice in international English, about 140 words a
minute.

**Music.** Minimal ambient electronic or soft piano pulse, low under the voice, swelling slightly
in Scene 12.

**Captions.** Burned-in subtitles in Inter, white on a 70% black pill, bottom-centre.

**Recurring UI shell, used on every app screen.** A left sidebar with the "RPD" logo chip at the top
and these nav items: Dashboard, Projects, Capacity, Prioritization, Timeline, Register, Planning,
Workflow, Users & roles. The active item is highlighted in cobalt. A top header shows the page
title, a "Week 31" pill, a theme toggle and a user avatar showing initials only.

---

## B. Master prompt (single-prompt tools)

> A 6-minute, 16:9 enterprise product explainer for "RPD Web Application", an internal planning
> tool for Frigoglass, a commercial refrigeration manufacturer with R&D and production hubs in
> Greece, India and Romania. Clean, flat UI motion graphics in light theme, with off-white
> backgrounds, white rounded cards and deep cobalt blue (#1B5198) accents. Green, amber and red are
> used only for status. Plus Jakarta Sans headings, Inter body text. A calm professional voiceover
> explains how 236 R&D projects across six hubs, each with 14 workflow steps, are automatically
> scheduled onto engineers and lab test chambers over a 78-week horizon, and which projects will
> finish this calendar year.
>
> Scenes, in order:
> 1. The spreadsheet problem.
> 2. How the scheduling engine works.
> 3. The Global Dashboard, with a "142 of 236 completing within the year" headline, a delivery
>    gauge and hub charts.
> 4. The project register.
> 5. The Prioritization Matrix, with 13 scoring dimensions, weights, P1–P4 bands, hard gates,
>    currency toggle and scenario mode.
> 6. RPD Capacity, with design 375/579 engineer-weeks and lab 192/478 chamber-weeks, per-hub load
>    against capacity, class breakdown and a chamber heatmap.
> 7. The Gantt timeline.
> 8. The Project Workspace, with health badge, stage progress, files and activity feed.
> 9. "Ask the agent", a chat-style panel answering a question about one project, with a visual of
>    financial data and names being stripped out before the question leaves.
> 10. Security.
> 11. A dark-theme glimpse.
> 12. A closing summary.
>
> Smooth ease-out animations, counters ticking up, slow camera push-ins, soft cross-dissolves. No
> real people's faces, no real customer names, no real financial figures.

---

## C. Scene-by-scene script

Each scene lists **Duration**, **Visuals**, **On-screen text** and **Voiceover (VO)**.

### Scene 1 — The problem (0:00–0:30, 30 s)

**Visuals.**
1. Open on a dense spreadsheet filling the frame: hundreds of rows, coloured cells, tabs at the
   bottom labelled "Pipeline 2025-26", "Lead times", "Capacity". Slow zoom out.
2. Cells start to flicker and conflict. Two rows highlight red because the same engineer's initials
   appear in the same week twice. A "?" floats over the "Year-end" column.
3. A world map gently fades in behind it with six pins: Athens (R&D-Greece), two in India (R&D-India,
   PD-India), one in Romania (PD-Romania), and two OEM pins in India (OEM-HCK, OEM-Seltek). The pins
   connect with thin cobalt lines.

**On-screen text.**
- "236 active projects"
- "6 hubs · 3 countries"
- "1 question: *what will finish this year?*"

**VO.**
> Frigoglass runs about two hundred and thirty-six R&D and product development projects at once,
> across six hubs in Greece, India and Romania. Today they're planned in a spreadsheet. A
> spreadsheet can list projects, but it can't answer the question leadership really asks: with the
> engineers and test chambers we actually have, which projects will finish this year, and which
> won't?

### Scene 2 — Introducing the RPD Web Application (0:30–0:50, 20 s)

**Visuals.**
1. The spreadsheet folds away like a sheet of paper and morphs into a browser window. Inside is a
   login page: a cobalt brand panel on the left with the "RPD" mark, and on the right a single
   button, "Sign in with company account".
2. A small server-rack icon with a lock appears beside the browser, labelled "Frigoglass servers".
   A dotted boundary line labelled "Corporate network" encloses both.

**On-screen text.**
- "RPD Web Application"
- "Hosted on Frigoglass servers · Single sign-on"

**VO.**
> The RPD Web Application replaces that spreadsheet. It runs on Frigoglass's own servers, inside
> the corporate network, and you sign in with your normal company account.

### Scene 3 — How the engine works (0:50–1:35, 45 s)

**Visuals.**
1. A single project card appears ("Sample project · Category A+ · Hub R&D-Greece"). It unfolds into
   a horizontal chain of 14 small step tiles labelled PDD-A to PDD-N. Highlight the first and last:
   "Marketing Brief" and "Commercialization".
2. The tiles colour-code into three kinds, with a legend:
   - **Design** (cobalt, person icon): "needs the project leader"
   - **Lab** (teal, thermometer and chamber icon): "needs a test chamber"
   - **Elapsed** (grey, clock icon): "takes calendar time only"
3. A lead-time table slides in. Rows are A+, A, B, C, A-OEM, B-OEM and C-OEM, and columns are the 14
   steps. Highlight the totals column: A+ = 44 weeks, A = 38, B = 18, C = 8. Steps with 0 weeks fade
   out and are labelled "skipped".
4. Wide shot: a 78-week timeline grid (weeks 31 to 108), with rows for engineers on top and lab
   chambers below. Dozens of project blocks drop in one at a time, P1 first in the darkest cobalt,
   then P2, P3 and P4 in lighter tints. Each block snaps into a free slot. When a slot is taken, the
   block slides right to the next free week. Nothing overlaps.
5. A bold vertical line at week 52 is labelled "Year end". Blocks ending left of it glow green and
   blocks ending right of it glow amber. A few blocks fall off the far right edge and turn charcoal,
   labelled "Left out".
6. The finished grid compresses into a single glowing document icon labelled "Schedule run #
   v128". Thin lines connect it to three small screen thumbnails: Dashboard, Capacity and Timeline.

**On-screen text.**
- "14 steps per project"
- "Durations from your own lead-time table"
- "Higher priority books first · no double-booking"
- "One schedule → every screen"

**VO.**
> Underneath every screen is a scheduling engine. Each project moves through fourteen workflow
> steps, from Marketing Brief to Commercialization. Design steps need the project leader's time,
> lab steps need a test chamber in the right region, and elapsed steps simply take calendar time.
> Each step's length comes from Frigoglass's own lead-time table. An A-plus project is about
> forty-four weeks of work, and a C project about eight.
> The engine places every step of every project on a seventy-eight-week horizon. The highest
> priority books first, and no engineer or chamber is ever double-booked. The result is a single
> schedule, and every number on every screen is read from it, so the screens can never disagree.

### Scene 4 — Global RPD Dashboard (1:35–2:20, 45 s)

**Visuals.** Full app shell, "Dashboard" active, page title "Global RPD Dashboard". The camera
pans down the page section by section.
1. **KPI row.** Four cards animate in left to right:
   - a cobalt feature card, "Pipeline 236", with the sub-label "98 spillover · 138 new"
   - a dark "Planning clock" card showing a circular dial at week 31, with "21 weeks left"
   - "Completing within year 142"
   - "Left out 24"
   Counters tick up.
2. **Delivery gauge.** A semicircle gauge fills to 60%. Its four segments are labelled Within year
   142 (green), Spillover 61 (amber), Blocked 9 (slate) and Left out 24 (charcoal). Caption: "Every
   project in exactly one bucket".
3. **Status overview.** Four small cards: In Buyoff 27, Under Industrialization 41, In Development
   96, In Queue 72.
4. **Hub × type pipeline.** A table with rows R&D-Greece, R&D-India, PD-India, PD-Romania, OEM-HCK
   and OEM-Seltek, beside a stacked bar chart per hub.
5. **Portfolio analytics.** Filter chips (Hub, Category, Status, Priority). Tapping "R&D-India"
   animates the charts to that hub.
6. Zoom into small chips near the title: "Run v128 · Today 09:14 · Solver CP-SAT". A tooltip says
   "Figures come from this schedule run".
7. The cursor hovers a project row and it highlights, as a hint for Scene 8.

**On-screen text.**
- "142 of 236 finish by week 52"
- "Counted from the schedule, never typed in"

**VO.**
> The Global Dashboard is the portfolio at a glance. Two hundred and thirty-six projects in the
> pipeline: some carried over from last year, the rest newly registered. We're in week thirty-one,
> with twenty-one weeks left in the year. The headline is here: one hundred and forty-two projects
> will finish by week fifty-two. That number isn't estimated. It's counted straight from the latest
> schedule run, and these chips show exactly which run and when.
> The delivery gauge puts every project in one bucket: finishing this year, spilling into next
> year, blocked, or left out because there's simply no capacity for it. Below that, status, hub and
> type breakdowns, all filterable.

### Scene 5 — All Projects (2:20–2:35, 15 s)

**Visuals.** "Projects" nav item activates. A clean table of project rows with columns ID, Name,
Hub, Category, Status, Priority and Health. Filter dropdowns are applied in turn (Hub: PD-Romania →
Category: A → Priority: P1) and the list shrinks smoothly with each one. A row's coloured health
dot pulses.

**On-screen text.** "Find any project in seconds"

**VO.**
> All Projects is the full register. Filter by hub, category, status or priority, and click any
> project to open it.

### Scene 6 — Prioritization Matrix (2:35–3:35, 60 s)

**Visuals.**
1. "Prioritization" nav item activates, with the page title "Prioritization Matrix". A wide grid
   shows project rows. The columns are 13 scoring dimensions grouped under five coloured pillar
   headers. Cells hold scores 1 to 5, shaded light to dark cobalt.
2. The five pillars highlight one by one, each with its weight shown in a small badge:
   - Strategic Alignment: Strategic Project 25 · New Customer 25 · New Options 25
   - Regulatory & Quality: Regulatory Compliance 25 · Quality Improvements 25
   - Financial Return: RM Savings 25 · Total RM Savings 25 · Gross Margins 25 · Profitability 25
   - Market & Volume: Annual Volume 15 · 3-Year Volume 15 · New Models 15
   - Investment & Feasibility: CAPEX Investment 10, with a small "inverted ↓" tag
3. An animated formula builds on screen:
   `Σ (score × weight)  ÷  (280 × 5)  =  72 %` → a band chip "P1" pops in.
   Then a band ladder appears: **P1 ≥ 70% · P2 ≥ 55% · P3 ≥ 40% · P4 < 40%**.
4. **Hard gates.** A row with a modest score of 48% gets a red shield badge, and its band flips from
   P3 to P1. A side card lists the three gates: "Regulatory deadline < 6 months", "Customer
   certification at risk", "Active safety non-compliance".
5. **Scoring rubric panel** slides in from the right, describing what a 1, 3 and 5 mean for each
   dimension.
6. **Portfolio summary.** "Scored 214 · Not yet scored 22 · Hard-gate forced to P1 11", plus a band
   distribution bar chart: P1 38, P2 71, P3 64, P4 41.
7. **Currency toggle.** The EUR / USD / INR segmented control switches. Financial column headers
   change symbol (€ → $ → ₹), with values shown as masked sample bars rather than real numbers.
   Labels: "New models" and "RM-saving projects".
8. **Scenario mode.** A toggle "Scenario" turns on and the page gets a subtle dashed amber border
   labelled "Not committed". The user edits two scores and the bands for those rows change, shown
   as ghosted previews. A "Staged changes (2)" list appears. Then the user clicks the cobalt **Apply
   Priorities** button. A confirmation appears and a "Version history" panel adds an entry: "v42 ·
   Priorities applied · Portfolio Manager · today". A small banner reads "Schedule marked for
   recalculation".

**On-screen text.**
- "13 dimensions · 5 pillars · weight 280"
- "Hard gates force P1"
- "Try it first in Scenario mode"

**VO.**
> The Prioritization Matrix decides who goes first, and because the engine books in priority
> order, it decides who gets engineers and chambers. Every project is scored from one to five on
> thirteen dimensions in five pillars: strategic alignment, regulatory and quality, financial
> return, market and volume, and investment, where lower CAPEX scores higher. The weighted total
> becomes a percentage: seventy and above is P1, fifty-five is P2, forty is P3, and below that, P4.
> Hard gates override the score. A regulatory deadline within six months, a key customer
> certification at risk, or a safety non-compliance forces a project straight to P1.
> Financials can be viewed in euros, dollars or rupees. And in scenario mode, planners can test
> changes without touching the live plan. When they're ready, Apply Priorities commits them,
> versioned, with a full history of who changed what.

### Scene 7 — RPD Capacity (3:35–4:30, 55 s)

**Visuals.**
1. "Capacity" nav item activates, with the page title "RPD Capacity". Two large meter cards fill:
   - "Design: 375 / 579 engineer-weeks · 65% used" (cobalt bar)
   - "Lab: 192 / 478 chamber-weeks · 40% used" (teal bar)
2. **Formula explainer (abstract cut-away).**
   - An engineer silhouette with no face and no name stands next to a 52-week calendar strip.
     Blocks peel away labelled National holidays, Medical, Casual and Annual leave, leaving
     "Working weeks". An "× FTE" multiplier tag snaps on.
   - Then a test-chamber icon with its own 52-week strip. Blocks peel away labelled Holidays,
     Maintenance, Breakdown and Calibration. Tags "× efficiency" and "× platforms" snap on.
   - Caption: "Capacity from Frigoglass's own workbook formulas".
   - A small split bar shows "Yearly capacity" against the smaller "Remaining from week 31".
3. **Load vs. capacity per hub.** A grouped bar chart per hub, with load bars against a capacity
   line. One hub's bar crosses the line and turns red, with a callout "Gap: −46 weeks". Another
   shows "Completion 88%".
4. **Class breakdown.** Stacked bars for A+, A, B and C, split into "Deliverable" (green) and "Left
   out" (charcoal). Callout on A: "6 A-class projects left out". A thought bubble reads "Add a
   chamber? Add an engineer? Or accept it?"
5. **Resource utilization matrix.** A heatmap of chambers by weeks 31–52. Cells go from pale to deep
   cobalt, and a few fully saturated cells pulse. Beside it, an engineer utilization panel shows a
   lock icon and the label "Engineer-level view awaiting data-protection sign-off".
6. A subtle info notice at the top: "FTE, efficiency and downtime shape the capacity figures.
   Week-by-week booking is gated by availability and platform count."
7. Quick cut to **Capacity Planning** ("Planning" nav item). Two tables: Engineers (role, FTE,
   allowed categories) and Chambers (region, platforms, efficiency, allowed steps). The engineer
   rows show anonymised placeholders such as "Engineer 01" and "Engineer 02". Label: "Hub planners
   edit their own hub only".

**On-screen text.**
- "Where is the bottleneck?"
- "Design 65% · Lab 40%"

**VO.**
> The Matrix decides who goes first. Capacity shows whether there's enough people and equipment to
> go round. Design load is three hundred and seventy-five engineer-weeks against five hundred and
> seventy-nine available, and lab load is a hundred and ninety-two chamber-weeks against four
> hundred and seventy-eight. Capacity uses Frigoglass's own formulas: working weeks after holidays
> and leave, scaled by FTE for engineers, and by efficiency, platforms and downtime for chambers.
> And because we're already in week thirty-one, it shows what's left this year, not just the yearly
> total.
> Per hub, you can see exactly where load exceeds capacity. The class breakdown shows how many
> A-plus, A, B and C projects can be delivered, and how many are left out. That's where the real
> decision starts: add a chamber, add an engineer, or accept it. Individual engineer utilization is
> deliberately held back until data protection signs off.

### Scene 8 — Project Execution Timeline (4:30–4:50, 20 s)

**Visuals.** "Timeline" nav item activates. A Gantt chart with weeks across the top and a cobalt
"now" line at week 31. One project row expands into its 14 step rows. Solid bars mean planned and
hatched bars mean actual plus delay, with a thin red connector showing a delay. Two vertical marker
lines on the row are labelled "Expected" (grey dashed) and "Projected" (cobalt). Small badges read
"ENG_CONFLICT", "OVERLAP" and "LEFT_OUT". A bottleneck strip along the bottom shows weekly load.

**On-screen text.** "Expected vs projected: see the slip"

**VO.**
> The Timeline is the schedule itself. Every project expands to its fourteen steps. Planned work is
> solid and actual progress is hatched, and two markers show expected against projected finish, so
> any slip is obvious.

### Scene 9 — Project Workspace (4:50–5:25, 35 s)

**Visuals.**
1. Click a project row. The page transitions into the **Project Workspace** for "PRJ-0147 · Sample
   glass-door cooler". A sticky header shows the hub (R&D-Greece), category (A+) and priority (P1),
   an amber **health badge "At Risk"**, and a cobalt "Recalculate schedule" button.
2. **Left column: Progress panel.** At the top, a progress bar fills to 46%, captioned "weighted by
   stage length". Below it are 14 stage rows: A–E show green "Done" ticks, F shows "In Progress 60%"
   with a slider, G shows red "Blocked", and the rest show "Not Started". The user drags F's slider
   to 80%. A yellow banner slides in: "Progress updated. Schedule is now stale." The user clicks
   Recalculate, a small progress ring spins, and then the result shows "New schedule version v129 ·
   finish moved week 49 → 47".
3. **Right column: Files panel.** A drag-and-drop zone. A PDF named "certification_report" drops in
   and its tag changes from "v1" to "v2". Category chips: Drawing, Test Report, Certification.
4. **Activity feed.** Comments and system events interleave: "PDD-F marked In Progress",
   "Priority changed P3 → P1", and a comment, "Waiting on supplier sample, see attached".

**On-screen text.**
- "Planner → Tracker"
- "Progress edits never silently reshuffle the plan"

**VO.**
> Click any project and you land in its Workspace. This is where the plan meets reality. The health
> badge is derived from the schedule, never typed in. Each of the fourteen stages records its
> status, percent complete and actual dates, and the overall progress is weighted by stage length.
> Updating progress doesn't silently reshuffle fifty other projects. It marks the schedule stale,
> and you recalculate when you're ready, creating a new version you can always compare against.
> Files are versioned, and comments sit right next to the system events, so "why did this slip?"
> has its answer on one page.

### Scene 10 — Ask the agent (5:25–5:55, 30 s)

**Visuals.**
1. Scroll to a highlighted card with a cobalt border, a round robot icon and the title **"Ask the
   agent"**. The text field types: *"Which stage is this project waiting on, and will it finish
   this year?"*. The user clicks Ask.
2. **Redaction cut-away.** The project's data appears as a stack of labelled cards travelling toward
   a cloud icon labelled "AI model". Before they leave a dotted boundary labelled "Frigoglass
   network", a filter gate removes four cards ("TCOGS", "Gross margin", "Selling price", "Customer
   name"), which shatter into grey dust. A card reading "Engineer: [name]" flips to read "Design
   engineer for PDD-F". Only safe cards pass: status, stages, dates, comments.
3. Back in the panel, a plain-text answer fades in line by line:
   *"This project is blocked at PDD-G (Design Validation), waiting on a supplier sample. Its
   projected finish is week 47, inside the year, but it is At Risk because PDD-F overran its
   planned duration by 2 weeks."*
4. Three icon badges appear underneath: 👁 "Sees only what you can see" · 🛡 "Financials & names
   never sent" · ⏻ "Off by default · every question audit-logged".

**On-screen text.** "Plain-English answers about one project"

**VO.**
> And for quick answers, there's Ask the agent. Ask a plain-English question about this project and
> get a direct answer from its own data. It only sees what you can already see. Financial figures,
> customer names and engineer names are stripped out before anything leaves the system, whatever
> your role. It's switched off by default, every question is logged, and whether it uses an
> external AI service or one hosted on Frigoglass's own servers is Frigoglass's decision.

### Scene 11 — Security and governance, with a dark-theme glimpse (5:55–6:10, 15 s)

**Visuals.** The theme toggle is clicked and the whole app smoothly turns to graphite dark (near
black, cobalt accents). Icons appear over it in a grid:
- lock: "Single sign-on"
- people: "7 roles · hub-scoped access"
- key: "Financial fields encrypted"
- scroll: "Append-only audit log"
- download arrow: "Export any screen to Excel / CSV"

**VO.**
> Behind it all: company single sign-on, role-based access scoped to each hub, encrypted financial
> data, a tamper-proof audit log, and Excel export on every screen.

### Scene 12 — Close (6:10–6:30, 20 s)

**Visuals.** Five screen thumbnails arrange themselves into a loop with arrows between them:
**Prioritization Matrix → Capacity → Schedule engine (centre, glowing) → Dashboard → Project
Workspace →** back to the Matrix. They then collapse into the "RPD" logo on an off-white background.
The music swells gently.

**On-screen text.**
- "Decide who goes first. Know what you can deliver. Track what really happens."
- Final card: "RPD Web Application, for Frigoglass R&D & Product Development"

**VO.**
> The Matrix decides who goes first. Capacity shows what's possible. The engine turns both into one
> schedule. The Dashboard tells leadership what finishes this year. And the Workspace keeps that
> plan honest. One plan, one source of truth.

---

## D. Hard rules for the generator

- **No real people.** No faces, no real employee names or photos. Engineers appear as faceless
  silhouettes or as "Engineer 01" style placeholders. Avatars show initials only.
- **No real commercial data.** Never show real TCOGS, margins, selling prices or customer names.
  Financial columns show masked bars or obviously sample values.
- **No other companies' logos.** Don't show any third-party brand marks, including customer brands.
  The hard-gate text says "Customer certification at risk", with no logo.
- **On-premise message.** Never depict the app as a public cloud or SaaS product. The only cloud
  icon is the optional AI model in Scene 10, shown outside the network boundary after redaction.
- **Keep the sample numbers consistent across scenes:**
  - pipeline 236
  - within year 142, spillover 61, blocked 9, left out 24
  - week 31
  - design 375 / 579, lab 192 / 478
  - scored 214, unscored 22, hard-gate 11
  - bands P1 38, P2 71, P3 64, P4 41
- **Spelling of terms:** "Prioritization Matrix", "RPD Capacity", "Global RPD Dashboard",
  "Project Workspace", "Ask the agent", "P1–P4", "A+ / A / B / C".
