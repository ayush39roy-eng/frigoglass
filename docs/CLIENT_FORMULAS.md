# Client formulas — decoded from `reference/Formula-2025-26 Global RPD Project Pipeline.xlsx`

Received 2026-09-27 from Frigoglass ("these are the formulas given by the Frigoglass people — use
them"). This file is the agent-readable transcription of the two sheets that carry logic
(`Final RPD`, `RPD Capacity`). Everything here was read programmatically from the workbook's
formulas and cached values (openpyxl); nothing is inferred. Where the workbook is internally
inconsistent that is recorded under **Workbook inconsistencies** and in `docs/OPEN_QUESTIONS.md`
— agents do not silently pick a side.

`docs/DOMAIN_RULES.md` is still the executable contract. This file is the *evidence* behind ADRs
0007–0009 and the 2026-09-27 DOMAIN_RULES.md revision. If the two disagree, DOMAIN_RULES.md wins
and the disagreement is a bug to record in `docs/MEMORY.md`.

---

## 1. `Final RPD` — lead times per phase per category

### 1.1 PDD workflow (Frigoglass in-house projects)

Step codes (row 1), names (row 2) and the short codes from `Lists & Explanations` column M:

| Step | Name in workbook | Short code |
|---|---|---|
| PDD-A | Marketing Brief | MKTG_BRF |
| PDD-B | Feasibility Study (Conceptual Design) | FEAS_STD |
| PDD-C | Business case Approval | BUS_CASE |
| PDD-D | Final Technical Brief & Project Kick Off | TECH_BRIEF |
| PDD-E | Design Detailing | DESIGN |
| PDD-F | Proof of Concept | POC |
| PDD-G | Online CAPEX approval | CAPEX |
| PDD-H | Certification testings & Compliance | CERT |
| PDD-I | TF-1 | TF_1 |
| PDD-J | Pr. Pr (pre-production) | PROD_PR |
| PDD-K | TF-2 | TF_2 |
| PDD-L | Pilot | PILOT |
| PDD-M | TF-3 | TF_3 |
| PDD-N | Commercialization | COMM |

Lead times in weeks (rows 4–7; blank cells are literally empty in the workbook and behave as 0 in
the row `SUM`):

| Cat | A | B | C | D | E | F | G | H | I | J | K | L | M | N | Sum (Q) | Design (R) | Lab (S) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A+ | 1 | 8 | 4 | 1 | 6 | 6 | 2 | 6 | 2 | 1 | 2 | 3 | 1 | 1 | 44 | 22 | 12 |
| A  | 1 | 4 | 4 | 1 | 6 | 4 | 2 | 6 | 2 | 1 | 2 | 3 | 1 | 1 | 38 | 18 | 10 |
| B  | 1 | 0 | 0 | 1 | 4 | · | 0 | 6 | · | 1 | 2 | 1 | 1 | 1 | 18 | 8 | 6 |
| C  | 1 | 0 | 0 | 1 | 2 | · | 0 | 1 | · | 1 | 1 | 0 | 0 | 1 | 8 | 4 | 1 |

Row formulas, verbatim:

```
Q  (Sum)                      = SUM(C:P)                      -- all 14 steps
R  (Design time, A+ and A)    = C + D + F + G + K + L + M + O  -- steps A, B, D, E, I, J, K, M
R  (Design time, B)           = F + G + M + O                  -- steps D, E, K, M
R  (Design time, C)           = F + G + M                      -- steps D, E, K
S  (Lab time, all rows)       = H + J                          -- steps F, H
T  (Safety time)              -- header only, no formula, no values
```

What this says about **which steps consume which resource** (used by ADR 0007):

- **Engineer ("design") steps:** A, B, D, E, I, J, K, M — per the A+/A formula.
- **Chamber ("lab") steps:** F (Proof of Concept), H (Certification) — only these two.
- **Elapsed-only steps (calendar time, no engineer, no chamber):** C (Business case approval),
  G (Online CAPEX approval), L (Pilot), N (Commercialization). They are in the row `SUM` (so they
  are on the critical path) but in neither the design nor the lab formula.

### 1.2 OEM workflow (rows 9–14, "Lead Times (wks) per Phase (only for Frigoglass Resources)";
row 16: "Steps are done by OEM")

| Step | Name in workbook | Short code (Lists col M) |
|---|---|---|
| OEM-A | Commercial Brief | COMM_BRF |
| OEM-B | Final Technical Brief & Project Kick Off | TECH_BRIEF |
| OEM-C | Business case Approval | BUS_CASE |
| OEM-D | Design Detailing | DESIGN |
| OEM-E | Proof of Concept | POC |
| OEM-F | Online CAPEX approval | CAPEX |
| OEM-G | Test results analysis | TST_ANAL |
| OEM-H | Certification testings & Compliance | CERT |
| OEM-I | TF-1 | TF_1 |
| OEM-J | Pr. Pr | PROD_PR |
| OEM-K | TF-2 | TF_2 |
| OEM-L | Pilot | PILOT |
| OEM-M | TF-3 | TF_3 |
| OEM-N | Commercialization | COMM |

| Cat | A | B | C | D | E | F | G | H | I | J | K | L | M | N | Sum |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-OEM | 1 | 1 | 1 | 2 | 2 | 2 | 4 | 6 | 0 | 1 | 0 | 0 | 0 | 1 | 21 |
| B-OEM | 1 | 1 | 1 | 0 | 0 | 2 | 2 | 6 | 0 | 1 | 0 | 0 | 0 | 0 | 14 |
| C-OEM | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |

The OEM rows have **no** design/lab split formula (columns R/S are empty for them).

### 1.3 Conversion-factor block (rows 21–29)

| Cat | "Design Man Weeks/Project" (C) | Factor, B = 1 (D/E) | "For Project leader concept … as per Process" (F = R) | "Lab Weeks/Project" (I) | Factor (J/K) |
|---|---|---|---|---|---|
| A+ | 19 | 4.75 | 22 | 16 | 1.6 |
| A | 15 | 3.75 | 18 | 14 | 1.4 |
| B | 4 | 1 | 8 | 10 | 1 |
| C | 3 | 0.75 | 4 | 2 | 0.2 |
| A-OEM | 4 | 1 | – | 6 | 0.6 |
| B-OEM | 1 | 0.25 | – | 6 | 0.6 |
| C-OEM | 0.5 | 0.125 | – | 2 | 0.2 |

Two different per-project numbers therefore exist side by side: the *process-derived* sum of the
lead-time table (22/18/8/4 design, 12/10/6/1 lab) and a hand-entered "Man Weeks/Project"
(19/15/4/3 design, 16/14/10/2 lab). The `RPD Capacity` pivot's per-project "Process Design Man
Week" values (e.g. R&D-Greece A+ = 30, A = 20) match **neither** table, so in the source
spreadsheet that figure is entered per project. See OPEN_QUESTIONS #12.

---

## 2. `RPD Capacity` — capacity supply and load

### 2.1 Design capacity per hub (rows 39–61)

Resource count = Σ engineer FTE (row 40, per hub table):

| Hub | Engineers (FTE) | Σ FTE |
|---|---|---|
| India PD | Rishi 1, New Hiring 0, Lokesh 1, Zakir 1, Pawan 1, Nikhil 0.75, Atul 0.5, Rahul-Contractual 0.5, New engineer-Contractual 0 | 5.75 |
| India R&D | Ashish 1, Praveer Kumar Singh 0.5, Ayush Kumar 0.5 (3rd party) | 2 |
| Greece R&D | Dimopoulou 1, Lioumis 1, Kanarios 0.8 (Sourcing) | 2.8 |
| Romania PD | Stef Marius 1, Alin Boboc 1, Adrian Bortoc 1, Bianca 0.75 | 3.75 |

Working weeks per engineer per year (rows 56–61), each deduction = days ÷ weekdays-per-week:

| | India PD | India R&D | Greece R&D | Romania PD |
|---|---|---|---|---|
| Weeks in year | 52 | 52 | 52 | 52 |
| National holidays | 13/6 = 2.17 | 13/6 | 12/5 = 2.4 | 13/5 = 2.6 |
| Medical leave | 7/5 = 1.4 | 7/5 | 0 | 7/5 = 1.4 |
| Casual leave | 7/6 = 1.17 | 7/6 | 0 | 0 |
| Annual leave | 20/6 = 3.33 | 20/6 | 25/5 = 5 | 20/5 = 4 |
| **Working weeks / engineer** | **43.93** | **43.93** | **44.60** | **44.00** |

```
total_yearly_design_capacity (man-weeks) = working_weeks_per_engineer × Σ FTE
    India PD 43.93 × 5.75 = 252.6 | India R&D 87.9 | Greece 124.9 | Romania 165.0 | Global 630.4

remaining_weeks              = 52 − current_week            (India: 52−15 = 37; Greece/Romania: 52−17 = 35)
remaining_fraction (K55)     = remaining_weeks / 52         (37/52 = 0.7115)
remaining_working_weeks      = remaining_weeks − Σ(deduction_weeks × remaining_fraction)
remaining_design_capacity    = remaining_working_weeks × Σ FTE
    India PD 31.26 × 5.75 = 179.7 | India R&D 62.5 | Greece 83.3 | Romania 109.9 | Global 435.4
```

### 2.2 Lab capacity per region (rows 64–95)

Per chamber: platform count, efficiency, and yearly downtime; chambers are per lab region.

| Region | Chamber | Platforms | Efficiency | Holidays | Maintenance | Breakdown (actual 2025) | Calibration | Working wks | Efficient lab wks |
|---|---|---|---|---|---|---|---|---|---|
| India | CH-1 | 1 | 0.7 | 13/5 = 2.6 | 2 | 1 | 1 | 45.4 | 31.78 |
| India | CH-2 | 4 | 0.6 | 2.6 | 12/6 = 2 | 11 | 1 | 35.4 | 84.96 |
| India | CH-3 | 2 | 0.6 | 2.6 | 2 | 7 | 1 | 39.4 | 47.28 |
| India | CH-4 | 1 | 0.5 | 2.6 | 2 | 2 | 1 | 44.4 | 22.20 |
| Greece | CH-1 | 1 | 0.7 | 2.6 | 2 | 8 | 1 | 38.4 | 26.88 |
| Greece | CH-2 | 2 | 0.6 | 2.6 | 2 | 8 | 1 | 38.4 | 46.08 |
| Romania | CH-1 | 1 | 0.7 | 2.6 | 2 | 3 | 1 | 43.4 | 30.38 |
| Romania | CH-2 | 4 | 0.6 | 2.6 | 2 | 3 | 1 | 43.4 | 104.16 |
| Romania | CH-3 | 2 | 0.6 | 2.6 | 2 | 3 | 1 | 43.4 | 52.08 |
| Romania | CH-4 | 1 | 0.7 | 2.6 | 2 | 4 | 1 | 42.4 | 29.68 |

Workbook remarks: multi-platform chambers get efficiency 0.6 "not all platforms can be run";
India CH-4 is "Old labs / Chamber 4 only used for reliability" and (threaded comment on its
platform cell) "Only for Industrialization — non-calibrated lab"; Romania chambers are "New Labs".

```
working_weeks_per_chamber   = 52 − holidays − maintenance − breakdown − calibration
efficient_lab_weeks         = working_weeks_per_chamber × efficiency × platforms
total_yearly_lab_capacity   = Σ efficient_lab_weeks per region
    India 186.22 | Greece 72.96 | Romania 216.30 | Global 475.48
remaining_lab_capacity      = total × remaining_fraction (K55)
    India 132.50 | Greece 51.91 | Romania 153.91
```

### 2.3 Load, gap and completion (rows 3–9)

```
design_load (hub)   = Σ over projects "Process Design Man Week"      (pivot, GETPIVOTDATA)
lab_load (region)   = Σ over projects "Lab Weeks - Process Derived"  (pivot)
gap                 = load − yearly_capacity
completion_pct      = yearly_capacity / load
```

The pivot (rows 18–38) is filtered to `Project to be considered for Capacity Calculation = Y` and
carries, per project: category, Process Design Man Week, Actual Design Man Week, Certification
Testing Required (count), Lab Weeks – Process Derived, Actual Testing Time, Safety Certification
Required (count). **Lab weeks are only summed for projects flagged "Certification Testing
Required"** — e.g. PD-India category C has 60 projects but only 18 require testing and contribute
31 lab weeks.

### 2.4 Workbook inconsistencies (recorded, not silently resolved)

1. `E7` (Greece **lab** load) sums "Process Design **Man** Week", and `E9` (Romania lab load) sums
   "**Actual** Design Man Week" — both look like copy-paste errors; every other lab row sums
   "Lab Weeks – Process Derived".
2. Greece (`Q57:Q60`) and Romania (`T57:T60`) scale their leave deductions by **India's**
   remaining fraction `$K$55` (0.7115) instead of their own `Q55`/`T55` (0.673).
3. India divides medical leave by 5 weekdays but every other India deduction by 6; India lab
   holidays are 13/5 while India maintenance is 12/6.
4. "Current week" is 15 for India and 17 for Greece/Romania in the same workbook; the app uses a
   single `CURRENT_WEEK`.
5. The B and C design-time formulas omit Marketing Brief (A) and Pr. Pr (J) although both are
   non-zero (1 week) for those categories; the A+/A formula includes them.
6. Two per-project design/lab man-week figures coexist (§1.3).
7. `Safety Time` (column T) is a header with no formula or values.

---

## 3. Other sheets (reference only, no logic adopted)

- `Lists & Explanations` — controlled vocabularies. Notable: Project Status = In Que / In Progress /
  Delayed / Completed / Cancelled / On hold; HO review status = Development / Industrialization /
  In Que / On Hold / Commercialized / Cancelled; Project Category = A+ / A / B / C / A-OEM / B-OEM /
  C-OEM; Priority = a rank 1..55 (not a band); Product Type = ICM / HA / VF / CF / Other; Testing
  Required = POC / Performance / Energy / Comparison / Reliability; Safety Certification Required =
  Yes / No; Customer = ALL / COKE / KA / WM.
- `2026 Project-Delete` — the 2026 pipeline charter with per-project columns incl. `Project
  Leader`, `Project End Date - LATEST`, `Part of "IMPACT"`, `Marketing Brief Yes/NO`, and a
  week-by-week (wk10…wk52) manual Gantt.
- `All by RM Cat_v3…`, `*_MoM`, `Pivot-Charter-obsolete`, `Data Backup-17-11-25`, `14 Vs. 12b`,
  `LTs_*`, `Interchangeable` — RM-saving pipeline tracking and procurement lead times; out of scope
  for the RPD scheduler.
