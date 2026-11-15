import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';

/**
 * P33-T18 (API_CONTRACT_P33 B2): copy for a refused "+ Add category", keyed by
 * the server's error code and mapped to the field it concerns.
 */

export type AddCategoryField = 'code' | 'copy_from' | 'insert_after' | 'form';

export const ADD_CATEGORY_COPY = {
  BAD_CATEGORY_CODE: 'Use 1–16 letters, digits, spaces, + or -. “OEM” is reserved.',
  CATEGORY_EXISTS: 'A category with this code already exists (upper and lower case count as the same).',
  BAD_COPY_SOURCE: 'Choose a category of the same workflow to copy from.',
  BAD_POSITION: 'That place in the order no longer exists. Pick the position again.',
  tooLong: 'The code is too long — 16 characters at most.',
  rateLimited: 'Too many new categories in a row — wait a few seconds and try again.',
  required: 'Enter a code.',
} as const;

/** Map a refused B2 call to the field it concerns. */
export function addCategoryError(err: unknown): { field: AddCategoryField; message: string } {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'BAD_CATEGORY_CODE':
        return { field: 'code', message: ADD_CATEGORY_COPY.BAD_CATEGORY_CODE };
      case 'CATEGORY_EXISTS':
        return { field: 'code', message: ADD_CATEGORY_COPY.CATEGORY_EXISTS };
      case 'BAD_COPY_SOURCE':
        return { field: 'copy_from', message: ADD_CATEGORY_COPY.BAD_COPY_SOURCE };
      case 'BAD_POSITION':
        return { field: 'insert_after', message: ADD_CATEGORY_COPY.BAD_POSITION };
      default:
        break;
    }
    if (err.status === 429) {
      return {
        field: 'form',
        message:
          err.retryAfterSeconds === undefined
            ? ADD_CATEGORY_COPY.rateLimited
            : `Too many new categories in a row — wait ${String(Math.max(1, err.retryAfterSeconds))} s and try again.`,
      };
    }
    // The schema's own 422 (a code over 64 characters; contract B2 ruling).
    if (err.status === 422 && err.code === undefined && err.detail?.includes('"code"')) {
      return { field: 'code', message: ADD_CATEGORY_COPY.tooLong };
    }
  }
  return { field: 'form', message: apiErrorMessage(err, 'The category could not be added. Nothing was changed.') };
}

