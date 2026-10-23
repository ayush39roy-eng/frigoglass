import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { keySelection, sortedKeyList } from '@/lib/query-keys';
import { PROJECT_CATEGORIES } from '@/types/enums';

import {
  canonicalSelection,
  parseMultiParam,
  selectionParam,
  toggleSelection,
  TYPE_FILTER_VALUES,
  useCategoryTypeParams,
  writeMultiParam,
} from './multi-select-filter';

describe('P31 multi-select URL state', () => {
  it('parses repeated params in option order, drops unknown values and duplicates', () => {
    const p = new URLSearchParams('category=B&category=A%2B&category=Z&category=B');
    expect(parseMultiParam(p, 'category', PROJECT_CATEGORIES)).toEqual(['A+', 'B']);
  });

  it('a legacy single-value link is a one-element list; no param is an empty list', () => {
    expect(parseMultiParam(new URLSearchParams('category=A'), 'category', PROJECT_CATEGORIES)).toEqual(['A']);
    expect(parseMultiParam(new URLSearchParams('view=board'), 'category', PROJECT_CATEGORIES)).toEqual([]);
  });

  it('serializes as repeated params (A+ encoded), keeps other params, deletes when empty', () => {
    const base = new URLSearchParams('view=executive&category=C');
    const out = writeMultiParam(base, 'category', ['A+', 'B']);
    expect(out.toString()).toBe('view=executive&category=A%2B&category=B');
    expect(writeMultiParam(out, 'category', []).toString()).toBe('view=executive');
    // The input is not mutated.
    expect(base.toString()).toBe('view=executive&category=C');
  });

  it('round-trips through the URL', () => {
    const out = writeMultiParam(new URLSearchParams(), 'type', ['RC', 'NM', 'Unmapped']);
    expect(parseMultiParam(new URLSearchParams(out.toString()), 'type', TYPE_FILTER_VALUES)).toEqual(['NM', 'RC', 'Unmapped']);
  });

  it('toggles keep option order; an empty selection is not sent', () => {
    expect(toggleSelection(['B'], 'A+', PROJECT_CATEGORIES)).toEqual(['A+', 'B']);
    expect(toggleSelection(['A+', 'B'], 'A+', PROJECT_CATEGORIES)).toEqual(['B']);
    expect(canonicalSelection(['C', 'A'], PROJECT_CATEGORIES)).toEqual(['A', 'C']);
    expect(selectionParam([])).toBeUndefined();
    expect(selectionParam(['A'])).toEqual(['A']);
  });

  it('query keys hold SORTED lists, absent when empty', () => {
    expect(sortedKeyList(['NM', 'CO'])).toEqual(['CO', 'NM']);
    expect(sortedKeyList([])).toBeUndefined();
    expect(keySelection({ categories: ['B', 'A+'], types: ['NM'] })).toEqual({ category: ['A+', 'B'], type: ['NM'] });
    expect(keySelection({ categories: [], types: [] })).toBeNull();
  });

  it('useCategoryTypeParams reads and writes both lists in ONE navigation (no lost write)', () => {
    let search = '';
    function Spy(): null {
      search = useLocation().search;
      return null;
    }
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter initialEntries={['/?view=board&category=A']}>
        {children}
        <Spy />
      </MemoryRouter>
    );
    const { result } = renderHook(() => useCategoryTypeParams(TYPE_FILTER_VALUES), { wrapper });
    expect(result.current.categories).toEqual(['A']);
    expect(result.current.types).toEqual([]);
    act(() => result.current.setBoth(['B', 'A+'], ['Unmapped', 'CO']));
    expect(result.current.categories).toEqual(['A+', 'B']);
    expect(result.current.types).toEqual(['CO', 'Unmapped']);
    expect(search).toBe('?view=board&category=A%2B&category=B&type=CO&type=Unmapped');
    act(() => result.current.clear());
    expect(search).toBe('?view=board');
  });
});
