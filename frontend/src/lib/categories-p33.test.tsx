/**
 * P33-T14 acceptance (ADR 0047 §4, API_CONTRACT_P33 Part I): with an 8th,
 * Admin-added category served, every category filter, chip and donut shows it
 * in rank order; the seven seeded categories keep their colours; an unknown
 * code falls back to a free palette slot.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, within } from '@testing-library/react';

import { MultiChipFilter } from '@/components/shared/multi-chip-filter';
import { CategoryTag } from '@/components/ui/category-tag';
import { categoryRank, categoricalRankSoftBg } from '@/lib/categorical-palette';
import { CategoryCatalog } from '@/lib/category-catalog';
import { useCategoryChipOptions, useCategoryFilterValues } from '@/lib/multi-select-filter';
import { CategoryDonut } from '@/surfaces/dashboard/components/executive/executive-charts';
import { categoriesForHub } from '@/surfaces/planning/whatif/scenario-schema';
import { renderWithProviders } from '@/test/render';
import { SEEDED_TEST_CATEGORIES, setTestCategories, WITH_B2_TEST_CATEGORIES } from '@/test/category-fixtures';

const SEVEN = new CategoryCatalog(SEEDED_TEST_CATEGORIES);
const EIGHT = new CategoryCatalog(WITH_B2_TEST_CATEGORIES);

describe('CategoryCatalog', () => {
  it('keeps the served rank order whatever order the rows arrive in', () => {
    const shuffled = new CategoryCatalog([...WITH_B2_TEST_CATEGORIES].reverse());
    expect(shuffled.codes).toEqual(['A+', 'A', 'B', 'B2', 'C', 'A-OEM', 'B-OEM', 'C-OEM']);
    expect(shuffled.codesForWorkflow('PDD')).toEqual(['A+', 'A', 'B', 'B2', 'C']);
    expect(shuffled.labelOf('B2')).toBe('B2 (light refresh)');
    expect(shuffled.labelOf('Z9')).toBe('Z9');
  });

  it('engineer eligibility: PDD categories, the blanket OEM, then OEM-workflow ones', () => {
    expect(EIGHT.eligibilityCodes()).toEqual(['A+', 'A', 'B', 'B2', 'C', 'OEM', 'A-OEM', 'B-OEM', 'C-OEM']);
    expect(new CategoryCatalog([]).eligibilityCodes()).toEqual([]);
  });
});

describe('category palette (ADR 0047 §4)', () => {
  it('the seven seeded codes keep their slots after a category is inserted ahead of some of them', () => {
    for (const code of SEVEN.codes) expect(categoryRank(code, EIGHT)).toBe(categoryRank(code, SEVEN));
    expect(SEVEN.codes.map((c) => categoryRank(c, SEVEN))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('a new code takes the next free slot by rank; more wrap over the ramp', () => {
    expect(categoryRank('B2', EIGHT)).toBe(7);
    const nine = new CategoryCatalog([
      ...WITH_B2_TEST_CATEGORIES,
      { code: 'A0', label: 'A0', workflow_id: 'PDD', rank: 0 },
    ]);
    // A0 ranks before B2, so it takes slot 7 and B2 moves to 8.
    expect(categoryRank('A0', nine)).toBe(7);
    expect(categoryRank('B2', nine)).toBe(8);
  });

  it('an unknown code (not in the served list) falls back to the first free slot', () => {
    expect(categoryRank('Z9', SEVEN)).toBe(7);
    expect(categoryRank('Z9', new CategoryCatalog([]))).toBe(7);
  });
});

function ChipHarness({ withUnmapped = false }: { withUnmapped?: boolean }): React.JSX.Element {
  const options = useCategoryChipOptions(withUnmapped);
  const [value, setValue] = React.useState<string[]>([]);
  return <MultiChipFilter label="Category" options={options} value={value} onChange={setValue} />;
}

describe('an 8th category in every filter, chip and donut', () => {
  it('filter chips (Matrix, Gantt, Priority board, Projects, Dashboard) list it in rank order with its label as tooltip', () => {
    setTestCategories(WITH_B2_TEST_CATEGORIES);
    render(<ChipHarness withUnmapped />);
    const group = screen.getByRole('group', { name: 'Category' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'All',
      'A+',
      'A',
      'B',
      'B2',
      'C',
      'A-OEM',
      'B-OEM',
      'C-OEM',
      'Unmapped',
    ]);
    expect(within(group).getByRole('button', { name: 'B2' })).toHaveAttribute('title', 'B2 (light refresh)');
  });

  it('filter values (URL / API params) are the served codes in rank order', () => {
    setTestCategories(WITH_B2_TEST_CATEGORIES);
    const { result } = renderHook(() => useCategoryFilterValues(true));
    expect(result.current).toEqual(['A+', 'A', 'B', 'B2', 'C', 'A-OEM', 'B-OEM', 'C-OEM', 'Unmapped']);
  });

  it('the category tag shows the code, tinted from the next free slot, label as tooltip', () => {
    setTestCategories(WITH_B2_TEST_CATEGORIES);
    render(<CategoryTag category="B2" />);
    const tag = screen.getByText('B2');
    expect(tag).toHaveAttribute('title', 'B2 (light refresh)');
    expect(tag.className).toContain(categoricalRankSoftBg(7));
    render(<CategoryTag category="A" />);
    expect(screen.getByText('A')).not.toHaveAttribute('title');
  });

  it('the Dashboard category donut legend lists it in rank order and it filters', () => {
    setTestCategories(WITH_B2_TEST_CATEGORIES);
    const onChange = vi.fn();
    renderWithProviders(
      <CategoryDonut
        buckets={[
          { key: 'C', count: 5, share_pct: 25 },
          { key: 'B2', count: 5, share_pct: 25 },
          { key: 'A+', count: 10, share_pct: 50 },
        ]}
        total={20}
        selected={[]}
        onChange={onChange}
      />,
    );
    const legend = within(screen.getByTestId('exec-category-donut')).getByRole('group', {
      name: 'Filter the Dashboard by category',
    });
    const names = within(legend)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => ['A+', 'B2', 'C'].some((c) => t.startsWith(c)));
    expect(names.map((t) => t.replace(/[^A-Z0-9+]+.*$/i, ''))).toEqual(['A+', 'B2', 'C']);
    within(legend).getByRole('button', { name: /^B2/ }).click();
    expect(onChange).toHaveBeenLastCalledWith(['B2']);
  });

  it('the What-if line category select offers it for a PDD hub, not an OEM one', () => {
    expect(categoriesForHub('PD-India', EIGHT)).toEqual(['A+', 'A', 'B', 'B2', 'C']);
    expect(categoriesForHub('OEM-HCK', EIGHT)).toEqual(['A-OEM', 'B-OEM', 'C-OEM']);
  });
});
