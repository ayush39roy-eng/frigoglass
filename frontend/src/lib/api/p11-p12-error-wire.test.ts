import { afterEach, describe, expect, it, vi } from 'vitest';

import { setStepTiming } from '@/surfaces/gantt/api/gantt-api';
import { TIMING_ERROR_COPY, timingErrorCopy } from '@/surfaces/gantt/components/step-timing/timing-copy';

import { checkInEntryErrors, CHECKIN_INVALID, submitCheckIns } from './check-ins';
import { ApiError } from './client';
import { API_ERROR_MESSAGES, apiErrorMessage } from './error-messages';
import { HARD_GATE_FORCES_P1, moveProjectPriority } from './priority-move';

/**
 * P12-T06 gate (qa-inspector): the P11/P12 error bodies, end to end through
 * the REAL fetch -> `parseError` -> `ApiError` path. Every surface test mocks
 * the API module and hands the UI a hand-built `ApiError`; none of them
 * checked that the backend's actual wire shape produces that `ApiError`.
 *
 * The bodies below were captured from a live backend
 * (`uvicorn api.main:app`, disposable Postgres, demo seed) during the gate on
 * 2026-10-10. They are the `CodedHTTPException` envelope
 * `{"detail": <str | list | object>, "code": "<CODE>"}` (backend
 * `api/errors.py`). The P12 contract header's `{detail: {code, message}}` was
 * wrong, and the code is top-level.
 */

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function stubFetchOnce(body: unknown, status: number, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(body, status, headers)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('priority move 409 HARD_GATE_FORCES_P1 (P11 contract §1)', () => {
  it('the live body yields ApiError.code === HARD_GATE_FORCES_P1 and the hard-gate copy', async () => {
    // Captured: POST /projects/{id}/priority {"priority":"P2"} on a hard-gated project.
    stubFetchOnce(
      {
        detail: 'This project has hard gates (Active safety non-compliance), so its priority is pinned to P1.',
        code: 'HARD_GATE_FORCES_P1',
      },
      409,
    );
    const err = await moveProjectPriority('11111111-1111-1111-1111-111111111111', 'P2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    // `use-priority-move-flow.tsx` branches on exactly this comparison.
    expect((err as ApiError).code).toBe(HARD_GATE_FORCES_P1);
    expect(apiErrorMessage(err, 'fallback')).toBe(API_ERROR_MESSAGES.HARD_GATE_FORCES_P1);
  });
});

describe('step timing errors (P12 contract §3)', () => {
  // PROJECT_FROZEN and NOT_SCHEDULABLE were captured live. STEP_SKIPPED,
  // STEP_DONE and STEP_STARTED use the same envelope with the detail text
  // from `backend/services/step_timing.py`.
  const conflicts: [string, string][] = [
    ['PROJECT_FROZEN', 'The project is frozen. Unfreeze it on the Gantt to change timing.'],
    ['NOT_SCHEDULABLE', "The project's status is not scheduled, so its step timing cannot be changed."],
    ['STEP_SKIPPED', 'This step is skipped for the project (0 weeks) and has no timing.'],
    ['STEP_DONE', 'A Done step is history; its timing cannot change.'],
    ['STEP_STARTED', 'The step has started, so its start is fixed. Only its duration can change.'],
  ];

  it.each(conflicts)('409 %s through the wire maps to its "Nothing was saved." copy', async (code, detail) => {
    stubFetchOnce({ detail, code }, 409);
    const err = await setStepTiming('p-1', 'PDD-E', { duration_override_weeks: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    const copy = timingErrorCopy(err);
    expect(copy).toBe(TIMING_ERROR_COPY[code]);
    expect(copy).toMatch(/Nothing was saved\.$/);
  });

  it('422 VALIDATION_ERROR (a coded field-error list) is flattened into readable text', async () => {
    // Captured: PATCH …/timing {"duration_override_weeks":500}.
    stubFetchOnce(
      {
        detail: [
          {
            loc: ['body', 'duration_override_weeks'],
            msg: 'duration_override_weeks must be between 1 and 104.',
            type: 'value_error',
          },
        ],
        code: 'VALIDATION_ERROR',
      },
      422,
    );
    const err = await setStepTiming('p-1', 'PDD-E', { duration_override_weeks: 500 }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect(timingErrorCopy(err)).toBe('duration_override_weeks: duration_override_weeks must be between 1 and 104.');
  });
});

describe('POST /check-ins 422 CHECKIN_INVALID (P12 contract §5)', () => {
  it('the live body is parsed into per-entry {index, code, message}, including DUPLICATE_STAGE', async () => {
    // Captured as an Engineer (carol.eng), a 4-entry batch: a frozen
    // project's stage, the same stage again, another engineer's stage, and a
    // Done entry carrying a hold reason.
    const live = {
      detail: {
        code: 'CHECKIN_INVALID',
        message: 'The check-in was not saved: fix the stages listed in errors.',
        errors: [
          { index: 0, code: 'PROJECT_FROZEN', message: 'This project is frozen. Unfreeze on the Gantt to record stage progress.' },
          { index: 1, code: 'DUPLICATE_STAGE', message: 'This stage appears more than once in the batch.' },
          { index: 2, code: 'FORBIDDEN_STAGE', message: 'You cannot check in this stage.' },
          { index: 3, code: 'INCONSISTENT_PROGRESS', message: 'blocked_reason must be null unless status is On Hold' },
        ],
      },
      code: 'CHECKIN_INVALID',
    };
    stubFetchOnce(live, 422);
    const err = await submitCheckIns([
      { project_id: 'p-1', step_id: 'PDD-H', status: 'In Progress', percent_complete: 10, blocked_reason: null, note: null },
    ]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe(CHECKIN_INVALID);
    expect(checkInEntryErrors(err)).toEqual(live.detail.errors);
    expect(checkInEntryErrors(err).map((e) => e.code)).toContain('DUPLICATE_STAGE');
  });

  it('a non-CHECKIN_INVALID error (e.g. 429 RATE_LIMITED) yields no per-entry errors', async () => {
    stubFetchOnce(
      { detail: 'Too many check-in submissions. Please wait a moment and try again.', code: 'RATE_LIMITED' },
      429,
      { 'Retry-After': '6' },
    );
    const err = await submitCheckIns([
      { project_id: 'p-1', step_id: 'PDD-H', status: 'In Progress', percent_complete: 10, blocked_reason: null, note: null },
    ]).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('RATE_LIMITED');
    expect((err as ApiError).retryAfterSeconds).toBe(6);
    expect(checkInEntryErrors(err)).toEqual([]);
  });
});
