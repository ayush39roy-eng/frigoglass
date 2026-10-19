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
  category: ProjectCategory | null;
  type: ProjectType | null;
  status: ProjectStatus | null;
  leaderEngineerId: string | null;
  currentStep: string | null;
  priority: ProjectPriority | null;
  sort: GanttSort;
}

export const DEFAULT_GANTT_FILTERS: GanttFilterState = {
  q: '',
  category: null,
  type: null,
  status: null,
  leaderEngineerId: null,
  currentStep: null,
  priority: null,
  sort: 'priority',
};

export function hasActiveFilters(f: GanttFilterState): boolean {
  return (
    f.q.trim() !== '' ||
    f.category !== null ||
    f.type !== null ||
    f.status !== null ||
    f.leaderEngineerId !== null ||
    f.currentStep !== null ||
    f.priority !== null
  );
}
