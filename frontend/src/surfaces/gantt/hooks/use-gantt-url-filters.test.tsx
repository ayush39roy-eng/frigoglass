import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('@/lib/api/categories', () => ({
  useCategoryCodes: () => ['A+', 'A', 'B', 'C'],
  useCategories: () => ({ categories: [] }),
}));

import { useGanttUrlFilters } from './use-gantt-url-filters';
import type { GanttFacets } from '../api/types';

/** P40-T01: the Timeline's multi-select filters as repeated URL params. */

const FACETS: GanttFacets = {
  leaders: [
    { id: 'eng-1', name: 'Ann' },
    { id: 'eng-2', name: null },
  ],
  steps: [
    { code: 'PDD-B', name: 'Feasibility' },
    { code: 'PDD-E', name: 'Design Detailing' },
  ],
};

function setup(route: string, facets: GanttFacets | null = FACETS) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );
  return renderHook(
    () => {
      const filters = useGanttUrlFilters(facets ?? undefined);
      const location = useLocation();
      return { ...filters, search: location.search };
    },
    { wrapper },
  );
}

describe('useGanttUrlFilters', () => {
  it('parses legacy single values and repeated values, drops unknown ones, keeps option order', () => {
    const { result } = setup(
      '/timeline?status=On%20Hold&status=Bogus&priority=Q&priority=P1&step=PDD-E&step=PDD-B&step=ZZ&leader=eng-9&leader=eng-2&type=SER&category=B&category=A%2B',
    );
    expect(result.current.value).toEqual({
      category: ['A+', 'B'],
      type: ['SER'],
      status: ['On Hold'],
      priority: ['P1', 'Q'],
      currentStep: ['PDD-B', 'PDD-E'],
      leaderEngineerId: ['eng-2'],
    });
  });

  it('without facets (no dashboard read) leader ids and well-formed step codes are kept as written', () => {
    const { result } = setup('/timeline?leader=eng-9&step=OEM-C&step=nope', null);
    expect(result.current.value.leaderEngineerId).toEqual(['eng-9']);
    expect(result.current.value.currentStep).toEqual(['OEM-C']);
  });

  it('writes every filter as repeated params in one navigation, keeping other params, and clears them', () => {
    const { result } = setup('/timeline?project=p1');
    act(() =>
      result.current.set({
        category: ['B', 'A+'],
        type: ['NM'],
        status: ['In Queue', 'On Hold'],
        leaderEngineerId: ['eng-1'],
        currentStep: ['PDD-E'],
        priority: ['Q', 'P2'],
      }),
    );
    const params = new URLSearchParams(result.current.search);
    expect(params.get('project')).toBe('p1');
    expect(params.getAll('category')).toEqual(['A+', 'B']);
    expect(params.getAll('type')).toEqual(['NM']);
    expect(params.getAll('status')).toEqual(['In Queue', 'On Hold']);
    expect(params.getAll('leader')).toEqual(['eng-1']);
    expect(params.getAll('step')).toEqual(['PDD-E']);
    expect(params.getAll('priority')).toEqual(['P2', 'Q']);

    act(() =>
      result.current.set({ category: [], type: [], status: [], leaderEngineerId: [], currentStep: [], priority: [] }),
    );
    expect(result.current.search).toBe('?project=p1');
  });
});
