import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { formatInteger } from '@/lib/format';

import { COMMENT_MAX_CHARS, type ActivityItem, type CommentRead } from '../api/types';

/** 15-minute author edit window (P9 contract §7). The SERVER decides via
 *  `can_edit` and enforces with 403 EDIT_LOCKED; this only hides the affordance
 *  once the window lapses while the page is open. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

export function canStillEdit(comment: CommentRead, now: number = Date.now()): boolean {
  if (!comment.can_edit) return false;
  const created = Date.parse(comment.created_at);
  return Number.isNaN(created) ? comment.can_edit : now - created < EDIT_WINDOW_MS;
}

export function activityTime(item: ActivityItem): string {
  return item.kind === 'comment' ? item.comment.created_at : item.occurred_at;
}

export function activityKey(item: ActivityItem): string {
  return item.kind === 'comment' ? `c-${item.comment.id}` : `e-${item.id}`;
}

/** The `@query` being typed immediately before the caret, if any. */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{1,40})$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { query, start: caret - query.length - 1 };
}

/** "10,000 characters" — the server cap, shown by the counter and the 422 copy. */
export const COMMENT_LIMIT_TEXT = `${formatInteger(COMMENT_MAX_CHARS)} characters`;

/**
 * Readable copy for a failed comment create/edit (P9-R03). 429 (`RATE_LIMITED`)
 * and the edit-lock codes come from the shared map. A 422 without a code is
 * the Pydantic length check on `body_md` (the composer blocks empty bodies), so
 * it gets the limit in words instead of a raw field-error list.
 */
export function commentErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && !err.code) {
    if (err.status === 422) return `Comments are limited to ${COMMENT_LIMIT_TEXT}. Shorten it and try again.`;
    if (err.isForbidden) return 'Your role cannot comment on this project.';
  }
  return apiErrorMessage(err, fallback);
}
