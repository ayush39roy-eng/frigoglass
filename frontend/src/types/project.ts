// PLACEHOLDER — replace with OpenAPI-generated types in P3 (P3-T07 / P4 surface work).
// Hand-authored because P3 does not exist yet. Tracked as debt in the P4-T01 docs/MEMORY.md entry.

import type { Id, WeekNumber } from './common';
import type {
  HubName,
  ProjectCategory,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
} from './enums';

/** Minimal project shape — only fields the shared components / shell need today. */
export interface ProjectSummary {
  id: Id;
  code: string;
  name: string;
  hub: HubName;
  category: ProjectCategory | null;
  type: ProjectType | null;
  status: ProjectStatus;
  priority: ProjectPriority;
  frozen: boolean;
  actual_start_week: WeekNumber | null;
}
