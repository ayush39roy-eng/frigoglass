# Data reconciliation 2026 — capacity figures, inputs and the client's workbooks

Written 2026-10-22 (reconciliation task, docs only; no application code or seed changed). This is
the one authoritative comparison of every figure the RPD Capacity panel shows, and every input
behind it, against the client's two workbooks and their older app. Companion documents:
`docs/ADR/0041-per-project-effort-and-capacity-roster.md` (draft, Proposed — per-project effort,
load definition, selection, types, hub spelling, chamber stages), `docs/ADR/0042-oem-hubs-under-
greece-capacity.md` (Accepted — OEM hubs are capacity children of R&D-Greece,
`engineers.counts_in_capacity`, Theoni → R&D-Greece; implemented in P29) and
`docs/OPEN_QUESTIONS.md` #64–#75.

Every number here was computed by scripts over the source files (Appendix A); none is typed from
memory. Cell references are to the workbooks as received. Financial fields and customer names are
not reproduced.

## 0. Sources and conventions

| Id | Source | Date / version | What it holds |
|---|---|---|---|
| **FW** | `~/Downloads/Formual-2025-26 Global RPD Project Pipeline.xlsx` (= `reference/Formula-2025-26 ….xlsx`) | file 2026-09-15, received 2026-09-27 | `RPD Capacity` (roster I39:T50, calendars I53:T61, chambers I64:Z95, capacity rows 3–9, pivot C18:J38), `Final RPD` (lead times rows 1–14, conversion table rows 21–29). **No project sheet**: `2024-25-26 Projects` was deleted from this file; the pivot's data survives only in its cache (§4). |
| **MW** | `~/Downloads/24-25-26 Global RPD Project Pipeline.xlsx`, sheet `2024-25-26 Projects` | file 2026-10-22 13:00 | 618 rows with a Project Name (header row 5, data from row 6). Columns referenced 0-based: 1 request date, 2 Marketing Priority, 3 capacity flag, 4 category, 5 type, 6/7 codes, 8 name, 9 plant, 10 hub, 16 Process Design Man Week, 17 Actual Design Man Week, 18 Certification Testing Required, 21 Lab Weeks-Process Derived, 22 Lab Week for Safety testing, 23 Actual Testing Time, 24 Safety Certification Required, 25/26 safety timelines, 28–31 reliability / OEM review, 32 status, 34 leader, 44 customer, 45 end date LATEST, 52 Development Step, 53/54 plan start/end, 55–58 spillover / completed flags. |
| **CA** | Client's older app, clone at `~/.gemini/antigravity-ide/scratch/RPDCHARTERV1del` | data of 2026-05-11 (`updatedAt`) | `production_seed.json` (239 projects, 17 engineers, 10 chambers, 28 step templates), `public/data.xlsx` (`Design Resource & Capacity`, `Lab Capacity`, `For Gannt- time activity wise`), `RPD_Engineer_Input_Platform (6).xlsx` (`RESOURCE REF`, 19 names), `src/constants.js`, `src/components/Capacity.jsx`, `src/utils/effortUtils.js`. |
| **APP** | Our application | dev DB `rpd-pg-dev`, active greedy run v1 (CW 42, 2026-10-21) | `backend/seed/client_2026_seed_data.json` (253 projects, roster 19), `backend/seed/client_2026.py`, `backend/domain_constants.py`, tables `engineers`, `hub_work_calendars`, `chambers`, `projects`, `project_workflow_steps`, `schedule_run_project_steps`. |

Conventions: "flag = Y" means MW column 3 `Project to be considered for Capacity Calculation` = `Y`
(262 rows; the only other value is blank, 356 rows). "Open" means MW status ∈ {In Que, Development,
Industrialization} (app: In Queue, In Development, Under Industrialization) — On Hold is not open.
"cert = Yes" means MW column 18 = `Yes` (`No` and blank are both not-Yes). Lab figures are per lab
region (India = R&D-India + PD-India; Greece = R&D-Greece + both OEM hubs; Romania = PD-Romania).
**Capacity hubs** (ADR 0042): Greece = R&D-Greece + OEM-HCK + OEM-Seitek; R&D-India; PD-India;
PD-Romania. `OEM-Seitek` is the client's spelling of the hub the app calls `OEM-Seltek` (decision f).

---

## 1. Headline reconciliation — the Capacity panel

### 1.1 The client's own full-year figures, recomputed from the live sheet

Definition (owner ruling 2026-10-22, decision a): **full-year load = every row flagged Y, every
status except Cancelled**, Σ col 16 — projects Commercialized during 2026 consumed this year's
capacity, and On Hold projects are still booked. Capacity = the FW roster (§2.4). Booked % =
load / capacity; completion % = capacity / load (FW column I).

| Capacity hub | Capacity, FW (J54, M54, P54, S54) | Projects | Full-year design load (flag Y, excl. Cancelled) | Booked % | Completion % | With the 7 flagged Cancelled rows (the pivot's basis) |
|---|---|---|---|---|---|---|
| **Greece** = R&D-Greece + OEM-HCK + OEM-Seitek | **124.88** | 29 | **243** | **194.6** | **51.4** | 243 (no Cancelled) |
| · R&D-Greece own | (2.8 FTE: Dimopoulou 1, Lioumis 1, Kanarios 0.8) | 5 | 65 | | | 65 |
| · OEM-HCK | — | 12 | 60 (In Que 10, Development 45, On Hold 5) | | | 60 |
| · OEM-Seitek | — | 12 | 118 (In Que 5, Development 73, On Hold 40) | | | 118 |
| **R&D-India** | **87.87** | 30 | **150** (In Que 20, Development 111, Industrialization 19) | **170.7** | **58.6** | 150 |
| **PD-India** | **252.62** | 176 | **658** (In Que 263, Development 113, Industrialization 102, On Hold 51, Commercialized 129) | **260.5** | **38.4** | 690 / 273.1 % (5 Cancelled, 32 wk) |
| **PD-Romania** | **165.00** | 20 | **375** (Development 60, Industrialization 40, On Hold 165, Commercialized 110) | **227.3** | **44.0** | 415 / 251.5 % (2 Cancelled, rows 436 and 597, 40 wk) |
| **Σ** | **630.37** | 255 | **1426** | **226.2** | **44.2** | 1498 |

PD-Romania's 375 is 9 On Hold projects (rows 425, 459, 584, 585, 587, 589, 595, 596, 622: 6 × B 20
+ 3 × C 15 = 165), 6 Commercialized (rows 415, 418, 552, 583 at B 20 and 420, 588 at C 15 = 110), 3
Development (rows 600–602, 60) and 2 Industrialization (rows 414, 598, 40). Romania enters **20 wk
per B project and 15 per C**; India enters 4 / 3 (§2.2).

Remaining-year load (decision a) counts open statuses only: Greece 198 (65 + 55 + 78), R&D-India
150, PD-India 478 (129 projects), PD-Romania 100 (5) on the flagged set; against FW's remaining
capacity (computed at week 15/17) or the app's (week 42) as served.

Lab, same definition (flag Y, excl. Cancelled, Σ col 21 over all rows — the pivot applies no
cert filter, §3 W9): India **611.5** vs 186.22 (328 %), Romania **854** vs 216.30 (395 %; 12 rows at
70 wk), Greece **4** vs 72.96 (5.5 %). Cert = Yes rows only: 582 / 560 / 4. FW's own lab cells E5/E7/
E9 show 621.5 / 65 / 413 (E7 and E9 sum the wrong field, W4).

### 1.2 Every basis side by side — design load (man-weeks, full year)

| Capacity hub | FW pivot as filed (E3, E4, E6, E8) — **stale** | Client rule on live MW (flag Y, excl. Cancelled) | Same, open only | APP today: active run, Σ design-kind step durations (2026 set) | APP today: demand on the app's table (2026 set, open, `project_workflow_steps`) | **Proposed** (ADR 0041): 2026 ∪ flag Y, excl. Cancelled, col 16, table when blank |
|---|---|---|---|---|---|---|
| Greece (own + OEM) | 65 + 60 + 118 = 243 | **243** | 198 | 32 + 10 + 0 = **42** | 48 + 55 + 44 = 147 | **266** (77 + 62 + 122 raw, + table 5 for the one blank OEM-HCK row) |
| · R&D-Greece own | 65 | 65 (5 proj) | 65 | 32 (3 booked) | 48 | 77 (6) |
| · OEM-HCK | 60 | 60 (12) | 55 (11) | 10 (2) | 55 | 67 (13; 1 blank) |
| · OEM-Seitek | 118 | 118 (12) | 78 (11) | 0 | 44 | 122 (13) |
| R&D-India | 38 | **150** (30) | 150 | **201** (24) | 298 | **150** (30) |
| PD-India | 794 | **658** (176) | 478 (129) | **500** (74) | 1078 | **884** (198; 698 raw → 704 after rounding 12 rows at 1.5 up to 2, + table 180 for 18 blank rows) |
| PD-Romania | 455 | **375** (20) | 100 (5) | **138** (13) | 138 | **534** (40; 384 raw + table 150 for 17 blank rows; **675** at Romania's 20/15 convention) |
| **Σ** | 1530 | **1426** | 926 | 881 | 1661 | 1834 |

Why every column differs is explained in §5. The two numbers the client compares are the FW pivot
(794 for PD-India) and the app (500). Neither is what the live sheet says (658 under the client's
own definition), and the app's demand on its table is 1078 because the app's B/C design effort is
10/6 weeks per project against the client's typed 4/3 (§2.2).

### 1.3 Design supply (man-weeks)

| Capacity hub | FW (J54, M54, P54, S54) | FW remaining (K54, N54, Q54, T54; CW 15 India / 17 Europe, India's fraction everywhere) | CA `data.xlsx` r19 | CA app (`Capacity.jsx`: Σ fte × flat 44/46 wk) | APP today (23 engineers, CW 42) | APP remaining today | **After P29 (ADR 0042): counted roster** | After P29 remaining (CW 42) |
|---|---|---|---|---|---|---|---|---|
| Greece (own + OEM) | 124.88 | 83.26 | 124.88 | 128.80 | 124.88 + OEM-HCK **44.17** (Theoni) | 24.02 + 8.49 | **124.88** | 24.02 |
| R&D-India | 87.87 | 62.52 | 43.93 | 88.00 | **132.50** | 25.48 | **88.33** | 16.99 |
| PD-India | 252.62 | 179.75 | 252.62 | 209.00 | **342.29** | 65.83 | **253.96** | 48.84 |
| PD-Romania | 165.00 | 109.90 | 165.00 | 165.00 | **253.00** | 48.65 | **253.00** (Elena Micu + Marian counted) / 165.00 if not | 48.65 / 31.73 |
| **Σ** | 630.37 | 435.43 | 586.43 | 590.80 | 896.84 | 172.47 | 720.17 / 632.17 | |

The 0.46 / 1.34 differences between FW and the app on R&D-India / PD-India are FW's own medical-
leave divisor (§3, W1), not an app error. Remaining-year figures are not comparable between FW
(week 15/17) and the app (`CURRENT_WEEK = 42`).

### 1.4 Lab (platform-weeks, full year)

| Region | FW as filed (E5, E7, E9) | Client rule on live MW (flag Y excl. Cancelled, Σ col 21, all rows) | Same, cert = Yes only | APP today: active run | APP today: demand on the app's table (2026 set, open, cert) | **Proposed V3** (col 21 when > 0, else table when cert): open rows / full year | Supply FW (M93, S93, Y93) | Supply APP |
|---|---|---|---|---|---|---|---|---|
| India | 621.5 | **611.5** | 582 | **233** | 438 | 741 / 860 | 186.22 | **188.30** |
| Greece | 65 ← **error** (sums design, W4) | **4** | 4 | **16** | 22 | 32 / 46 | 72.96 | **73.34** |
| Romania | 413 ← **error** (sums *actual design*, W4) | **854** | 560 | **24** | 24 | 350 / 860 | 216.30 | **216.30** |

CA's `Capacity.jsx` lab capacity is Σ platforms × working weeks **without efficiency**: 309.70 /
115.20 / 345.60. The +2.08 / +0.38 app-vs-FW supply differences are FW's flat 2.6 holiday weeks for
every region (W2).

---

## 2. Input-by-input reconciliation

Each row: what Source A (FW) says / Source B (MW) says / the old app says / the app today says /
verdict / fix. "Fix" refers to §6 decisions and the §7 spec.

### 2.1 Project selection and load scope

| Item | FW | MW (live) | CA | APP today | Verdict | Fix |
|---|---|---|---|---|---|---|
| Which projects count | Pivot filter `flag = Y`; title A1 "Spillover Projects and Projects Registered in 2026" | flag = Y: **262** rows = 2026: 185, 2025: 62, 2024: 15. Request-year 2026: **253**. Overlap 185. | 239 projects (2026: 160, 2025: 64, 2024: 12, blank 3) | 253 = request year 2026 only (ADR 0024/0035) | The app ignores 77 flagged 2024/25 rows and includes 68 unflagged 2026 rows (29 Cancelled, 17 Commercialized, 15 On Hold, 7 open; 67 design wk in all, of which Romania's are 0). | Decision (a): import 2026 ∪ flag Y = **330** rows; 77 carry-over; store the flag. |
| Which statuses load the full year | pivot: every status (cache: Commercialized 21, On Hold 20, Cancelled 5) | flag Y: In Que 83, Development 76, Commercialized 42, Industrialization 32, On Hold 22, Cancelled 7 | CA excludes Cancelled and Commercialization | only steps the run booked (open projects) | Owner ruling: full year = all except Cancelled; remaining year = open only. | Decision (a). |

Resulting selection (2026 ∪ flag Y), per hub × status (OEM-SEITEK merged into OEM-Seitek):

| Hub | Total | In Que | Development | Industrialization | On Hold | Commercialized | Cancelled | Carry-over (2024/25) |
|---|---|---|---|---|---|---|---|---|
| R&D-Greece | 6 | 1 | 5 | 0 | 0 | 0 | 0 | 2 (Development 2024, 2025) |
| OEM-HCK | 14 | 3 | 8 | 0 | 2 | 0 | 1 | 1 (On Hold 2025) |
| OEM-Seitek | 14 | 1 | 10 | 0 | 1 | 1 | 1 | 4 (Development 3, On Hold 1; 2025) |
| R&D-India | 30 | 5 | 24 | 1 | 0 | 0 | 0 | 1 (Industrialization 2025) |
| PD-India | 223 | 79 | 35 | 35 | 13 | 36 | 25 | 58 (Commercialized 30, Industrialization 13, In Que 7, On Hold 6, Development 2) |
| PD-Romania | 43 | 3 | 8 | 3 | 12 | 14 | 3 | 11 (On Hold 5, Commercialized 4, Industrialization 1, Cancelled 1) |
| **Σ** | **330** | 92 | 90 | 39 | 28 | 51 | 30 | **77** (2025: 62, 2024: 15) |

Open: 221 (Greece 6 + 11 + 11, R&D-India 30, PD-India 149, PD-Romania 14). In the full-year load
(excl. Cancelled): 300.

### 2.2 Per-project effort (the figure that drives load)

Three different "design weeks per project" exist for category B, and the app uses a fourth:

| Category | FW `Final RPD` C23:C29 "Design Man Weeks/Project" (hand-entered) | FW `Final RPD` R4:R7 "Design Time – Project leader concept" (= Σ lead-time steps A,B,D,E,I,J,K,M for A+/A; **D,E,K,M for B; D,E,K for C**) | APP lead-time design sum (ADR 0007: A,B,D,E,I,J,K,M for every category; verified on `project_workflow_steps`) | MW col 16, typed per project — India | MW col 16 — Romania | FW I23:I29 "Lab Weeks/Project" | FW S4:S7 (F + H) | APP lab sum (F + H) | MW col 21, typed |
|---|---|---|---|---|---|---|---|---|---|
| A+ | 19 | 22 | 22 | 30 (Greece, 1 row) | — | 16 | 12 | 12 | 4 (1) |
| A | 15 | 18 | 18 | 19 ×3, 20 ×1 (Greece) | 0 (2 rows, unflagged) | 14 | 10 | 10 | 6, 8, 80 |
| B | **4** | 8 | **10** | **4 ×91** of 115 flagged non-cancelled; 8 ×10, 7, 0 ×13 | **20 ×17** flagged; 0 ×6 unflagged | 10 | 6 | 6 | India 6 ×16, 10 ×17, 14 ×7; Romania **70 ×12** |
| C | **3** | 4 | **6** | **3 ×56**; 8 ×2, 4, 0 | **15 ×5** flagged; 3 ×4 and 0 ×9 unflagged | 2 | 1 | 1 | 0 or 2 |
| A-OEM | 4 | — | 9 | 15 ×2, 40 (Seitek) | | 6 | — | 8 | — |
| B-OEM | 1 | — | 5 | 5 ×16, 3, 10 ×2 | | 6 | — | 6 | — (cert never Yes) |
| C-OEM | 0.5 | — | 2 | no rows | | 2 | — | 2 | — |

- MW col 16 and col 21 are **typed values** (533 values, 1 formula `=4+3`; col 21: 199 values, 80
  formulas of the form `=3+3`, 339 blank). India types the conversion-table value (B 4, C 3) with
  hand adjustments; **Romania types 20 per B and 15 per C** on every flagged row and nothing on its
  unflagged 2026 rows. They match neither the lead-time sums the app uses (B 10, C 6) nor FW's own R
  column (B 8, C 4).
- **Correction to the briefing**: the app does not schedule B = 8 / C = 4. ADR 0007 made PDD-A and
  PDD-J design-kind for every category (OQ #13), so the app's B design effort is 10 and C is 6 (DB:
  all 138 B projects Σ design = 10, all 83 C = 6). FW's R6/R7 omit A and J (W5).
- Romania's unflagged 2026 rows (Excel rows 607–621, S.No 596 repeated; In Que 3, Development 5,
  Industrialization 1, On Hold 3, Commercialized 8, Cancelled 1) carry **no design or lab figure**
  (17 of the 20 non-cancelled are blank; 3 Commercialized C rows carry 3). A per-project import must
  fall back for them: category table (A 18 / B 10 / C 6 → 150 wk over the 17; 98 over the 9 open
  rows) or Romania's own convention (B 20 / C 15, A at table 18 → 291; 166 over the open rows).
  Decision (b) uses the table and asks (OQ #67).
- CA's live templates give B design 7 (D1+E2+I2+K2), B lab 9 (F2+H4+J1+L2); its `calcEffort` also
  skips early steps by type/status. 26 of 239 CA projects carry `customDesignTime = 2`, 3 carry 1,
  2 carry 0; 6 carry `customLabTime` — the per-project override idea existed there too.
- Blank col 16 on 25 of 221 open rows (PD-India 15, PD-Romania 9, OEM-HCK 1) and on 36 of 300
  full-year rows (PD-India 18, PD-Romania 17, OEM-HCK 1); blank col 21 on 50 cert = Yes open rows
  (R&D-India 28, PD-India 19, Greece 3).
  13 open rows have col 21 > 0 with cert ≠ Yes (PD-India C 10 rows × 2–4 wk, PD-India B 0.5,
  PD-Romania B **70**, R&D-Greece B 6).
- Verdict: the client's figure is per project and per hub convention. Fix: decision (b) / ADR 0041.

### 2.3 Lead-time table (14 steps × 7 categories)

| Source | Cells | Result |
|---|---|---|
| FW `Final RPD` rows 4–7 (PDD), 12–14 (OEM) | C4:P7, C12:P14 | identical to `domain_constants.LEAD_TIME_SEED` and to `workflow_lead_times` (98 cells) — **match** |
| CA `data.xlsx` `For Gannt- time activity wise` rows 6–9, 17–19 | | identical to FW — match |
| CA `src/constants.js` `DEFAULT_TEMPLATES` | | matches except PDD-L: B 2 (FW 1), C 1 (FW 0) |
| CA live templates (`production_seed.json`) | | PDD-E B 2 (FW 4); PDD-F B 2 (FW 0); PDD-H B 4 (FW 6); PDD-I B 2 (FW 0); PDD-L B 2, C 1 (FW 1, 0); PDD-M B 0 (FW 1). **Gaps/overlaps** (every category): PDD-F −3, PDD-H −1, PDD-I −5, PDD-J +3, PDD-K +1, PDD-L +2, PDD-N +1. OEM rows match. |
| Step kinds | FW/CA "Responsible for activity" row: PDD-A Marketing; PDD-F "Lab weeks"/R&D; PDD-H Lab; PDD-J, L, N "engineering"; OEM A, B, G, H "R&D Resource"; OEM C, F Marketing; OEM D, E, I–N "done by OEM" | APP: A design, F/H lab, J/K/M design, L/N elapsed; OEM A, B, D, G, I, J, K, M design. CA code treats F, H, **J, L** as lab steps and N as design. OQ #13/#14/#61; the OEM "R&D Resource" reading is now ADR 0042's basis. |

Verdict: the table is right; the old app's negative gaps (overlap) are a precedence feature the app
expresses through `predecessor_ids` (ADR 0009). Fix: none for the table.

### 2.4 Engineer roster and FTE

| Engineer | FW `RPD Capacity` I42:T50 (hub, FTE, remark) | CA `data.xlsx` r5–r15 (older, FTE, remark) | CA app `production_seed.json` | APP today | **After P29 (ADR 0042 §5) / proposed** |
|---|---|---|---|---|---|
| Rishi | PD-India **1** | **0.5** "PLM and other miscellaneous activities so 0.5 considered for Projects" | 0.5, types M/A/B/C | 1.00 | 1.0, counted (FW is later; OQ #65) |
| New Hiring | PD-India 0 "To be hired" | 0 | — | not created (OQ #53) | unchanged |
| Lokesh / Zakir / Pawan | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | unchanged |
| Nikhil | 0.75 | 0.75 "less than 1 year" | 0.75 | 0.75 | unchanged |
| Atul | **0.5** | **0** "Plant support & Field issues" | 0 | 0.50 | 0.5, counted (OQ #65) |
| Rahul-Contractual | 0.5 "3rd Party" | 0.5 | 0.5 | 0.50 | unchanged |
| New engineer-Contractual | 0 "3rd Party" | 0 | — | not created | unchanged |
| Ashish | R&D-India 1 | India R&D block, 1 | R&D-India 1 | R&D-India 1.00 | unchanged |
| Praveer Kumar Singh | R&D-India 0.5 | listed in the **India PD** block, 0.5 | R&D-India 0.5 | R&D-India 0.50 | unchanged |
| Ayush Kumar | R&D-India 0.5 "3rd Party" | India PD block, 0.5 | R&D-India 0.5 | R&D-India 0.50 | unchanged |
| Dimopoulou / Lioumis | Greece 1 / 1 "R&D resource" | 1 / 1 "A only" | 1 / 1 (Dimopoulou chip `OEM`) | 1 / 1 | + OEM categories (ADR 0042 §6) |
| Kanarios | Greece 0.8 "Sourcing" | 0.8 | 0.8 | 0.80 | + OEM categories |
| Stef Marius / Alin Boboc / Adrian Bortoc | Romania 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | unchanged |
| Bianca | Romania 0.75 | 0.75 "C only" | 0.75 | 0.75 | unchanged |
| **Dipak** | — | — | — (not a CA leader) | R&D-India 1.00 (ADR 0035 provisional) | 1.0, `counts_in_capacity = false`; leads 52 (R&D-India 28, PD-India 24) |
| **Elena Micu** | — | `RESOURCE REF` r19: PD-Romania | — | PD-Romania 1.00 | 1.0, counted, "not in capacity roster — confirm" (OQ #66); leads 15 (4 open) |
| **Marian** | — | `RESOURCE REF` r20: PD-Romania | — | PD-Romania 1.00 | 1.0, counted, confirm; leads 2 (0 open) |
| **Theoni** | — | — | — | OEM-HCK 1.00 | R&D-Greece, not counted (ADR 0042); leads 12 (OEM-HCK 5, R&D-Greece 4, OEM-Seitek 3) — OQ #64 |
| **Antonis**, **Sailesh** | — | — | — | PD-India 1.00 each | not counted; 1 project each |
| **Vaggelis** (appears with the carry-over rows) | — | — | — | — | R&D-Greece, 1.0; 1 A+ Development project requested 2025 ("NGC 450 Project B rating"). **Not in ADR 0042's list** — treat like the four (not counted) and ask (OQ #64) |
| **Σ FTE** | **14.3** (5.75 / 2.0 / 2.8 / 3.75) | 13.3 (5.75 incl. Praveer + Ayush / 1.0 / 2.8 / 3.75) | 13.3 (4.75 / 2.0 / 2.8 / 3.75) | **20.3** (7.75 / 3.0 / 2.8 / 5.75 / OEM-HCK 1.0) | counted **16.3** (5.75 / 2.0 / 2.8 / 5.75), or 14.3 without Elena/Marian |

Verdict: the six (now seven) provisional leaders at 1.0 FTE inflate supply by 6.0 FTE (+266 man-
weeks); FW is the latest statement of FTE. Fix: ADR 0042 §5 (`counts_in_capacity`, P29-T01) —
nothing further specified here.

### 2.5 Work calendars

| Hub | FW (J57:T60) | APP `hub_work_calendars` | Verdict |
|---|---|---|---|
| PD-India, R&D-India | 6 weekdays; holidays 13/6 = 2.167; medical **7/5** = 1.4; casual 7/6 = 1.167; annual 20/6 = 3.333 → **43.93** wk/engineer (J61, M61) | 6; 13, 7, 7, 20 days, each ÷ 6 → **44.17** | match except the medical divisor (W1): +0.23 wk/engineer |
| R&D-Greece | 5; 12/5 = 2.4; 0; 0; 25/5 = 5 → 44.60 (P61) | 5; 12, 0, 0, 25 → 44.60 | match |
| PD-Romania | 5; 13/5 = 2.6; 7/5 = 1.4; 0; 20/5 = 4 → 44.00 (S61) | 5; 13, 7, 0, 20 → 44.00 | match |
| OEM-HCK, OEM-Seitek | no row | India's calendar (assumption) | retired by P29 (ADR 0042 §1: the capacity hub's calendar applies) |
| Remaining fraction | K55 = 37/52 = 0.7115 (India, CW 15); Q55/T55 = 35/52 = 0.673 (CW 17) but Q57:Q60 / T57:T60 multiply by **$K$55** | one `CURRENT_WEEK` (42), own fraction per hub | FW error (W3); the app's rule is the consistent one |

### 2.6 Chambers

| Chamber (FW I89:Y92) | Platforms | Efficiency | Maintenance | Breakdown | Calibration | FW working wk (J84:Y84, holiday 2.6 everywhere) | APP working wk (region holiday) | FW efficient | APP efficient | CA `workingWeeks` | FW/CA test type (`data.xlsx` `Lab Capacity` H5:H8, M5:M6) | CA `allowedStages` | APP `allowed_stages` | **Proposed** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| India CH-1 (IN-CH1) | 1 | 0.7 | 2 | 1 | 1 | 45.4 | 45.83 | 31.78 | 32.08 | 45.7 | "POC & Industrialization" | F, J, L | F, H | **F** |
| India CH-2 (IN-CH2) | 4 | 0.6 | 2 | 11 | 1 | 35.4 | 35.83 | 84.96 | 86.00 | 35.4 | "ALL test" | all | F | **F, H** |
| India CH-3 (IN-CH3) | 2 | 0.6 | 2 | 7 | 1 | 39.4 | 39.83 | 47.28 | 47.80 | 39.2 | "ALL test" | all | F, H | F, H |
| India CH-4 (IN-CH4) | 1 | 0.5 | 2 | 2 | 1 | 44.4 | 44.83 | 22.20 | 22.42 | 44 | "POC & Industrialization"; FW N93 "Old labs/Chamber 4 only use for reliability"; J69 threaded comment "Only For Industrialization-Non Calibrate" | J, L | none | **F** (client mapping) — OQ #71 |
| Greece CH-1 (GR-CH1) | 1 | 0.7 | 2 | 8 | 1 | 38.4 | 38.60 | 26.88 | 27.02 | 38.6 | "POC & Certification" | all | F, H, OEM-E, OEM-H | unchanged |
| Greece CH-2 (GR-CH2) | 2 | 0.6 | 2 | 8 | 1 | 38.4 | 38.60 | 46.08 | 46.32 | 38.3 | "POC & Certification" | all | F, OEM-E | **F, H, OEM-E, OEM-H** |
| Romania CH-1 (RO-CH1) | 1 | 0.7 | 2 | 3 | 1 | 43.4 | 43.40 | 30.38 | 30.38 | 42.9 | not specified ("New Labs") | all | F, H | F, H |
| Romania CH-2 (RO-CH2) | 4 | 0.6 | 2 | 3 | 1 | 43.4 | 43.40 | 104.16 | 104.16 | 43.3 | " | all | F | **F, H** |
| Romania CH-3 (RO-CH3) | 2 | 0.6 | 2 | 3 | 1 | 43.4 | 43.40 | 52.08 | 52.08 | 43.3 | " | all | F, H | F, H |
| Romania CH-4 (RO-CH4) | 1 | 0.7 | 2 | 4 | 1 | 42.4 | 42.40 | 29.68 | 29.68 | 42.9 | " | all | F, H | F, H |

Platforms, efficiency and downtime match in every source. Working weeks differ only through the
holiday basis (W2); CA's `workingWeeks` are hand-typed and differ by ±0.3–0.5 from FW. FW's
Romania platform-count table N66:N69 says 2/2/2/2 while its capacity table V89:V92 says 1/4/2/1
(same Σ 8; the capacity figure uses 1/4/2/1) — W6. CA's `PDD-J` / `PDD-L` stages are its own
notion of lab steps and have no app equivalent. "Reliability" is not a workflow step anywhere, and
MW columns 28–30 (Reliability Testing Need / Time / Type) are blank on every selected row.

### 2.7 Capacity formulas (supply)

| Figure | FW formula (cells) | APP (`services/capacity_supply.py`) | Verdict |
|---|---|---|---|
| Design, year | `J54 = J61 × C41` (working weeks × Σ FTE) | `working_weeks_per_engineer × Σ fte` (P29: Σ over counted engineers of the capacity hub) | same formula; inputs differ (§2.4, W1) |
| Design, remaining | `K61 = 37 − Σ(deduction × K55)`; `K54 = K61 × C41`; Greece/Romania use `$K$55` | `(52 − CW) − deduction × (52 − CW)/52`, per hub | same formula; FW applies India's fraction to Europe (W3) and a different CW |
| Lab, year | `M89 = J84 × K89 × J89` (working × efficiency × platforms), `M93 = Σ` | identical | match (holiday basis W2) |
| Lab, remaining | `M94 = M93 × $K$55` | `× (52 − CW)/52` | same formula, different CW |
| Gap / completion | `H3 = E3 − G3`; `I3 = G3 / E3` | `gap = load − capacity`; `completion_pct = capacity / load` | match |
| Booked % | not in FW | `load / capacity × 100` (ADR 0016) | app-only reporting figure |

### 2.8 Load figures — what each source actually sums

| Figure | FW (pivot C18:J38 + rows 3–9) | APP today | Verdict |
|---|---|---|---|
| Design load per hub | `E3 = GETPIVOTDATA("Sum of Process Design Man Week", "RPDO hub", …)`: Σ col 16 over **flag = Y rows of every status** (E8 adds B + C only; Romania has only B/C). No OEM row in rows 3–9, although the pivot carries 60 + 118 OEM weeks. Pivot refreshed 2026-06-29 from a 595-row snapshot (§4). | Σ `duration_weeks` of non-skipped **design-kind steps in the active run** → only projects the run booked (74 of 127 open PD-India projects; 126 projects LEFT_OUT, 76 of them with no step rows). Done steps count in full. | Different population (flag vs 2026 request; all statuses vs booked), different per-project figure (typed vs table), different coverage (demand vs booked), OEM not folded into Greece (ADR 0042 fixes the last). |
| Lab load per region | `E5 = GETPIVOTDATA("Sum of Lab Weeks- Process Derived", …R&D-India) + …PD-India` = Σ col 21 over **all** flagged rows (cache check: H26 533.5 = Σ all PD-India rows; cert-only would be 504). `G` ("Count of Certification Testing Required") counts **non-blank** cells (Yes + No: PD-India 128 = 107 Yes + 21 No). `E7`, `E9` sum the wrong field (W4). | Σ lab-kind step durations in the active run; lab steps are skipped when `certification_testing_required = false` (DOMAIN_RULES "Lead times"), which the extractor sets from col 18 = Yes. | **`docs/CLIENT_FORMULAS.md` §2.3 is wrong**: the pivot applies no cert filter ("PD-India C: 18 require testing, 31 lab weeks" reads G29 = 18 non-blank cells and H29 = 31 = Σ over all 60 C rows). W9. |
| "Estimated" load (FW column F) | header only, empty | `estimated_design_weeks` / `estimated_lab_weeks` (0 projects carry one) | unused on both sides |
| Actuals | pivot F ("Sum of Actual Design Man Week": PD-India 615.2) and I ("Sum of Actual Testing Time": 2553) | not imported | MW col 17 on 190 of the 295 open-or-2026 rows (Σ 1049.7), col 23 on 157 (Σ 3642) |

### 2.9 Statuses, leaders, types, hubs, categories

| Item | MW | CA | APP | Verdict / fix |
|---|---|---|---|---|
| Status vocabulary | In Que / Development / Industrialization / On Hold / Commercialized / Cancelled | In Que / Development / Industrialization / On Hold / Commercialization | In Queue / In Development / Under Industrialization / On Hold / Commercialized / Cancelled (+ In Buyoff, Draft unused) | mapping correct |
| Leaders | 23 blank among the 295 open-or-2026 rows (OEM-HCK 9, OEM-Seitek 11, PD-India 1, PD-Romania 1, R&D-Greece 1); "Lokesh/Rahul" ×1; first names Rahul/Stef/Alin/Adrian; non-roster: Dipak 52, Elena Micu 15, Theoni 12, Marian 2, Antonis 1, Sailesh 1, **Vaggelis 1** (carry-over). Every OEM row's leader is Theoni (7 rows) or blank (20). | 26 blank (all R&D-Greece); no Dipak/Elena/Theoni/Marian | alias map; 20 blank; 6 provisional engineers | ADR 0042 §5/§7; add Vaggelis to the provisional list |
| Project type | 330-row selection: CO 106, NO 64, **BC 63**, NM 52, IMP 33, **AC 9**, **SER 2**, **CER 1**; older years also TCO 1. AC: PD-Romania 7 (On Hold 5, Development 1, Cancelled 1), PD-India 2 (On Hold, Industrialization); SER: On Hold 2 | BC 56, AC 9, CER 1, SER 1 in CA's data; CA weights `BC 25, SER 5, CER 15` | enum NM/CO/RC/NO/IMP; BC/AC/SER → `type = null` (67 of 253); `RC` matches no client row | BC = RC, decided (ADR 0038 amendment 2026-10-22, P29-T04); decision (f): add AC and SER |
| Hub name | `OEM-Seitek` (9 rows) and `OEM-SEITEK` (5 rows; 15 in all years); plant list `OEM-Seitek`; FW pivot `OEM-SEITEK` | — | `OEM-Seltek` (from `reference/rpd-platform-prototype.html`, 7 occurrences; the mock-up `.pptx` names no OEM hub) | decision (f): rename to the client's spelling |
| Category | B 138 / C 83 / B-OEM 21 / A 9 / A-OEM 2 in 2026; no C-OEM row anywhere | | OEM rule applied | match |
| Marketing Priority | ranks 1–13 on 36 rows (mostly In Que: 2 ×14, 3 ×5, 1 ×4, 5 ×3 …) + one "Completed" | `priority` 1/2/3 + buckets | P1 for 1–5, P2 for 6–13, else by status; dimension scores synthetic (OQ #56) | unchanged; "Completed" → unranked |

### 2.10 Other MW columns

| Column | What the data holds (295 open-or-2026 rows) | APP today | Finding / fix |
|---|---|---|---|
| 52 Development Step | PDD-H 17, PDD-J 12, PDD-F 4, PDD-I 2, PDD-A 2, OEM-A 2, OEM-B 2, PDD-B/E/N 1 each, "Not Started" 26, blank 225. **24 Industrialization rows carry a step (PDD-B…J), 8 In Que rows carry PDD-A/F/H/J** | used only for In Development (seed `derive_progress`); Industrialization → "first step after H"; In Queue → Not Started | the seeded current step contradicts the sheet on ~32 rows; propose using the column for every open status (OQ #74) |
| 45 End date LATEST | 50 non-blank: 35 datetimes (2026: 22; 2025: 13), 8 Excel serials (7 × 45992 = 2025-12-01, 1 × 46031 = 2026-01-09), 7 strings (`Feb'26` ×2, `Jan'26`, `Dec'25` ×2, `-` ×2) | datetimes + serials parsed; 2025 not imported; `Mon'YY` strings **not parsed** (3 rows with 2026 dates lost) | extractor: parse `Mon'YY` → first of month; `-` → null |
| 53/54 Plan start/end | 9 / 11 non-blank, mixed text ("Aug.24", "wk12", dates) | ignored | ignore (not usable) |
| 55 "Status/2025/2026 Spillover" | codes: R-2026 114, D-2026 20, I-2025 18, D-2025 13, Yes 13, POC 4, I-2026 2, CERT 2 (undocumented) | ignored | ask (OQ #73) |
| 56 "Spillover '25" | Yes/Y on 30 rows: 17 requested 2026, 11 of 2025, 2 of 2024; No 14 | drives `carry_over = true`, `reg_year = 2025` (17 rows) | decision (a): `carry_over` := request year < 2026 (77 rows); keep the flag as `spillover_2025` for display |
| 57 "Completed '26" | Yes ×3 | ignored | display only, optional |
| 58 "Outside PD database" | Yes ×11 | ignored | matches `code_source = generated` rows; optional badge |
| 6/7/0 codes, 8 name | duplicates: PD code `26-00412` ×2, RM code `26ROM005` ×2, S.No 596 on **17 rows** (Romania block 599–622), 392 and 399 ×2; 4 duplicate names (e.g. "Super 550 development in C class" ×2) | unique `external_code` by fallback rules | genuine double entries? (OQ #75) |
| 18 Certification Testing Required | Yes 124, No 18, blank 153 | `true` only for Yes | §2.8 W9: not a load filter in FW; ADR 0041 import rule `Yes OR col 21 > 0` |
| 24 Safety Certification Required | Yes 28 + YES 2, No 17, blank 248 | ignored | import as `safety_certification_required` (case-insensitive) |
| 22 Lab Week for Safety testing | 17 values: 10 ×7, 20 ×5, 15, 4, 0 ×3 (Σ 189; 64 on open rows, PD-Romania 60 + Greece 4) | ignored | import as `safety_lab_weeks` (display; OQ #21) |
| 25/26/27 safety timelines / remarks | free text, 0/1.5 man-weeks | ignored | ignore |
| 17 Actual Design Man Week, 23 Actual Testing Time | 190 / 157 rows (modes 4, 2, 8 wk; 0, 2, 12, 50 wk) | ignored | import as `actual_design_weeks`, `actual_testing_weeks` (display) |
| 28–31 reliability / OEM review | all blank (col 31: one value "3") | ignored | ignore |
| 44 Customer | ALL/All/ALl, COKE/Coke, KA, WM | upper-cased, encrypted | match |
| 3 capacity flag | Y on 262 rows | JSON `capacity_flag`, not stored | store as `projects.capacity_flag` (decision a) |

---

## 3. Workbook-internal inconsistencies (FW unless stated)

| # | Where | What | Effect | Treatment |
|---|---|---|---|---|
| W1 | `J58`/`M58` `=7/5` | India medical leave divided by 5 weekdays; every other India deduction by 6 | 43.93 vs 44.17 working weeks; PD-India supply 252.62 vs 253.96 (+1.34), R&D-India 87.87 vs 88.33 (+0.46) | workbook arithmetic error, not an app error (OQ #59) |
| W2 | `J80:Y80` `=13/5` | lab holiday weeks 2.6 for all regions, while the design calendar uses 13/6 (India) and 12/5 (Greece) | India lab 186.22 vs app 188.30 (+2.08); Greece 72.96 vs 73.34 (+0.38) | same |
| W3 | `Q57:Q60`, `T57:T60` `× $K$55` | Greece/Romania remaining capacity scaled by India's fraction (0.7115, CW 15) instead of their own (0.673, CW 17) | FW remaining Greece 83.26 (own fraction 82.68), Romania 109.90 (109.03) | same; app uses one CW |
| W4 | `E7` `=GETPIVOTDATA("Sum of Process Design Man Week"…R&D-Greece)`; `E9` `=GETPIVOTDATA("Sum of Actual Design Man Week"…B/C PD-Romania)` | Greece "lab load" is the design figure (65; the pivot's lab figure is 4); Romania "lab load" is the *actual design* figure (413; lab is 994 all rows / 630 cert-only) | Greece lab completion 112 % and Romania 52 % in FW are meaningless | copy-paste errors (OQ #69) |
| W5 | `R6 = F6+G6+M6+O6`, `R7 = F7+G7+M7` | B/C design time omits Marketing Brief (A) and Pr. Pr (J), which A+/A include | B 8 / C 4 vs the app's 10 / 6 | OQ #13 open; moot once per-project effort drives load |
| W6 | `N66:N69` 2/2/2/2 vs `V89:V92` 1/4/2/1 | Romania platform split differs between the two tables (both Σ 8) | capacity uses 1/4/2/1 | OQ #71 |
| W7 | `C23:C29` vs `F23:F26` (= R4:R7) | two per-category design figures side by side (19/15/4/3 vs 22/18/8/4); lab 16/14/10/2 vs 12/10/6/1; Romania's rows follow neither (20/15) | per-project col 16 is the operative figure | decision (b) |
| W8 | `C18:J38` pivot | **stale**: refreshed 2026-06-29 from a snapshot the file no longer contains (§4) | PD-India 794/207 vs live 690/181; R&D-India 38/2 vs 150/30; PD-Romania 455/24 vs 415/22 | document; the client should refresh (OQ #68) |
| W9 | pivot `H` and `G` columns | `H` sums col 21 over all flagged rows (no cert filter); `G` counts non-blank (Yes + No) | our `docs/CLIENT_FORMULAS.md` §2.3 misread this; the app's "skip lab when cert = false" rule has no basis in the client's arithmetic | ADR 0041 import rule; CLIENT_FORMULAS correction (OQ #70) |
| W10 | rows 3–9 | no OEM capacity or load row, although the pivot holds 178 OEM design weeks; the client now says OEM load belongs to Greece | Greece's FW completion 192 % (I6) is overstated: 124.88 / 243 = 51 % | ADR 0042 |
| W11 | `T3` "Safety Time" | header, no formula, no values; MW col 22 has safety lab weeks on 17 rows | safety load is never summed | OQ #21 |
| W12 | `K81:Y81` `=12/$J$85` | Greece/Romania maintenance divided by India's 6 weekdays | 2.0 everywhere; no numeric effect | — |
| W13 (MW) | col 10 | `OEM-Seitek` / `OEM-SEITEK` spelled two ways (pivot: `OEM-SEITEK`) | the pivot shows one OEM-Seitek row of 12; live has 9 + 3 | normalise |
| W14 (MW) | col 0, 6, 7, 8 | duplicate S.No / codes / names (§2.10) | — | OQ #75 |
| W15 (MW) | col 45 | three date encodings (date, serial, `Mon'YY` text) | 3 rows lost | extractor fix |
| W16 (MW) | col 16 by hub | India types 4 / 3 per B / C, Romania 20 / 15, Greece 20–30 per A/A+; Romania's unflagged 2026 rows carry nothing | one column, three conventions | OQ #67 |

---

## 4. The stale pivot — what it was built from

The `RPD Capacity` pivot (`PivotTable4`, location C18:J38) uses pivot cache 6
(`xl/pivotCache/pivotCacheDefinition6.xml`): source `'2024-25-26 Projects'!A5:AI628`,
`refreshedDate = 46202.640` (Excel serial → **2026-06-29 ≈ 15:22**), `recordCount = 595`. That
sheet no longer exists in FW (only `Delete`, `2026 Project-Delete`, `Data Backup-17-11-25`
remain), so the cache records are the only copy of the data the pivot shows. Reading them back:

| Hub | Cache (= pivot) flagged rows / Σ col 16 / Σ col 21 (all) | Live MW flagged rows / Σ col 16 / Σ col 21 (all) | What changed after 2026-06-29 (name-matched rows) |
|---|---|---|---|
| PD-India | 207 / 794 / 533.5 | 181 / 690 / 533.5 | **23 flagged rows moved PD-India → R&D-India** (Dipak's B "BEE star labelling" programme, 4 wk each); 5 new PD-India rows flagged (S.No 170, 192, 383, 403, 406); 8 snapshot rows no longer match a live name (renamed/deleted) |
| R&D-India | 2 / 38 / 88 | 30 / 150 / 88 | + 23 moved + 5 new rows (S.No 349–354, In Que 2026-03) |
| PD-Romania | 24 / 455 / 994 | 22 / 415 / 924 | 2 new flagged rows (407 Industrialization 2024, 408 Commercialized 2025); 4 snapshot rows no longer match |
| R&D-Greece | 5 / 65 / 4 | 5 / 65 / 4 | none |
| OEM-HCK | 12 / 60 / 0 | 12 / 60 / 0 | none |
| OEM-SEITEK | 12 / 118 / 0 | 12 / 118 / 0 (9 now spelled `OEM-Seitek`) | spelling only |
| **Σ** | **262 / 1530 / 1619.5** | **262 / 1498 / 1549.5** | the total of 262 is a coincidence; 32 snapshot names are gone and 54 live names are new (13 of them flagged) |

No design or lab value changed on any name-matched flagged row; 55 flagged rows changed status
(19 Industrialization → Commercialized, 21 In Que → Development, 6 Development → Industrialization,
…). The pivot's cert count fell from 125 "Yes" (cache) to 124 (live).

---

## 5. Why "the data doesn't make sense" — the root causes, in order of size

1. **Per-project effort vs table effort.** The client types 4 design weeks for a B project and 3
   for a C in India, 20 / 15 in Romania (col 16); the app books 10 and 6 everywhere (ADR 0007 kinds
   × the lead-time table). PD-India: client 658 full-year weeks vs app demand 1078 on 2026 open rows
   alone. Nothing the client sees in their sheet can be matched to a Capacity figure while this
   holds. (§2.2, decision b)
2. **OEM load without OEM capacity.** The client counts 178 OEM design weeks against Greece's 2.8
   FTE (195 % booked); the app showed OEM-HCK as its own hub with Theoni's invented 44.17 wk of
   supply (23 % booked) and OEM-Seitek as 0 / 0, with 17 leaderless OEM projects left out. (ADR
   0042, decided)
3. **Supply roster.** Six leaders who are not on the capacity roster were added at 1.0 FTE each
   (+6.0 FTE, +266 man-weeks): R&D-India 132.50 vs 87.87, PD-India 342.29 vs 252.62, PD-Romania
   253.00 vs 165.00. (§2.4, ADR 0042 §5)
4. **Load coverage and scope.** The app's load is "what the run booked" for open 2026 projects (74
   of 127 open PD-India projects), not the full-year demand of every flagged project including the
   Commercialized and On Hold ones. FW counts 262 flagged rows; the app counts 253 requested in
   2026; only 185 are in both. (§2.1, §2.8, decision a)
5. **The pivot itself is stale** (2026-06-29) and two of its lab cells sum the wrong field. The
   client's own sheet, recomputed today, says PD-India 658 (not 794) and R&D-India 150 (not 38).
   (§3, §4)
6. Small arithmetic differences (W1–W3) explain the last ±2 man-weeks and are the workbook's, not
   the app's.

---

## 6. Decisions

Defaults from the briefing were kept unless the evidence or an owner ruling said otherwise; where
overridden, the reason is stated. Items marked *decided* are ADR 0042 / P29 and are cited, not
proposed.

**(a) Project selection and load scope — revised by the owner's ruling.** Import (request year
2026) ∪ (flag = Y) = **330** rows; the 77 flagged 2024/25 rows get `carry_over = true`, `reg_year =
request year` (2025: 62, 2024: 15; by status Commercialized 34, Industrialization 15, On Hold 13, In
Que 7, Development 7, Cancelled 1). Store the flag as `projects.capacity_flag`. **Full-year load**
= every stored project with status ≠ Cancelled (flag Y rows: 300 projects, the client's 1426 wk
basis; the 68 unflagged 2026 rows add 40 PD-India, 18 Greece and 9 Romania weeks on the client's
figures, and after the table fallback more — OQ #72 asks whether they should be flagged).
**Remaining-year load** = open statuses only (In Queue, In Development, Under Industrialization),
progress-aware (Done steps excluded); On Hold is excluded until the client says otherwise (OQ
#72). The 17 rows the sheet marks `Spillover '25` but requested in 2026 keep `spillover_2025 =
true` for display and are no longer `carry_over` (ADR 0035 §10 amended; OQ #62.2 stays open).
Evidence: FW's title A1, the flag column, and the owner's ruling that Commercialized-in-2026 and On
Hold work consumed this year's capacity (PD-Romania: 375 of 415 flagged weeks are On Hold /
Commercialized / Cancelled rows).

**(b) Per-project effort — kept, with three overrides.** Import col 16 → `design_effort_weeks`,
col 21 → `lab_effort_weeks`, col 22 → `safety_lab_weeks`, col 17 → `actual_design_weeks`, col 23 →
`actual_testing_weeks`, col 24 → `safety_certification_required`. The schedule and the load use the
per-project design/lab figure through per-step `duration_override_weeks` (ADR 0019 already makes an
override effective everywhere: booking, remaining duration, capacity load, progress weights,
unconstrained finish). Rule (full text in ADR 0041): scale the category's non-zero design-kind steps
proportionally so their integer sum equals round-half-up(col 16), largest-remainder rounding; a step
may round to **0 and is then skipped** — a min-1 floor is impossible because B has six non-zero
design steps and C five, so a floor would force ≥ 6 / ≥ 5 weeks against the client's 4 / 3. Fallback
to the **category lead-time table** when col 16 is blank/0 (25 of 221 open rows; 36 of 300 full-
year rows), including Romania's unflagged rows — the app invents no hub-specific constant; if the
client confirms Romania's 20 / 15 convention it becomes a per-hub default on Workflow Settings (OQ
#67; the two fallbacks differ by 68 wk on Romania's open rows, 141 on its full-year rows). *Override
1*: lab weeks are imported regardless of col 18, because the client's pivot applies no cert filter
(W9) and 13 open rows carry lab weeks with cert ≠ Yes; the import sets
`certification_testing_required = (col 18 = Yes) OR (col 21 > 0)`. *Override 2*: the
`duration_override_weeks` domain must become 0..104 (0 = skip), which touches
`backend/scheduling/workflow.py` — algorithm-engineer work, workflow-auditor ruling required.
*Override 3*: the Capacity surface's load becomes demand-based (full-year / remaining-year per (a)),
computed from `project_workflow_steps`, not from the active run; the run's booked figure is served
beside it. This is a scheduler-definition change: **ADR 0041, status Proposed, not implemented.**

**(c) Roster — decided (ADR 0042 §5, P29-T01).** FW FTEs are the truth (Rishi 1.0, Atul 0.5; the
older `data.xlsx` 0.5/0 is superseded — OQ #65). `engineers.counts_in_capacity` is false for
Theoni, Dipak, Antonis and Sailesh and true for Elena Micu and Marian (flagged "not in capacity
roster — confirm", OQ #66); Theoni's hub becomes R&D-Greece. This document adds one item: **Vaggelis**
(R&D-Greece, one carry-over A+ project) must get the same `false` treatment when the carry-over rows
are imported, and is added to OQ #64. Resulting supply (app divisors): Greece 124.88, R&D-India 88.33
(FW 87.87), PD-India 253.96 (FW 252.62), PD-Romania **253.00** with Elena/Marian counted or
**165.00** without (FW 165.00). **Consequence stated plainly:** Dipak still leads 52 projects (28
R&D-India: 23 In Development + 5 In Que, 112 design weeks; 24 PD-India) and the scheduler still
books his weeks, but R&D-India's counted supply is Ashish 1.0 + Praveer 0.5 + Ayush 0.5 = 2.0 FTE.
His 23 R&D-India Development projects therefore have no counted designer, and R&D-India reads 170.7
% booked by construction. Theoni's 7 named OEM projects and 4 open R&D-Greece projects likewise book
a designer Greece does not count.

**(d) Formulas — kept.** The app keeps its consistent per-hub divisors and one `CURRENT_WEEK`. The
deltas vs FW are workbook arithmetic errors, not app errors: W1 (+0.23 wk/engineer India: PD-India
+1.34, R&D-India +0.46 man-weeks), W2 (India lab +2.08, Greece +0.38 platform-weeks), W3 (FW's
Europe remaining capacity uses India's fraction).

**(e) Chambers — kept.** Adopt the client's test-type mapping: "ALL test" → {PDD-F, PDD-H}; "POC &
Industrialization" → {PDD-F} (industrialization has no lab-kind step in the app; PDD-J/L are design
/ elapsed); "POC & Certification" → {PDD-F, PDD-H} plus {OEM-E, OEM-H} on Greece chambers because
the OEM hubs' lab region is Greece; Romania → all = {PDD-F, PDD-H}. No reliability stage exists to
map (MW columns 28–30 are empty). Changes vs today: IN-CH1 loses H, IN-CH2 gains H, IN-CH4 gains F,
GR-CH2 gains H and OEM-H, RO-CH2 gains H. India CH-4 is the one conflict (FW: "reliability only,
non-calibrated"; `data.xlsx`: "POC & Industrialization") — default to the client mapping, ask (OQ
#71). Supply is unchanged (allowed stages never enter the supply formula).

**(f) Types and hub name — BC decided; AC/SER recommended; rename recommended.** `BC` is not a new
type: the owner ruled that the client's "Business Continuity" projects are the app's `RC`,
relabelled "Regulatory / Business Compliance" (ADR 0038 amendment 2026-10-22, implemented in
P29-T04; `excel_type` keeps `BC`; the `regulatory_compliance` tag and score are back-filled). 63
of the 330 rows become `RC`. **Recommendation: add `AC` (Alternative Component, 9 rows) and `SER`
(Service, 2 rows) to `ProjectType`.** Evidence: both are in the client's own type list
(`Lists & Explanations` column J: NM, NO, CO, IMP, AC, SER, CER, BC, OEM, "RPD Support") and in the
older app's data; neither is a variant of an existing app type (AC is a second-source component
project, close to but not the same as CO cost optimisation; SER is service work); adding them costs
one enum value each and no scheduling rule depends on type; leaving them null hides 11 projects
from the Dashboard Hub × Type view and from the Matrix type filter. No scoring tag (ADR 0038 §6
unchanged). `CER` (1 row in the selection) and `TCO` stay null with `excel_type` — their labels are
not defined anywhere the data reaches; folded into OQ #58. Rename hub `OEM-Seltek` →
**`OEM-Seitek`**: every client source (MW hub and
plant columns, FW pivot) writes Seitek; the only "Seltek" is the prototype
(`reference/rpd-platform-prototype.html`, 7 occurrences), which CLAUDE.md says is not the spec;
the mock-up `.pptx` names no OEM hub. Recommend the rename (PG `ALTER TYPE hub_name RENAME VALUE`;
33 backend, 31 frontend, 52 docs references; ADR 0042 §9 defers it here).

**(g) OEM capacity — decided (ADR 0042).** OEM-HCK and OEM-Seitek are capacity children of
R&D-Greece (`hubs.capacity_hub_id`); Greece's 2.8 FTE serve all three and Greece's load includes
the OEM projects (full year 243 wk, 194.6 % booked, completion 51.4 %). The mechanism ADR 0042
chose — keep the OEM hubs for registration, plant, filters and RBAC; aggregate on the Capacity
surfaces with a `members` breakdown; Greek roster engineers eligible for the OEM categories;
provisional Greek leaders for the 20 leaderless OEM rows — is the right one of the two options (the
alternative, moving the projects' hub to R&D-Greece while keeping the plant, would lose the OEM
workflow selection and the Hub × Type and country views). Who Theoni is (likely the Greek R&D OEM
coordinator) and who should lead the leaderless OEM projects stay client questions (OQ #64).

**(h) Lead-time table — no change.** FW rows 4–7 / 12–14 = `LEAD_TIME_SEED` = DB, cell for cell.
The old app's live templates differ on 7 PDD cells and carry gap/overlap values (PDD-F −3, H −1, I
−5, J +3, K +1, L +2, N +1); these are its own edits, not the client's table.

**(i) Other findings → fixes.** Parse `Mon'YY` end dates; use Development Step for every open
status (OQ #74); import safety and actual columns for display; `carry_over` from the request year;
normalise `OEM-SEITEK`; add Vaggelis to the provisional list; duplicates to the client (OQ #75);
col 55 codes to the client (OQ #73). `docs/CLIENT_FORMULAS.md` §2.3 must be corrected (W9) when
ADR 0041 is accepted.

---

## 7. Implementation spec (after ADR 0041 is accepted; P29 / ADR 0042 items are referenced, not respecified)

### 7.1 Extractor — `backend/seed/extract_client_2026.py`

1. **Selection**: a row is kept when `request_year == 2026` or `col 3 == "Y"`. Emit `request_year`
   and `capacity_flag` (bool); `carry_over = request_year < 2026`; `reg_year = request_year`. Keep
   `spillover_2025` (col 56 Yes/Y) as today. Expected: 330 rows, 77 carry-over, 262 flagged.
2. **Hub**: `OEM-Seitek`, `OEM-SEITEK` → `OEM-Seitek` (after the rename; the current map until
   then).
3. **New fields** (float, 2 dp, `null` when blank or 0 unless noted): `design_effort_weeks` (col
   16), `lab_effort_weeks` (col 21), `safety_lab_weeks` (col 22; 0 kept), `actual_design_weeks`
   (col 17), `actual_testing_weeks` (col 23), `safety_certification_required` (col 24, `yes`
   case-insensitive). Keep the raw cert value as `excel_certification`; set
   `certification_testing_required = (col 18 == "Yes") or (lab_effort_weeks > 0)`.
4. **Type map**: `BC` → `RC` is P29-T04's (ADR 0038 amendment). Add `AC`, `SER` one to one. `CER`,
   `TCO`, `OEM`, `RPD Support` stay null + `excel_type`.
5. **End date**: also parse `^[A-Z][a-z]{2}'\d{2}$` → first of that month; `-` → null.
6. **Leaders**: no code change; Vaggelis appears in `leaders` automatically. Summary line: counts
   per hub/status, carry-over, flagged, blank col 16 / col 21, rows where cert was set by col 21.

### 7.2 Seed — `backend/seed/client_2026.py`, `backend/seed/seed_demo_data.py`

- Engineers: P29-T01 owns `counts_in_capacity`, Theoni's hub and the OEM leaders; this spec only
  adds Vaggelis to the not-counted provisional list.
- Project rows: write `capacity_flag`, the six effort/actual/safety fields, `carry_over` /
  `reg_year` per 7.1.
- After the 14 step rows exist, call `services.project_effort.apply_effort_overrides(project)`
  (7.4) so `duration_override_weeks` carries the per-project distribution.
- `derive_progress`: when `development_step` is set, use it for Under Industrialization and In
  Development alike (In Queue stays Not Started per DOMAIN_RULES).
- Chambers: `domain_constants.CHAMBER_SEED` allowed stages per decision (e).

### 7.3 Migration `p30a_effort_types_hub_rename.py` (down_revision = P29's head, `p29a_capacity_hubs`)

```
projects:  + capacity_flag BOOLEAN NOT NULL DEFAULT false
           + design_effort_weeks NUMERIC(6,2) NULL CHECK (>= 0)
           + lab_effort_weeks NUMERIC(6,2) NULL CHECK (>= 0)
           + safety_lab_weeks NUMERIC(6,2) NULL CHECK (>= 0)
           + actual_design_weeks NUMERIC(6,2) NULL CHECK (>= 0)
           + actual_testing_weeks NUMERIC(6,2) NULL CHECK (>= 0)
           + safety_certification_required BOOLEAN NOT NULL DEFAULT false
project_workflow_steps: CHECK ck_project_workflow_steps_duration_override_range
           → (duration_override_weeks IS NULL OR (duration_override_weeks >= 0 AND <= 104))
ALTER TYPE project_type ADD VALUE 'AC'; … 'SER'   (each as its own autocommit statement;
           PG forbids using a new enum value in the transaction that adds it; nothing here uses them)
ALTER TYPE hub_name RENAME VALUE 'OEM-Seltek' TO 'OEM-Seitek'   (transactional on PG 17)
```
Downgrade: rename back, restore the CHECK, drop the columns; enum values cannot be removed
(document). Audit-log rows keep the historical spelling.

### 7.4 Backend services and API

- **`services/project_effort.py`** (new, pure + one DB write): `effective_step_durations(category,
  workflow, table, design_effort, lab_effort, cert_required) -> dict[step_id, int]` implementing ADR
  0041 §Rule; `apply_effort_overrides(db, project)` writes `duration_override_weeks` (or `NULL`
  when the project has no figure) on the project's design/lab steps and sets `schedule_stale`.
  Called by the seed, by `PUT/PATCH /projects/{id}` when `design_effort_weeks`, `lab_effort_weeks`,
  `category` or `certification_testing_required` change, and by Workflow Settings after a lead-time
  edit (the distribution depends on the table's shape).
- **`scheduling/workflow.py`, `scheduling/types.py`, `invariants.py`, `monte_carlo.py`**
  (algorithm-engineer): accept `duration_override_weeks = 0` as "skipped" (`DURATION_OVERRIDE_MIN
  = 0`); `skipped = effective == 0 or (lab and not cert)`; golden files re-cut; I5 shape unchanged.
- **`api/routers/capacity.py`** (on top of P29's capacity-hub rows): `design_load_weeks` /
  `lab_load_weeks` become the **full-year demand** = Σ effective durations
  (`coalesce(duration_override_weeks, duration_weeks)`, skipped steps 0, lab only when
  `certification_testing_required`) over every project of the capacity hub (members included) with
  status ≠ Cancelled, from `project_workflow_steps`, run-independent; `design_load_remaining_weeks`
  / `lab_load_remaining_weeks` = the same over open-status projects, Done steps excluded, and the
  remaining-year booked % uses them; the current run-based figures are served as
  `design_load_booked_weeks` / `lab_load_booked_weeks` (I6/I7 keep binding the run figure; the
  demand figures get new invariants in ADR 0041).
- **`schemas/project.py`**: `capacity_flag` and the six fields on `ProjectRead`,
  `ProjectFilterRow`, Workspace project (read-only now; write path with OQ #34's edit design).
- **`models/enums.py`**: `ProjectType.AC/SER` (labels "Alternative Component", "Service"; `RC`'s
  relabel is P29-T04's); `HubName.OEM_SEITEK = "OEM-Seitek"`;
  `domain_constants`: `HUB_LAB_REGION`, `OEM_HUBS`, `WORKFLOW_SEED` text, `CHAMBER_SEED` allowed
  stages; `services/display_labels.py` type labels.
- **`docs/DOMAIN_RULES.md`** (orchestrator, with ADR 0041): "Lead times" per-project effort
  paragraph; "Capacity supply" load basis (full-year / remaining-year); hub list spelling;
  `docs/CLIENT_FORMULAS.md` §2.3 correction (W9).

### 7.5 Frontend (frontend-builder; P29-T03 covers the four-row Capacity layout and the roster marker)

- `types/enums.ts`: `HUB_NAMES` → `'OEM-Seitek'`; `PROJECT_TYPES` + `AC`, `SER`;
  `PROJECT_TYPE_LABELS` + `Alternative Component`, `Service` (the `RC` relabel is P29-T03/T04's).
  Fixtures/e2e
  spelling (`hub-families`, `hub-geo`, what-if schema and fixtures, capacity tests).
- Capacity surface (`hub-summary-table`, `hub-supply-breakdown`): load column relabelled
  **"Full-year demand (client figures)"**, a **"Remaining demand"** column and a **"Booked in plan"**
  column — all served fields, no client-side arithmetic (I19).
- Projects register / Workspace details: "Design effort (client)", "Lab effort (client)", "Safety
  cert." and the two actuals, read-only; badges **"Carry-over 2024/25"** (`carry_over`) and
  **"Capacity flag"** (`capacity_flag`).
- Dashboard Hub × Type views pick up the two new types from the served enum.

### 7.6 Reseed sequence (dev, after P29 and this change are merged)

```
cd /Users/ayushroy/frigoglass/backend
uv run alembic upgrade head
uv run --no-project --with openpyxl python -I seed/extract_client_2026.py \
    "$HOME/Downloads/24-25-26 Global RPD Project Pipeline.xlsx" seed/client_2026_seed_data.json \
    --formula-workbook "../reference/Formula-2025-26 Global RPD Project Pipeline.xlsx"
uv run python -m seed.seed_demo_data --reset --dataset client_2026 --schedule
```

### 7.7 Expected before / after (full year; QA verifies to 2 dp; "after" = P29 + ADR 0041)

| Figure | Before (today) | After |
|---|---|---|
| Capacity rows | 6 hubs | 4 capacity hubs (Greece with members R&D-Greece / OEM-HCK / OEM-Seitek) |
| Engineers / Σ FTE counted | 23 / 20.30 | 24 / 16.30 (14.30 if Elena Micu and Marian are not counted) |
| Design capacity Greece / R&D-India / PD-India / PD-Romania | 124.88 (+ OEM-HCK 44.17) / 132.50 / 342.29 / 253.00 | 124.88 / 88.33 / 253.96 / 253.00 (165.00 without Elena/Marian) |
| Design remaining (CW 42) | 24.02 (+ 8.49) / 25.48 / 65.83 / 48.65 | 24.02 / 16.99 / 48.84 / 48.65 (31.73) |
| Lab capacity India / Greece / Romania | 188.30 / 73.34 / 216.30 | unchanged |
| Full-year design demand (client figures, table fallback, integer steps) | — (run: 42 / 201 / 500 / 138) | 266 / 150 / 884 / 534 (Romania 675 if its 20/15 convention is confirmed) |
| Remaining design demand (open rows, before progress) | — | 215 / 150 / 676 / 198 (Romania 266 under its convention) |
| Full-year lab demand India / Greece / Romania (V3, incl. On Hold and Commercialized) | — (run: 233 / 16 / 24) | 860 / 46 / 860; open rows alone 741 / 32 / 350 |
| Design booked % (year) | 25.62 (+ 22.64) / 151.70 / 146.07 / 54.55 | 213.0 / 169.8 / 348.1 / 211.1 (323.6 without Elena/Marian; 266.8 under Romania's convention) |
| Completion % (year) | — | 46.9 / 58.9 / 28.7 / 47.4 |
| Projects total / open / carry-over / flagged | 253 / 192 / 17 (spillover flag) / — | 330 / 221 / 77 / 262 |
| Type null | 67 | 1 (`CER`; BC → RC 63 via P29-T04, AC 9, SER 2) |
| Chambers allowing PDD-H in India | IN-CH1, IN-CH3 | IN-CH2, IN-CH3 |

Reference values on the client's own figures without any fallback (flag Y, excl. Cancelled, §1.1):
Greece 243 / 194.6 %, R&D-India 150 / 170.7 %, PD-India 658 / 260.5 %, PD-Romania 375 / 227.3 %
(booked), completion 51.4 / 58.6 / 38.4 / 44.0 %. QA should be able to reproduce these from the
served per-project fields by filtering `capacity_flag` and summing `design_effort_weeks`.

QA checks (SQL, read-only): `Σ fte where counts_in_capacity` per capacity hub = the table; `Σ
coalesce(duration_override_weeks, duration_weeks)` over design steps of non-cancelled projects per
capacity hub = full-year demand; same over open projects = remaining demand; `count(*) where
carry_over` = 77; `count(*) where capacity_flag` = 262; `count(*) where type is null` = 1;
`chambers.allowed_stages` per (e); hub names contain no `Seltek`.

---

## 8. Client questions

Appended to `docs/OPEN_QUESTIONS.md` as #64–#75: who the non-roster leaders are and who leads the
leaderless OEM rows (#64); Rishi / Atul FTE (#65); Elena Micu / Marian (#66); which per-project
figure is authoritative, India 4/3 vs Romania 20/15 and the blank rows (#67); the stale pivot (#68);
the E7/E9 cells (#69); lab weeks vs the cert flag (#70); Romania platforms and India CH-4 (#71);
full-year scope — unflagged 2026 rows and On Hold in the remaining year (#72); the col 55 codes
(#73); the Development Step column (#74); duplicate rows (#75).

---

## Appendix A — reproduction

Scripts (scratchpad, not committed; untrusted-input discipline: `uv run --with openpyxl python -I`
from `backend/`, workbook path as argument):
`dump_formula_wb.py` (FW cells + formulas + comments), `dump_projects_wb.py` (MW stats; writes
`union_rows.json`), `pivot_cache.py` and `pivot_lab_rule.py` (FW pivot cache 6 vs live MW),
`effort_check.py` (formula-or-value check, Romania lab rows), `flag_status_load.py` (flag Y load
by hub × status, unflagged-2026 delta, Romania conventions), `dump_oldapp_xlsx.py` (CA sheets),
`proposed_load.py` and the inline variants script (loads, supply, template/chamber diffs).
Outputs: `formula_wb_dump.txt`, `projects_wb_dump.txt`, `pivot_cache_diff.txt`,
`flag_status_load.txt`, `oldapp_xlsx_dump.txt`, `proposed_load.txt`, `variants.txt` in
`/private/tmp/claude-501/-Users-ayushroy-frigoglass/a0b44f67-072c-4e23-bc07-f1c7c8791ead/scratchpad/`.
DB figures: read-only `psql` on `rpd-pg-dev` (active run `dcb5a6ef…`, v1, CW 42).
