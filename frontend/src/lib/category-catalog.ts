/**
 * P33-T14 (ADR 0047 §4, API_CONTRACT_P33 B1/Part I): project categories are DATA.
 *
 * `GET /reference/categories` serves `{code, label, workflow_id, rank}` objects
 * in rank order; an Admin can add one (B2), so no module may hold a category
 * list. This file is the pure, React-Query-free half:
 *
 * - `CategoryCatalog`: the served list as lookups (rank order, label, workflow,
 *   palette slot). Built only from served objects.
 * - A tiny external store mirroring the last served list, so code that cannot
 *   call a query hook (the `CategoryTag` pill rendered 236 times, chart colour
 *   callbacks, URL parsing) reads the same list. `useCategories()`
 *   (`lib/api/categories.ts`) is the only writer.
 *
 * Nothing here filters rows or computes a figure (I9). Ordering by rank is the
 * served order; the catalog only keeps it.
 */

import { useSyncExternalStore } from 'react';

import { OEM_ELIGIBILITY_CODE, type WorkflowId } from '@/types/enums';

/** One `GET /reference/categories` row (B1). */
export interface Category {
  code: string;
  label: string;
  workflow_id: WorkflowId;
  rank: number;
}

export class CategoryCatalog {
  /** Served rows, ascending `rank`. */
  readonly categories: readonly Category[];
  /** Codes, ascending `rank`. */
  readonly codes: readonly string[];
  private readonly byCode: ReadonlyMap<string, Category>;

  constructor(rows: readonly Category[]) {
    this.categories = [...rows].sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));
    this.codes = this.categories.map((c) => c.code);
    this.byCode = new Map(this.categories.map((c) => [c.code, c]));
  }

  get isEmpty(): boolean {
    return this.categories.length === 0;
  }

  get(code: string): Category | undefined {
    return this.byCode.get(code);
  }

  has(code: string): boolean {
    return this.byCode.has(code);
  }

  /** The served label; the code itself for a code the list does not carry. */
  labelOf(code: string): string {
    return this.byCode.get(code)?.label ?? code;
  }

  /** The categories of one workflow, in rank order. */
  forWorkflow(workflow: WorkflowId): readonly Category[] {
    return this.categories.filter((c) => c.workflow_id === workflow);
  }

  /** Codes of one workflow, in rank order. */
  codesForWorkflow(workflow: WorkflowId): readonly string[] {
    return this.forWorkflow(workflow).map((c) => c.code);
  }

  /**
   * Engineer eligibility values (`engineers.allowed_categories`): the PDD
   * categories, the reserved blanket `OEM`, then the OEM-workflow categories,
   * each group in rank order (the pre-P33 A+, A, B, C, OEM, A-OEM, B-OEM, C-OEM).
   * Empty while the list is not loaded.
   */
  eligibilityCodes(): readonly string[] {
    if (this.isEmpty) return [];
    return [...this.codesForWorkflow('PDD'), OEM_ELIGIBILITY_CODE, ...this.codesForWorkflow('OEM')];
  }

  /** Position in rank order (0-based); unknown codes sort last. */
  orderOf(code: string): number {
    const i = this.codes.indexOf(code);
    return i === -1 ? this.codes.length : i;
  }

  /** A comparator for rank order (unknown codes last, then by code). */
  compare = (a: string, b: string): number => this.orderOf(a) - this.orderOf(b) || a.localeCompare(b);
}

export const EMPTY_CATEGORY_CATALOG = new CategoryCatalog([]);

/* ------------------------------- the mirror ------------------------------- */

let current: CategoryCatalog = EMPTY_CATEGORY_CATALOG;
const listeners = new Set<() => void>();

function sameRows(a: readonly Category[], b: readonly Category[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return y !== undefined && x.code === y.code && x.label === y.label && x.workflow_id === y.workflow_id && x.rank === y.rank;
    })
  );
}

/** Replace the mirrored list (no-op when unchanged, so subscribers do not churn). */
export function setCategoryCatalog(rows: readonly Category[]): CategoryCatalog {
  const next = new CategoryCatalog(rows);
  if (sameRows(next.categories, current.categories)) return current;
  current = next;
  for (const l of listeners) l();
  return current;
}

/** The last served list (empty before the first response). */
export function getCategoryCatalog(): CategoryCatalog {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe a component to the mirrored list (no QueryClient needed). */
export function useCategoryCatalogSnapshot(): CategoryCatalog {
  return useSyncExternalStore(subscribe, getCategoryCatalog, getCategoryCatalog);
}
