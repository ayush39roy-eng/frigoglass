import { ApiError } from '@/lib/api/client';

/** Shared wording for a rejected inline save. */
export function saveErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.isForbidden) return 'Not saved: your role cannot edit this resource.';
  if (err instanceof ApiError && err.detail) return `Not saved: ${err.detail}`;
  return 'Not saved. Please try again.';
}
