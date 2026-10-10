# ADR 0016: Capacity "booked %" per hub and per area (Europe / India), with Full flags

## Status

Accepted (2026-10-09). Part of P11. Adds reporting figures on top of ADR 0008. It changes no supply
or load formula and does not affect booking.

## Context

Frigoglass asked (relayed 2026-10-09): "Lab and design capacity. Design and chamber full. Europe
design booked 90 percent and lab 50 percent booked." The Capacity surface already serves load,
capacity, gap and the workbook's `completion_pct = capacity / load`. The client does not think in
"completion %". They think in **how full** design and lab are: "booked %". They also think in
**areas**: Europe (Greece, Romania) against India. The app currently has no such grouping.

## Decision

### 1. Booked % is load over capacity

For each hub row, for each of `year` and `remaining`, and for design and lab:

```
booked_pct = load / capacity × 100          (2 dp; null when capacity == 0)
```

This uses exactly the served load (I6/I7) and capacity (ADR 0008) of the same row. It is the
reciprocal of `completion_pct`, so the two can never disagree. Above 100 % means over-booked:
more work is planned than the capacity can deliver.

### 2. Booking status is server-derived

```
full       booked_pct >= 100   (or capacity == 0 and load > 0)
near_full  85 <= booked_pct < 100
available  booked_pct < 85     (or load == 0)
```

The thresholds are `domain_constants.BOOKING_NEAR_FULL_PCT = 85` and `BOOKING_FULL_PCT = 100`.
They are constants for now. Making them configurable is `docs/OPEN_QUESTIONS.md` #25. The browser
renders the status. It never re-derives it (I17's rule, extended by I19).

### 3. Areas: Europe and India

The area is a function of the hub's lab region:

| Lab region | Area |
|---|---|
| Greece | Europe |
| Romania | Europe |
| India | India |

So Europe is R&D-Greece and PD-Romania. India is R&D-India, PD-India, OEM-HCK and OEM-Seltek. The
OEM hubs fall under India because their lab region is India (OQ #26).

Area figures are sums over the area's hubs and lab regions that are in the caller's scope:

```
area.design_load     = Σ hub.design_load_weeks            over the area's hubs
area.design_capacity = Σ hub.design_capacity_{year,remaining}
area.lab_load        = Σ region lab load                  over the area's lab regions (each region once)
area.lab_capacity    = Σ region lab capacity_{year,remaining}   (each region once)
area.booked_pct, area.status  as §1–§2 on those sums
```

Lab figures are region-level and are repeated on every hub row of that region. The area sum must
count each region **once**. Summing the hub rows would double-count India three times over.

A hub-scoped user sees an area built only from the hubs in their scope. Each area row lists the
hubs and regions it covers, so a partial area is never presented as the whole of Europe.

## Consequences

- The Capacity surface leads with an area strip, for example "Europe: Design 90 % booked (near
  full), Lab 50 % booked". Each hub row gains a booked % with a Full / Near full chip. The
  Dashboard gains a small "Capacity booked" card with the same figures.
- Load is the run's total planned design and lab work. It is not cut at week 52. Against
  *remaining* capacity that is a pessimistic "booked" figure. Against *year* capacity it matches
  the workbook's own comparison. The page's existing year / remaining toggle picks which one is
  shown. The client may instead mean "share of the calendar the scheduler has already filled".
  That is a different, run-booking-based figure, and it is asked as OQ #25.
- No scheduler change. `backend/scheduling/` is untouched.
