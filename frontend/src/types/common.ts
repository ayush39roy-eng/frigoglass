// PLACEHOLDER — replace with OpenAPI-generated types in P3 (P3-T07 / P4 surface work).
// Hand-authored because P3 does not exist yet. Tracked as debt in the P4-T01 docs/MEMORY.md entry.

/** UUID string, as the backend uses `uuid.uuid4()` PKs (backend/models/base.py). */
export type Id = string;

/** 1-indexed ABSOLUTE week number from the served `week_base_year` W1 (P53, ADR
 *  0063: 2027 W1 = 53, never re-based). It is shown as the week of its own year —
 *  57 → "W5" in plan year 2027, "W5 '27" otherwise, "Week 5 of 2027" on hover
 *  (`formatWeek` / `formatWeekTitle`, owner rule 2026-11-18), never as W53+. */
export type WeekNumber = number;

export interface Paginated<T> {
  items: T[];
  total: number;
  next_cursor: string | null;
}

export interface ApiError {
  detail: string;
  code?: string;
}

/** A single versioned schedule/priority run reference (Versions & History, §2). */
export interface VersionRef {
  id: Id;
  label: string;
  created_at: string;
  is_active: boolean;
}
