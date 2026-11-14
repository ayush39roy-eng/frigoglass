/**
 * P13-T13 Gantt toolbar state (API_CONTRACT_P13 §7). Every field maps to a
 * `GET /gantt` server param; nothing here narrows rows in the browser.
 */

import type {
  ProjectCategory,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
} from '@/types/enums';

import type { GanttSort } from '../api/types';

export const ALL = '__all__';
export const SEARCH_MAX_LENGTH = 100;

export interface GanttFilterState {
  q: string;
  /** P31: multi-select, sent as repeated params (OR); empty = all. URL state on the page. */
  category: ProjectCategory[];
  type: ProjectType[];
  /** Multi-select (owner ask 2026-11-13): repeated params (OR); empty = all. */
  status: ProjectStatus[];
  leaderEngineerId: string[];
  currentStep: string[];
  priority: ProjectPriority[];
  sort: GanttSort;
}

export const DEFAULT_GANTT_FILTERS: GanttFilterState = {
  q: '',
  category: [],
  type: [],
  status: [],
  leaderEngineerId: [],
  currentStep: [],
  priority: [],
  sort: 'priority',
};

export function hasActiveFilters(f: GanttFilterState): boolean {
  return (
    f.q.trim() !== '' ||
    f.category.length > 0 ||
    f.type.length > 0 ||
    f.status.length > 0 ||
    f.leaderEngineerId.length > 0 ||
    f.currentStep.length > 0 ||
    f.priority.length > 0
  );
}
