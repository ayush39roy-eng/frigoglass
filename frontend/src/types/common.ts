// PLACEHOLDER — replace with OpenAPI-generated types in P3 (P3-T07 / P4 surface work).
// Hand-authored because P3 does not exist yet. Tracked as debt in the P4-T01 docs/MEMORY.md entry.

/** UUID string, as the backend uses `uuid.uuid4()` PKs (backend/models/base.py). */
export type Id = string;

/** 1-indexed absolute week number within the 78-week horizon (DOMAIN_RULES.md). */
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
