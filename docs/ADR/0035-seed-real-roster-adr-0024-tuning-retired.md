# ADR 0035: Seed uses the client's real roster and data; ADR 0024 tuning retired

## Status

Accepted (2026-10-21). Part of P24 (P24-T01 backend). Owner ruling, 2026-10-21: "go with your
recommendations" on the workflow-auditor's seed data verification (MEMORY 2026-10-21 "Seed data
verification against the client workbook"). **Amends ADR 0024**: its dataset (the 253 projects
requested in 2026), `CURRENT_WEEK = 42` and the 52-week display stay. Its seed tuning is retired:
the 4-open-projects cap, the "<hub> Engineer n" capacity engineers, the blank-leader fill, the FTE
tuning and the chamber efficiency tuning. No scheduling or capacity formula changes, and nothing
under `backend/scheduling/` is touched.

## Context

The owner reported "too many employees on Capacity Planning". The audit found 59 engineers: 18
workbook project leaders and 41 invented ones. Every FTE and every chamber efficiency had been
tuned toward the booked % the client asked for in ADR 0024. Since ADR 0032, FTE also sets design
speed, so the tuned FTEs changed the plan itself, not only the booked %. The client's formula
workbook (`reference/Formula-2025-26 Global RPD Project Pipeline.xlsx`, `RPD Capacity!I42:T50`)
holds the real roster: 17 people, plus 2 placeholders at 0 FTE, Σ FTE 14.3. The project file
(`24-25-26 Global RPD Project Pipeline.xlsx`) also carries plant, requesting department, product
type, `Spillover '25` and "Project End Date - LATEST". The seed did not store any of these.

## Decision

1. **Roster.** The engineers are the formula workbook's roster, with its names, hubs and FTE:
   - PD-India: Rishi 1.0, Lokesh 1.0, Zakir 1.0, Pawan 1.0, Nikhil 0.75, Atul 0.5,
     Rahul-Contractual 0.5;
   - R&D-India: Ashish 1.0, Praveer Kumar Singh 0.5, Ayush Kumar 0.5;
   - R&D-Greece: Dimopoulou 1.0, Lioumis 1.0, Kanarios 0.8;
   - PD-Romania: Stef Marius 1.0, Alin Boboc 1.0, Adrian Bortoc 1.0, Bianca 0.75.

   The extractor reads the roster from the workbook into `client_2026_seed_data.json` (`roster`).
   The 41 invented engineers are gone. The project file names four of these people by first name
   (Rahul, Stef, Alin, Adrian). An alias map resolves those names to the roster.
2. **Zero-FTE placeholders are not created.** "New Hiring" and "New engineer-Contractual" have a
   Resource Count of 0. An engineer needs FTE ≥ 0.01, so the seed skips them and reports them (OQ
   #53).
3. **Allowed categories.** The formula workbook gives no allowed categories for any engineer. Each
   roster engineer therefore gets the client app's chips (the older app's `Engineer.allowedTypes`):
   - B, C for Lokesh, Zakir, Pawan, Nikhil, Atul, Rahul-Contractual, Stef Marius, Alin Boboc and
     Adrian Bortoc;
   - A, B, C for Rishi (his chip "M" has no app category and is dropped);
   - A+, A for Ashish, Lioumis and Kanarios;
   - A+, A, OEM for Dimopoulou;
   - A for Praveer Kumar Singh and Ayush Kumar;
   - C for Bianca.

   A mismatch only raises the CAT_NOT_ALLOWED warning. On the seeded plan, 7 projects raise it
   (OQ #54).
4. **Provisional leaders.** Six workbook project leaders are not on the roster: Dipak, Elena Micu,
   Theoni, Marian, Sailesh and Antonis. Each is added as an engineer:
   - in the hub where they lead the most projects: Dipak R&D-India, Elena Micu and Marian
     PD-Romania, Theoni OEM-HCK, Sailesh and Antonis PD-India;
   - at FTE 1.0;
   - allowed to lead the categories of the projects they lead.

   They are flagged **provisional** in `seed/client_2026.py` (`EngineerSeed.provisional`) and in
   the seed summary. The `engineers` table has no notes or flag column, and none was added for
   this. The client must confirm (OQ #52).
5. **Blank leaders stay blank.** 20 projects have no leader in the project file: OEM-HCK 9,
   OEM-Seltek 8, PD-India 1, PD-Romania 1 and R&D-Greece 1. They are seeded with
   `leader_engineer_id = NULL`. No assignment is invented. The scheduler's existing rule applies
   unchanged: `LEFT_OUT` with `no_leader`, nothing booked (DOMAIN_RULES "Booking rules"). This
   affects 18 projects. The other 2 are Commercialized and Cancelled, which are excluded anyway.
   Their derived step progress is computed against a private resource ledger, because they book
   nothing.
6. **OEM hubs** keep their projects and their calendar. The workbook gives OEM no engineers and no
   capacity. OEM projects are led only by a provisional leader named on them (Theoni). The rest
   have no leader (OQ #55). The hub name stays `OEM-Seltek`; the workbook writes "Seitek" (OQ #55).
7. **Chambers** use the workbook's efficiencies (0.7 / 0.6 / 0.6 / 0.5 India, 0.7 / 0.6 Greece,
   0.7 / 0.6 / 0.6 / 0.7 Romania), exactly as in `domain_constants.CHAMBER_SEED`. Platforms and
   downtime already matched. Allowed stages stay ours (OQ #57).
8. **Rubric scores stay synthetic.** No client source holds the 13 dimension scores. The seeded
   scores are kept, so the Matrix still has bands. They are flagged
   (`client_2026.SYNTHETIC_DIMENSION_SCORES`, plus seed comments) and the real scores are asked
   for (OQ #56).
9. **Charter fields.** Three nullable `String(100)` columns are added to `projects`: `plant`,
   `requesting_department` and `product_type` (migration `p24a_project_charter_fields`).
   - They store the workbook value as written: 253, 237 and 250 projects carry one.
   - The workbook's lists (`Lists & Explanations` columns C, D and Q) are kept as
     `domain_constants.PLANT_OPTIONS`, `REQUESTING_DEPARTMENT_OPTIONS` and `PRODUCT_TYPE_OPTIONS`.
     They are reference lists, not a write constraint. One department value, "Development", is
     not on the workbook's own list (OQ #62).
   - The fields are served read-only on `ProjectRead` (so also on the Workspace project) and on
     the Dashboard register row (`ProjectFilterRow`).
   - `GET /planning/resource-load?requesting_department=` now matches
     `projects.requesting_department` exactly. `/planning/resource-load/options` returns the
     distinct departments of the caller's visible projects, with `requesting_department_available`
     set when there is at least one.
   - The fields are not financial, so they are not encrypted.
   - The write models (`ProjectCreateRequest`, `ProjectUpdateRequest`) do not accept them yet. An
     edit path needs its own audited design (OQ #34).
10. **2025 spillover.** The 17 projects that the project file marks `Spillover '25` (Y / Yes) get
    `carry_over = true` and `reg_year = 2025`. Every other project gets `carry_over = false` and
    `reg_year = 2026`. The Dashboard pipeline row (ADR 0030) now shows Spillover 17, New 236 and
    Unregistered 0. All 17 were requested in 2026, but the file flags them as spillover (OQ #62).
11. **End dates.** "Project End Date - LATEST" is stored as `target_end_week`:
    - Some cells hold an Excel date serial instead of a date; the extractor converts them.
    - The rule is the date's ISO week when the ISO week-year is 2026 (a week 53 becomes 52), and
      52 + ISO week for 2027 while that is still within W78.
    - **A date in an earlier year (2025) is not imported**: `target_end_week` stays null, because
      week numbers start at 2026 W1. The raw `end_date` stays in the JSON.
    - Result: 22 dated projects, 15 imported (W1 to W49) and 7 not imported (all 2025-12-01; OQ
      #62).
12. **Not done now** (recorded as questions): the BC / AC / SER project types of the 67 untyped
    projects (OQ #58), the India medical-leave divisor (OQ #59), the pre-2026 open and On Hold
    projects (OQ #60) and the Marketing / OEM step responsibility (OQ #61).

## Consequences

Measured on a disposable database: `seed_demo_data --dataset client_2026 --schedule`, CW 42, ADR
0032 active, greedy run v1.

- **Engineers:** 23 (17 roster + 6 provisional). Σ FTE is 20.3 = 14.3 roster + 6.0 provisional.
  Per hub:

  | Hub | Engineers | Σ FTE |
  |---|---|---|
  | PD-India | 9 | 7.75 |
  | R&D-India | 4 | 3.0 |
  | R&D-Greece | 3 | 2.8 |
  | PD-Romania | 6 | 5.75 |
  | OEM-HCK | 1 | 1.0 |
  | OEM-Seltek | 0 | 0 |

- **Dashboard:** within year 41 (24 open + 17 Commercialized), spillover 42, left out 126 (18 of
  them `no_leader`), On Hold at a stage 0. Before this ADR: 67 / 83 / 59.
- **Design booked % (year):**

  | Hub | Booked % | Status |
  |---|---|---|
  | R&D-Greece | 25.62 | available |
  | R&D-India | 151.70 | full |
  | PD-India | 146.07 | full |
  | PD-Romania | 54.55 | available |
  | OEM-HCK | 22.64 | available |
  | OEM-Seltek | n/a (no capacity, no load) | available |

  Lab booked % (year) is India 123.74, Greece 21.82 and Romania 11.10.
- **Booked % understates demand.** The run's load excludes what the 126 left-out projects could
  not book. Remaining-year design booked % (CW 42) is above 100 % in every hub except
  OEM-Seltek.
- **Comparison with the auditor's scenarios.** The auditor's "Workbook roster" scenario R1 had
  within year 54 (37 open) and 102 left out. That scenario re-assigned the 97 projects whose
  leader is not on the roster or is blank to the least-loaded roster engineer of the hub (OEM went
  to R&D-Greece). This ADR re-assigns nothing. The auditor's R3 scenario (R1 + the six leaders as
  engineers, Theoni at 0.8) was reproduced exactly from this seed: 36 open within year, 48
  spillover and 108 left out, after filling only the 18 open blank-leader projects in memory. The
  whole remaining difference is therefore those 18 projects: −12 within year, −6 spillover and
  +18 left out (`no_leader`).
- **Engineer list.** The Capacity Planning engineer list and per-engineer utilization show the 23
  real or provisional names. No "<hub> Engineer n" remains.
- **Old databases.** A database seeded before this ADR keeps its old rows until it is reseeded
  with `--reset`. The migration adds only the three nullable columns.
- **Contract test.** The OpenAPI / frontend contract rows `ProjectRead` and `ProjectFilterRow`
  stay red until P24-T02 mirrors the three fields in the frontend types.
