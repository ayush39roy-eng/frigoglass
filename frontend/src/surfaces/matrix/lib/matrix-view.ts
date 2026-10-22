/**
 * P13-T14 Matrix view state and chip options (API_CONTRACT_P13 §7). Category,
 * Type, Status and the Project search are server params; the Hub / Leader
 * column inputs narrow the served rows in view only.
 */

import {
  PROJECT_CATEGORIES,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  type ProjectCategory,
  type ProjectStatus,
  type ProjectType,
  type RoleName,
} from '@/types/enums';

import type { DistributionBand } from '../api/types';

export interface MatrixViewState {
  category: ProjectCategory | null;
  type: ProjectType | null;
  status: ProjectStatus | null;
  /** Project column search → server `q`. */
  q: string;
  /** Hub / Leader column inputs → narrow the served rows in view. */
  hubText: string;
  leaderText: string;
  /** P21: band picked on the distribution chart — narrows the SERVED rows in
   *  view by their served band (no score is re-banded in the browser). */
  band: DistributionBand | null;
  /** P25: show only rows the server promoted by capacity fill (client-side over served rows). */
  capacityFill: boolean;
  /** Owner ask 2026-10-22: show only VIP projects (served `is_vip`). */
  vipOnly: boolean;
  detailed: boolean;
}

export const DEFAULT_MATRIX_VIEW: MatrixViewState = {
  category: null,
  type: null,
  status: null,
  q: '',
  hubText: '',
  leaderText: '',
  band: null,
  capacityFill: false,
  vipOnly: false,
  detailed: false,
};

export function isDefaultView(v: MatrixViewState): boolean {
  return (
    v.category === null &&
    v.type === null &&
    v.status === null &&
    v.q === '' &&
    v.hubText === '' &&
    v.leaderText === '' &&
    v.band === null &&
    !v.capacityFill &&
    !v.vipOnly &&
    !v.detailed
  );
}

export const CATEGORY_CHIPS = PROJECT_CATEGORIES.map((c) => ({ value: c, label: c }));
export const TYPE_CHIPS = PROJECT_TYPES.map((t) => ({ value: t, label: t, title: PROJECT_TYPE_LABELS[t] }));
export const STATUS_CHIPS = PROJECT_STATUSES.map((s) => ({ value: s, label: s }));

/** `PUT /currency-rates/{code}` is `require_roles(ADMIN, SUPER_ADMIN)`
 *  server-side; the editor is offered to the same two roles. UI gating is
 *  convenience only (ADR 0010 §2) — the server still decides. */
export function canEditFxRate(roles: readonly RoleName[] | undefined): boolean {
  return roles?.some((r) => r === 'Admin' || r === 'Super Admin') ?? false;
}

/** P21: how many filters are active (the compact panel's "Filters (n)"). */
export function activeFilterCount(v: MatrixViewState): number {
  return [
    v.category !== null,
    v.type !== null,
    v.status !== null,
    v.band !== null,
    v.capacityFill,
    v.vipOnly,
    v.q.trim() !== '',
    v.hubText.trim() !== '',
    v.leaderText.trim() !== '',
  ].filter(Boolean).length;
}
