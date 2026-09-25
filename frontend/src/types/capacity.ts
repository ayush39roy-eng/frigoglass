// PLACEHOLDER — replace with OpenAPI-generated types in P3 (P3-T07 / P4 surface work).
// Hand-authored because P3 does not exist yet. Tracked as debt in the P4-T01 docs/MEMORY.md entry.

import type { Id } from './common';
import type { EngineerAllowedCategory, HubName, LabRegion } from './enums';

export interface Engineer {
  id: Id;
  name: string;
  hub: HubName;
  fte: number;
  allowed_categories: EngineerAllowedCategory[];
}

export interface Chamber {
  id: Id;
  code: string;
  lab_region: LabRegion;
  max_concurrent: number;
  platforms: string[];
  efficiency: number; // display-only per ADR 0003
  weeks_per_chamber: number; // display-only per ADR 0003
  allowed_stages: string[]; // "PDD-F", "PDD-H", ...
}

/** Aggregate load vs capacity for a hub, from the active schedule run (I6 / I7). */
export interface HubCapacitySummary {
  hub: HubName;
  design_capacity_weeks: number;
  design_load_weeks: number;
  lab_capacity_weeks: number;
  lab_load_weeks: number;
}
