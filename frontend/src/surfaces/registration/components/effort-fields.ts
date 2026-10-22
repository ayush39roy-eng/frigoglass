import type { ApiError } from '@/lib/api/client';

/**
 * P30 (ADR 0041 R7, API_CONTRACT_P30 §2): the two client effort figures on the
 * project form, and the mapping of a 422 `EFFORT_SPLIT_REJECTED` onto one.
 */
export type EffortField = 'design_effort_weeks' | 'lab_effort_weeks';

export const EFFORT_FIELD_IDS: Record<EffortField, string> = {
  design_effort_weeks: 'reg-design-effort',
  lab_effort_weeks: 'reg-lab-effort',
};

/** P30: readable copy for 422 `EFFORT_SPLIT_REJECTED` (the server's own text
 *  cites the ADR; the limit is the domain's 104 weeks per step). */
export const EFFORT_SPLIT_REJECTED_COPY =
  'Too large for this category: one step would get more than 104 weeks. Nothing was saved.';

/** The figure a 422 `EFFORT_SPLIT_REJECTED` names (`detail[0].loc[-1]`,
 *  API_CONTRACT_P30 §2); the design figure when the body names neither. */
export function effortSplitField(err: ApiError): EffortField {
  if (err.detail) {
    try {
      const parsed: unknown = JSON.parse(err.detail);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const loc = item && typeof item === 'object' ? (item as { loc?: unknown }).loc : undefined;
          const last: unknown = Array.isArray(loc) ? loc[loc.length - 1] : undefined;
          if (last === 'design_effort_weeks' || last === 'lab_effort_weeks') return last;
        }
      }
    } catch {
      // a plain-string detail: fall through
    }
  }
  return 'design_effort_weeks';
}

