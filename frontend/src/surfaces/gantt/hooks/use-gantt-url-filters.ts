import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  CATEGORY_PARAM,
  TYPE_PARAM,
  canonicalSelection,
  useCategoryFilterValues,
  writeMultiParam,
} from '@/lib/multi-select-filter';
import {
  PROJECT_PRIORITIES,
  PROJECT_TYPES,
  UI_PROJECT_STATUSES,
  type ProjectCategory,
  type ProjectPriority,
  type ProjectStatus,
  type ProjectType,
} from '@/types/enums';

import type { GanttFacets } from '../api/types';
import type { GanttFilterState } from '../lib/gantt-filters';

/**
 * P40-T01 (owner ask 2026-11-17): every multi-select toolbar filter of the
 * Timeline is URL state, written as REPEATED params (`?status=On+Hold&status=In+Queue`).
 * A legacy single-value link (`?category=A`) is a one-element list and still
 * parses. Category / Type keep the P31 names; the others are:
 *
 * | filter          | URL param  | API param            |
 * |-----------------|------------|----------------------|
 * | Category        | `category` | `category`           |
 * | Type            | `type`     | `type`               |
 * | Status          | `status`   | `status_`            |
 * | Leader          | `leader`   | `leader_engineer_id` |
 * | Current step    | `step`     | `current_step`       |
 * | Priority        | `priority` | `priority`           |
 *
 * Values are kept in option order and unknown values are dropped, so a
 * hand-edited link never sends the server a value it would 422. Leader ids and
 * step codes are checked against the served facets once they arrive. All
 * filtering is the server's (I9); this hook only holds the selection.
 */

export const GANTT_FILTER_PARAMS = {
  category: CATEGORY_PARAM,
  type: TYPE_PARAM,
  status: 'status',
  leaderEngineerId: 'leader',
  currentStep: 'step',
  priority: 'priority',
} as const;

export type GanttUrlFilterKey = keyof typeof GANTT_FILTER_PARAMS;
export type GanttUrlFilters = Pick<GanttFilterState, GanttUrlFilterKey>;

const STEP_CODE = /^(PDD|OEM)-[A-N]$/;

function raw(params: URLSearchParams, key: string): string {
  return params.getAll(key).join('\u0000');
}

function split(value: string): string[] {
  return value === '' ? [] : value.split('\u0000');
}

export function useGanttUrlFilters(facets: GanttFacets | undefined): {
  value: GanttUrlFilters;
  set: (next: GanttUrlFilters) => void;
} {
  const [params, setParams] = useSearchParams();
  const categoryValues = useCategoryFilterValues(false) as readonly ProjectCategory[] | null;
  const leaderValues = useMemo(() => (facets ? facets.leaders.map((l) => l.id) : null), [facets]);
  const stepValues = useMemo(() => (facets ? facets.steps.map((s) => s.code) : null), [facets]);

  const allowed = useMemo(
    () => ({
      category: categoryValues,
      type: PROJECT_TYPES as readonly ProjectType[],
      status: UI_PROJECT_STATUSES,
      leaderEngineerId: leaderValues,
      currentStep: stepValues,
      priority: PROJECT_PRIORITIES as readonly ProjectPriority[],
    }),
    [categoryValues, leaderValues, stepValues],
  );

  const rawCategory = raw(params, GANTT_FILTER_PARAMS.category);
  const rawType = raw(params, GANTT_FILTER_PARAMS.type);
  const rawStatus = raw(params, GANTT_FILTER_PARAMS.status);
  const rawLeader = raw(params, GANTT_FILTER_PARAMS.leaderEngineerId);
  const rawStep = raw(params, GANTT_FILTER_PARAMS.currentStep);
  const rawPriority = raw(params, GANTT_FILTER_PARAMS.priority);

  // Re-derived only when a param's raw values change, so array identities stay
  // stable across unrelated URL changes (they feed the query key).
  const value = useMemo<GanttUrlFilters>(
    () => ({
      category: canonicalSelection<ProjectCategory>(split(rawCategory), allowed.category),
      type: canonicalSelection<ProjectType>(split(rawType), allowed.type),
      status: canonicalSelection<ProjectStatus>(split(rawStatus), allowed.status),
      leaderEngineerId: canonicalSelection<string>(split(rawLeader), allowed.leaderEngineerId),
      currentStep: canonicalSelection<string>(
        split(rawStep).filter((c) => STEP_CODE.test(c)),
        allowed.currentStep,
      ),
      priority: canonicalSelection<ProjectPriority>(split(rawPriority), allowed.priority),
    }),
    [rawCategory, rawType, rawStatus, rawLeader, rawStep, rawPriority, allowed],
  );

  /** Writes all six params in ONE navigation (`replace`: a filter click is
   *  not a history entry); every other param is kept. */
  const set = useCallback(
    (next: GanttUrlFilters) => {
      setParams(
        (prev) => {
          let out = prev;
          for (const key of Object.keys(GANTT_FILTER_PARAMS) as GanttUrlFilterKey[]) {
            out = writeMultiParam(
              out,
              GANTT_FILTER_PARAMS[key],
              canonicalSelection<string>(next[key], allowed[key] as readonly string[] | null),
            );
          }
          return out;
        },
        { replace: true },
      );
    },
    [setParams, allowed],
  );

  return { value, set };
}
