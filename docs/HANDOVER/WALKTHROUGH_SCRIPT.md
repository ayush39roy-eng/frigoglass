# RPD Web Application — Walkthrough Script

A spoken script for presenting the application end to end. Running time is about 15 minutes.
**[SCREEN]** lines are what to have open. Everything else is what you say. Numbers in
`[brackets]` should be read off the live screen on the day, because they change with every
schedule run.

---

## 1. Opening — the problem (1 min)

**[SCREEN]** Login page, then the Dashboard.

> Today Frigoglass plans its whole R&D and Product Development portfolio in a spreadsheet. That's
> about 236 active projects across six hubs: R&D Greece, R&D India, PD India, PD Romania, and the
> two OEM hubs, HCK and Seltek.
>
> A spreadsheet can list projects. It can't answer the question leadership actually asks: *given
> the engineers and lab chambers we really have, which of these projects will finish this year,
> and which won't?*
>
> That question is what this application answers. It runs on Frigoglass's own servers, inside the
> corporate network. It isn't a cloud product, and you sign in with your normal company account.

## 2. How it works, in one minute (1 min)

> Under every screen there's a scheduling engine. Each project goes through 14 workflow steps,
> from Marketing Brief through to Commercialization. Each step is one of three kinds:
>
> - **Design** steps need the project leader's time.
> - **Lab** steps need a test chamber in the right region.
> - **Elapsed** steps just take calendar time, like waiting on a supplier.
>
> How long each step takes comes straight from your own lead-time table, by category: A+, A, B, C
> and the three OEM categories. An A+ project is about 44 weeks of work and a C project about 8.
>
> The engine places every step of every project on a 78-week horizon. Higher-priority projects
> book first, and no engineer or chamber gets double-booked. What comes out is a schedule. Every
> number on every screen is read from that one schedule, so the Dashboard, Capacity and the
> Timeline can never disagree with each other.

## 3. Global RPD Dashboard (2–3 min)

**[SCREEN]** Dashboard.

> This is the portfolio at a glance, and the screen leadership will live on.
>
> **Top row: pipeline.** We have `[N]` projects in the pipeline. That splits into spillover,
> meaning projects carried over from last year, and newly registered ones.
>
> **Planning clock.** We're in week `[31]` of the year, with `[21]` weeks left. Everything here is
> measured against week 52.
>
> **Completing within the year.** This is the headline: `[X]` projects will finish by week 52.
> That number isn't typed in or estimated. It's counted from the latest schedule run. A project
> counts only if its last step, plus any recorded delay, lands on or before week 52.
>
> **Delivery gauge.** Every project falls into exactly one bucket: completing this year, spilling
> into next year, blocked, or left out. Left out means the engine found no slot for it anywhere in
> the 78 weeks with current resources.
>
> **Status overview.** In Buyoff, Under Industrialization, In Development, In Queue.
>
> **Hub × type pipeline.** The same picture broken down by hub and project type, so each hub head
> sees their own row.
>
> **Portfolio analytics.** Filter by hub, category, status or priority and the charts follow.
>
> The chips at the top show *which* schedule run these figures come from and when it was run.
> That way nobody presents stale numbers without knowing it.
>
> And any project here is clickable. That takes you to its workspace, which I'll show later.

**[SCREEN]** Briefly open *All Projects*.

> All Projects is the full register, filterable by hub, category, status and priority. It's the
> fastest way to find a single project.

## 4. Prioritization Matrix (3 min)

**[SCREEN]** Prioritization Matrix.

> This screen decides *who goes first*. Because the engine books projects in priority order,
> priority directly changes who gets engineers and chambers.
>
> Every project is scored 1 to 5 on **13 dimensions** grouped into five pillars:
>
> - **Strategic Alignment**: strategic project, new customer, new options.
> - **Regulatory & Quality**: regulatory compliance, quality improvements.
> - **Financial Return**: RM savings, total RM savings, gross margins, profitability.
> - **Market & Volume**: annual volume, 3-year volume, new models.
> - **Investment & Feasibility**: CAPEX. This one is inverted, so lower investment scores higher.
>
> Each dimension has a weight, and they add up to 280. The weighted total becomes a percentage:
>
> - 70% and above is **P1**
> - 55% and above is **P2**
> - 40% and above is **P3**
> - below that is **P4**
>
> **Hard gates** override the score. A regulatory deadline within six months, a Coke or Pepsi
> certification at risk, or an active safety non-compliance forces the project to P1, whatever it
> scored. You'll see the hard-gate badge on those rows.

**[SCREEN]** Open the scoring rubric panel, then the portfolio summary.

> The rubric is always visible, so scorers apply the same scale. The portfolio summary shows how
> many projects are scored, how many aren't yet, how many were forced to P1, and how the bands are
> distributed.
>
> Financial columns can be viewed in **EUR, USD or INR**, and they're split between new-model
> projects and RM-saving projects. Exchange rates are configurable, not hard-coded.

**[SCREEN]** Scenario panel: stage a score change without applying it.

> This is the part planners like most: **scenario mode**. I can change scores and see the
> priorities shift without committing anything. Nothing touches the live plan.
>
> When we're happy, **Apply Priorities** commits the bands. That's versioned, so the version
> history shows exactly who changed which priority and when, and it marks the schedule for
> recalculation.

## 5. RPD Capacity (2–3 min)

**[SCREEN]** RPD Capacity.

> The Matrix decides who goes first. Capacity tells you whether there's enough people and kit to
> go round.
>
> **Headline cards.** Design load against design capacity, `[375]` of `[579]` engineer-weeks, and
> lab load against lab capacity, `[192]` of `[478]` chamber-weeks.
>
> The capacity side uses **your own workbook's formulas**. For engineers, it's 52 weeks minus
> national holidays, medical, casual and annual leave, scaled by each engineer's FTE. For chambers,
> it's 52 weeks minus holidays, maintenance, breakdown and calibration, multiplied by efficiency and
> by the number of platforms. Because we're already in week `[31]`, it also shows how much
> *remaining* capacity is left this year, not just the yearly total.
>
> **Load vs. capacity per hub.** This shows where the bottleneck is: which hub is short of
> designers and which region is short of chambers. The gap and completion percentage are shown per
> hub.
>
> **Class breakdown.** Of the A+, A, B and C projects, how many can be delivered and how many are
> left out. This is usually where the conversation with leadership starts: *we're dropping
> `[n]` A-class projects; do we add an engineer or a chamber, or accept it?*
>
> **Resource utilization matrix.** Chambers by week, shown as a heatmap, so you can see exactly
> which weeks a chamber is full.

> One honest note, which the screen also states. FTE, efficiency and downtime feed the *capacity
> figures*, but the week-by-week booking still treats an engineer as available or not, and gates a
> chamber on its platform count. That's a deliberate, documented decision. And engineer-by-engineer
> utilization is held back until Frigoglass's data protection officer signs off, because under
> GDPR it's personal data.

**[SCREEN]** Briefly show Capacity Planning.

> Capacity Planning is where hub planners maintain the inputs: engineers, their FTE and which
> categories they may lead, plus chambers, platforms, efficiency and which steps they can run.
> Planners only see their own hub.

## 6. Timeline (Gantt), briefly (1 min)

**[SCREEN]** Project Execution Timeline.

> This is the schedule itself. One row per project, expandable to its 14 steps. Solid bars are
> planned work and hatched bars are actuals and delay. Badges flag conflicts and left-out projects.
> Two marker lines per project show the *expected* finish and the *projected* finish, so you can
> see slip at a glance. The strip at the bottom shows weekly load.

## 7. Project Workspace and Ask the agent (3 min)

**[SCREEN]** Click any project to open its Workspace.

> Everything so far is a *planner*: it says what should happen. The Workspace makes this a
> *tracker*, because it records what actually happened.
>
> **Header.** Hub, category, priority and a **health badge**: On Track, At Risk, Off Track,
> Blocked or Left Out. Like everything else, it's derived from the schedule. Nobody types it in.
>
> **Progress panel.** The 14 stages, each with a status (Not Started, In Progress, Blocked or
> Done), percent complete, actual dates and remaining weeks. The overall progress bar is weighted
> by stage length, because Design Detailing is far bigger than Commercialization.
>
> This matters on day one. Most real projects are already halfway through something. Done stages
> become fixed history, in-progress stages schedule only their remaining time, and the rest
> schedule normally.
>
> Updating progress **doesn't** silently reshuffle fifty other projects. It marks the schedule as
> stale. You press **Recalculate** when you're ready, and that creates a new schedule version, so
> you can always see what the plan looked like before.
>
> **Files.** Drawings, test reports and certifications, with versioning. Uploading the same
> document again creates v2, not a duplicate.
>
> **Activity.** Comments and system events in one feed, so "why did this slip?" usually has its
> answer right next to the event that caused it.

**[SCREEN]** Ask the agent panel. Type: *"Which stage is this project waiting on, and is it going
to finish this year?"*

> Finally, **Ask the agent**. You can ask a plain-English question about *this one project*:
> what's blocking it, when it will finish, what changed recently. It answers from the project's
> own data.
>
> Three safeguards are built in:
>
> 1. **It only sees what you can already see.** It's a faster way to read the page, not a new way
>    to access data.
> 2. **Financial data and names never leave the system.** TCOGS, margin, selling price and
>    customer name are stripped out before the question is sent, whatever your role. Engineers are
>    described by role, never by name. If someone asks it to "tell me the customer name", it can't,
>    because the name was never sent.
> 3. **It's switched off by default.** Right now it runs on an external AI service, Groq, for this
>    demo. Before it's switched on in production, Frigoglass needs to decide whether that's
>    acceptable or whether you'd prefer a model hosted on your own servers. Swapping the provider
>    is a small, contained change. Every question asked is audit-logged.

## 8. Security and governance (30 sec)

> Briefly, on security: single sign-on with your company identity provider. Role-based access
> (Super Admin, Admin, Portfolio Manager, Hub Planner, Engineer, Executive Viewer, Auditor), with
> hub planners limited to their own hubs. Financial fields are encrypted at rest and never written
> to logs. Every change goes into an append-only audit log the Auditor role can review, and every
> screen exports to CSV or Excel.

## 9. Close (30 sec)

> To sum up: the **Matrix** decides who goes first. **Capacity** shows whether we have the people
> and chambers. The engine turns both into one schedule. The **Dashboard** tells leadership what
> finishes this year. And the **Workspace**, with Ask the agent, keeps that plan honest with what's
> really happening on each project.
>
> Questions?

---

### Likely questions, and short answers

- **"Can I trust the within-year number?"** Yes. It's counted from the stored schedule run and
  never calculated separately, and the run it came from is shown on screen.
- **"What if I change a priority?"** Try it in scenario mode first. Applying it is versioned and
  marks the schedule stale. Recalculate to see the effect.
- **"Why isn't engineer-level utilization shown?"** It's GDPR personal data and is waiting on DPO
  sign-off (Open Question #8).
- **"Does Ask the agent send our data to the cloud?"** Only in the demo, only redacted, and it's
  off by default. Whether it's allowed in production is Frigoglass's call (Open Question #23).
- **"Where do the durations come from?"** Your own lead-time table from the 2025-26 pipeline
  workbook. A Super Admin can edit it on Workflow Settings.
