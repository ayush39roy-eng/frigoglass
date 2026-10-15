# Video script: Prioritization matrix + dynamic planning (real 2026 data)

Length: about 2:00. Data: the client's 2026 pipeline (253 projects), live run v2, week 42.
Every figure below was read from the live database on 2026-10-13. The drag result comes from
an exact dry run of the same scheduler on the same data, so check it on screen.

## Before recording

- Open the app at http://localhost:5173 as `admin@example.com`. The header shows **W42 of 52**.
- The Dashboard should show **Within year 107 · 51%**.
- Find **Safe cooler kit implementation-FV1000** in the **P3** column of the Priority board.
- To record again: drag Safe cooler back to P3 and wait for the recalculation. The numbers return
  to the ones in this script.

---

### Scene 1 · 0:00–0:15 · Dashboard
**Screen:** Dashboard, hover the Within year tile (107 · 51%).

> "This is Frigoglass's live 2026 pipeline: 253 projects, week 42 of 52. Today 107 projects in the
> plan, 51%, finish this year. Two things decide that number: priority, and capacity."

### Scene 2 · 0:15–0:45 · Prioritization matrix: a top project
**Screen:** Matrix, open **FV1000sz Heineken 2026 Cladding** (PD-India, category C, leader Pawan).
Show the 13 scores.

> "Every project is scored 1 to 5 on 13 dimensions in five pillars. Strategy, regulation and
> finance carry a weight of 25 each, market and volume 15, and CAPEX 10. CAPEX is inverted, so a
> cheaper project scores higher.
> Heineken's cladding scores mostly 4s and 5s: 1,260 points out of 1,400. That's **90%**. Seventy
> and above is **P1**, fifty-five is P2, forty is P3, and below that is P4. It is also Marketing's
> number-one ask, so it sits firmly in P1."

On-screen arithmetic: strategy, regulation and finance 40 × 25 = 1,000; market 14 × 15 = 210;
CAPEX 5 × 10 = 50. Total **1,260 / 1,400 = 90%**.

### Scene 3 · 0:45–1:00 · Matrix: a mid project
**Screen:** Matrix, open **Safe cooler kit implementation-FV1000** (PD-India, category B, In Development).

> "Compare the Safe cooler kit for the FV1000. It's mostly 2s and 3s: 700 points, **50%**, so
> **P3**. The score suggests a band, and the planner commits the priority. A hard gate, such as a
> regulatory deadline, a customer certification at risk or a safety issue, would force it to P1
> regardless of the score."

On-screen arithmetic: 22 × 25 = 550; 8 × 15 = 120; 3 × 10 = 30. Total **700 / 1,400 = 50%**.

### Scene 4 · 1:00–1:20 · Priority board
**Screen:** Priority board. Pan across P1, then P2, P3 and P4. Point out the Heineken card and the
twelve Frameless Lookalike Door cooler cards (S-35 to S-1100) in P1. Stop on Safe cooler in P3,
which shows **Past W52 → 2027**.

> "The Priority board is the whole portfolio as a Kanban. P1 holds Marketing's top asks: the
> Heineken cladding and twelve Frameless door-cooler variants. Down in P3, the Safe cooler kit is
> planned to finish just past week 52, so it spills into 2027. The business says it can't wait."

### Scene 5 · 1:20–1:45 · Dynamic planning: the drag
**Screen:** Drag **Safe cooler kit** from P3 to **P1**. The *Timeline updated* panel opens; hold on it.

> "I drag it to P1, and that's all I do. The plan recalculates by itself, using the same engineers,
> lab chambers and lead times.
> Safe cooler now finishes in **week 48**, inside the year. But capacity is real. It shares its
> engineer with two other PD-India projects. **Migration of Coke SAF models to EC28 for Nigeria
> CCEP** moves from week 49 to **week 53**, and the S35 roller bracket moves from week 45 to 47."

Expected panel (from the dry run; confirm on screen):

| Project | Before | After |
|---|---|---|
| Safe cooler kit implementation-FV1000 | W53 · spillover | **W48 · within year** |
| Migration of Coke SAF Models to EC28 (Nigeria CCEP) | W49 · within year | **After W52 · spillover** |
| Inbuilt roller in roller bracket S35 | W45 | W47 |

### Scene 6 · 1:45–2:00 · Back to the Dashboard
**Screen:** Dashboard, Within year still **107 · 51%**.

> "So the year total holds at 107. One project came in, one went out, and everyone can see exactly
> which one and why. That's dynamic planning: score, prioritise, re-plan, with the trade-off in plain
> sight."

---

**Wording:** say "dynamic planning", not "dynamic programming". The engine is a priority-ordered,
week-by-week scheduler, not dynamic programming.
