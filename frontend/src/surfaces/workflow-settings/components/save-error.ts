import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';

/** Human text for a failed Workflow Settings PUT. Coded errors (CYCLE,
 *  KIND_IN_USE, WORKFLOW_CHANGE_WITH_PROGRESS, BAD_STEP_SET, BAD_CALENDAR …)
 *  are shown as `CODE: readable text` so the editor can act and support can
 *  search for the code. */
export function saveErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.isForbidden && !err.code) return 'Only a Super Admin can change workflow settings.';
  const text = apiErrorMessage(err, 'The settings could not be saved. Please try again.');
  return err instanceof ApiError && err.code ? `${err.code}: ${text}` : text;
}
