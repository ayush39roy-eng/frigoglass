/**
 * P40-T03c (ADR 0054, docs/API_CONTRACT_P40.md §1): the Timeline's manual step
 * Start / End weeks batch save, `PUT /gantt/step-pins`.
 *
 * Thin wrapper only. The server checks every rule (who, which steps, the week
 * domain) under the project row lock, writes all or nothing and starts ONE
 * greedy run. The browser sends the drafted pairs as typed and maps the
 * per-item refusals back onto their inputs.
 */

import { ApiError, apiSend } from '@/lib/api/client';

import type { PinBlockReason, StepPinError, StepPinsRequest, StepPinsResponse } from './types';

/** Server cap on one batch (`StepPinsRequest.items`, 1..500). */
export const STEP_PINS_MAX = 500;

export function saveStepPins(body: StepPinsRequest): Promise<StepPinsResponse> {
  return apiSend<StepPinsResponse>('PUT', '/gantt/step-pins', body);
}

function isPinError(v: unknown): v is StepPinError {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.index === 'number' &&
    typeof o.project_id === 'string' &&
    typeof o.step_template_id === 'string' &&
    typeof o.code === 'string' &&
    typeof o.message === 'string'
  );
}

/** The per-item errors of a refused batch (`detail.errors`); `[]` otherwise
 *  (a role 403, a request-validation 422 without `code`, a network error). */
export function stepPinErrors(err: unknown): StepPinError[] {
  if (!(err instanceof ApiError) || !err.detail) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.detail);
  } catch {
    return [];
  }
  const list: unknown =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { errors?: unknown }).errors : null;
  return Array.isArray(list) ? list.filter(isPinError) : [];
}

/** Readable copy per refusal code. `PIN_OUT_OF_RANGE` prints the server's own
 *  message, which names the allowed weeks ("Pick weeks between W31 and W52."). */
const PIN_ERROR_COPY: Partial<Record<StepPinError['code'], string>> = {
  DUPLICATE_STEP: 'This step was listed twice.',
  PIN_INVALID: 'Enter both weeks, with the end on or after the start.',
  PROJECT_NOT_FOUND: 'This project is not in your scope any more.',
  UNKNOWN_STEP: 'This step is no longer part of the project’s workflow.',
  PROJECT_FROZEN: 'The project is frozen: its step weeks cannot change.',
  PROJECT_CLOSED: 'The project is Cancelled or Commercialized.',
  STEP_STARTED: 'The step has started: its weeks now follow progress.',
  STEP_SKIPPED: 'The step is skipped for this project.',
};

export function stepPinErrorText(error: StepPinError): string {
  if (error.code === 'PIN_OUT_OF_RANGE') return error.message || 'These weeks are outside the plan year.';
  return PIN_ERROR_COPY[error.code] ?? (error.message || error.code);
}

/** Tooltip for a read-only Start / End pair (served `pin_block_reason`). */
export const PIN_BLOCK_REASON_COPY: Record<PinBlockReason, string> = {
  NOT_ALLOWED: 'Only Admin and Super Admin can set step weeks.',
  PROJECT_FROZEN: 'The project is frozen: its step weeks cannot be set.',
  PROJECT_CLOSED: 'The project is Cancelled or Commercialized: its step weeks cannot be set.',
  STEP_STARTED: 'The step has started: its weeks follow progress, not a typed week.',
  STEP_SKIPPED: 'The step is skipped for this project, so it has no weeks to set.',
};
