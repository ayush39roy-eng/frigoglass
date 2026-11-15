/**
 * P33-T14 test fixtures: the served category list (`GET /reference/categories`,
 * B1) as unit tests see it. `src/test/setup.ts` mocks `@/lib/api/categories`
 * globally to serve `testCategories()` and mirrors it into
 * `lib/category-catalog`, so every surface renders the seven seeded categories
 * by default. A test that needs another list (an 8th category) calls
 * `setTestCategories(...)` BEFORE rendering; it is reset after every test.
 *
 * This is the only place in `src/` that lists category codes.
 */

import { setCategoryCatalog, type Category } from '@/lib/category-catalog';

/** The seven categories the `p33a_categories` migration seeds, ranks 1..7. */
export const SEEDED_TEST_CATEGORIES: readonly Category[] = [
  { code: 'A+', label: 'A+', workflow_id: 'PDD', rank: 1 },
  { code: 'A', label: 'A', workflow_id: 'PDD', rank: 2 },
  { code: 'B', label: 'B', workflow_id: 'PDD', rank: 3 },
  { code: 'C', label: 'C', workflow_id: 'PDD', rank: 4 },
  { code: 'A-OEM', label: 'A-OEM', workflow_id: 'OEM', rank: 5 },
  { code: 'B-OEM', label: 'B-OEM', workflow_id: 'OEM', rank: 6 },
  { code: 'C-OEM', label: 'C-OEM', workflow_id: 'OEM', rank: 7 },
];

/** An 8th category inserted between B and C (contract B2's example): ranks 1..8. */
export const WITH_B2_TEST_CATEGORIES: readonly Category[] = [
  ...SEEDED_TEST_CATEGORIES.slice(0, 3),
  { code: 'B2', label: 'B2 (light refresh)', workflow_id: 'PDD', rank: 4 },
  ...SEEDED_TEST_CATEGORIES.slice(3).map((c) => ({ ...c, rank: c.rank + 1 })),
];

let current: readonly Category[] = SEEDED_TEST_CATEGORIES;

export function testCategories(): readonly Category[] {
  return current;
}

/** Serve `rows` from the mocked `useCategories()` and the catalog mirror. */
export function setTestCategories(rows: readonly Category[]): void {
  current = rows;
  setCategoryCatalog(rows);
}

export function resetTestCategories(): void {
  setTestCategories(SEEDED_TEST_CATEGORIES);
}
