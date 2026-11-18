/**
 * P47-T03 (ADR 0059 C2, freshness): the query options of an editable grid or
 * form. While nobody is editing, the data refetches on window focus and every
 * 60 s, so users see each other's saved changes without reloading. While an
 * edit is in progress both are off, so a refetch never replaces what the user
 * is typing (and the `base` they started from stays the value they read).
 */

export const EDIT_POLL_MS = 60_000;

export interface EditFreshnessOptions {
  refetchOnWindowFocus: boolean;
  refetchInterval: number | false;
  refetchIntervalInBackground: false;
}

export function editFreshness(editing: boolean): EditFreshnessOptions {
  return {
    refetchOnWindowFocus: !editing,
    refetchInterval: editing ? false : EDIT_POLL_MS,
    refetchIntervalInBackground: false,
  };
}

/** A shared query hook's optional freshness argument. */
export type QueryFreshness = Partial<EditFreshnessOptions>;
