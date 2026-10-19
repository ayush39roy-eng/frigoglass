# ADR 0027: VIP projects move to the Dashboard as a curated per-area board

## Status

Accepted (2026-10-19). Part of P14. Supersedes ADR 0022's separate page and automatic fill. No
scheduler change.

## Context

Frigoglass asked (relayed 2026-10-19): "for VIP no separate section needed; it can be shown on the
dashboard as a pop-up … they have 2–3 VIP each hub, so it can show VIP project hub name, on
clicking the hub the projects pop up, and on clicking the project the project folder comes". They
sent three slides, one each for **OEM**, **Europe** and **India**. Each slide has three pillars:

| # | Pillar | Headline | Impact line |
|---|---|---|---|
| 01 | INNOVATION | Refresh product aesthetics to strengthen differentiation | Differentiation • Fresh Looks • value |
| 02 | MARKET EXPANSION | Launch platforms and scale regional demand | New Product • New customer • Plant Capacity |
| 03 | PERFORMANCE | Deliver RM savings, compliance and continuity | Savings • compliance • reliable delivery |

Each pillar holds bullet items:
- some items are highlighted, meaning they are the key ones;
- some carry a status tag ("On track", "delayed", "HIGH RISK", "Commercialized", "TBD");
- some have sub-items (for example "Monster Range:" with three models).

Many items are themes, not one project. "BEE 5-star labelling" spans about 25 R&D-India projects,
and "79 x Raw-material saving projects" is a count. So the list cannot be derived from our project
rows. It is curated content.

## Decision

1. **Remove the `/vip` page from the navigation.** The route redirects to `/` (Dashboard).
   - `GET /vip-projects`, `PUT /projects/{id}/vip` and the VIP badges on Gantt and Projects stay.
     The flag is now set from the curated board (§3).
2. **VIP areas.** There are three, matching the client's slides:
   - **OEM** = OEM-HCK and OEM-Seltek;
   - **Europe** = R&D-Greece and PD-Romania;
   - **India** = PD-India and R&D-India.

   Area membership is derived from the hub. OEM hubs are OEM. The other hubs follow their lab
   region: Greece and Romania → Europe, India → India. It is served, never hard-coded in the
   browser.
3. **Curated items.** A new table `vip_items` with these columns:
   - `id`, `area`, `pillar` (`INNOVATION` | `MARKET_EXPANSION` | `PERFORMANCE`);
   - `title` (≤200);
   - `status_tag` (`ON_TRACK` | `DELAYED` | `HIGH_RISK` | `COMMERCIALIZED` | `IMPLEMENTED` |
     `TBD` | `UNDER_INVESTIGATION` | `AWAITING_APPROVAL` | null);
   - `status_note` (free text ≤200, for example "Tooling delayed" or "to meet Brau timelines");
   - `highlighted` (bool);
   - `parent_id` (one level of sub-items);
   - `sort_order`;
   - audit timestamps.

   A join table `vip_item_projects(item_id, project_id)` links an item to zero or more of our
   projects. The pillar headline and impact line are fixed reference data, served with the board.
4. **Seed.** The three slides are seeded verbatim as the initial board, using the latest version of
   each slide that was sent. Project links are seeded only where an item clearly names an existing
   project (see the seed table in `API_CONTRACT_P14.md` §3). Everything else stays unlinked. No link
   is ever guessed.
5. **Editing.** Portfolio Manager and Admin (`MATRIX` WRITE) can add, edit, reorder and delete items
   and their links. Every change is audited (`vip_item.*`). Linking or unlinking sets or clears the
   project's `is_vip` flag (ADR 0022 §4). A pin still never recalculates the schedule.
6. **Dashboard UI.** A "VIP projects" card shows one tile per area in the caller's scope.
   - **Tile:** the area name, its hubs, the counts of highlighted and high-risk items, and the
     number of linked projects.
   - **Clicking a tile** opens a dialog laid out like the slide: three pillar columns, each with
     items, highlights and status tags.
   - **Clicking an item:**
     - one linked project → that project's Workspace (the "project folder");
     - several → a short list to pick from;
     - none → not clickable.
   - **Linked items** also show served live facts for each project: priority, projected finish,
     within-year and health from the active run (I9).
   - **Hub scope.** A hub-scoped user sees only the areas containing their hubs, and only linked
     projects in scope. Items themselves are portfolio content and are not hidden. No financial
     fields are shown.

## Consequences

- ADR 0022's automatic fill and its 10–15 limit are no longer shown. The client defines VIP by
  curation. OQ #32 is answered: the list is curated only.
- OQ #39 asks the client to confirm two things: that the areas are OEM / Europe / India rather than
  six hubs, and that highlighted means "VIP".

## Amendment (2026-10-19): client answer to OQ #39

The client confirmed two things:
- **Yellow highlight = VIP.**
- **The areas are Greece, India and Romania.**

So:
- `area` is the hub's `lab_region` (Greece / India / Romania), the same grouping as the ADR 0025
  country filter. OEM hubs count as Greece.
- The seed maps the slides as follows:
  - the "OEM" slide → **Greece**;
  - the "Europe" slide → **Romania** (every linked project there is PD-Romania);
  - the "India" slide → **India**.
- **VIP = a highlighted item.**
  - `projects.is_vip` is set only for projects linked to a highlighted item.
  - The tile lists the area's VIP (highlighted) items by name.
  - The pop-up still shows the whole slide, with the VIP items emphasised.
- The area-mismatch check (422) compares the project's hub `lab_region` with the item's area.

## Acceptance (2026-10-19, P14 security gate S3)

The seeded VIP item titles contain customer and brand names (for example Heineken, Pepsi, Hell,
HNKN, CC). They are client-authored slide text, shown to every Dashboard reader by design.
Accepted by the orchestrator as plaintext in `vip_items.title`. CLAUDE.md's "customer name"
encryption covers the Matrix financial customer-name field, not portfolio slide titles.
**Open for the owner or the client to overrule:** if Frigoglass wants these redacted, change the
seed text and the existing rows. No schema change is needed.
