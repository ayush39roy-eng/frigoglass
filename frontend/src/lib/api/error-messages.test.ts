import { describe, expect, it } from 'vitest';

import { ApiError, parseApiError } from './client';
import { apiErrorMessage, flattenDetail } from './error-messages';

describe('apiErrorMessage — codes, not detail text', () => {
  it('maps every P9-T03 code to readable copy', () => {
    for (const code of ['BAD_STEP_SET', 'KIND_IN_USE', 'STAGE_INCONSISTENT', 'STAGE_SKIPPED', 'WORKFLOW_CHANGE_WITH_PROGRESS', 'NOT_AUTHOR', 'EDIT_LOCKED', 'RUN_IN_PROGRESS']) {
      const msg = apiErrorMessage(new ApiError(422, 'x', 'raw server text', code), 'fallback');
      expect(msg).not.toBe('fallback');
      // STAGE_INCONSISTENT deliberately appends the server's field errors.
      if (code !== 'STAGE_INCONSISTENT') expect(msg).not.toContain('raw server text');
    }
    expect(apiErrorMessage(new ApiError(409, 'x', undefined, 'RUN_IN_PROGRESS'), 'f')).toMatch(/already running/);
  });
  it('appends field errors for STAGE_INCONSISTENT', () => {
    const detail = JSON.stringify([{ loc: ['body', 'actual_end_week'], msg: 'required when Done', type: 'value_error' }]);
    expect(apiErrorMessage(new ApiError(422, 'x', detail, 'STAGE_INCONSISTENT'), 'f')).toBe(
      'These progress values contradict each other. actual_end_week: required when Done',
    );
  });
  it('falls back to detail, then fallback; non-ApiError uses fallback', () => {
    expect(apiErrorMessage(new ApiError(500, 'x', 'boom'), 'f')).toBe('boom');
    expect(apiErrorMessage(new ApiError(500, 'x'), 'f')).toBe('f');
    expect(apiErrorMessage(new Error('x'), 'f')).toBe('f');
    expect(flattenDetail('plain')).toBe('plain');
  });
});

describe('P9-R02 codes (P9-R03)', () => {
  it('PROJECT_FROZEN carries the ruling-3 instruction', () => {
    expect(apiErrorMessage(new ApiError(409, 'x', 'frozen', 'PROJECT_FROZEN'), 'f')).toBe(
      'This project is frozen. Unfreeze on the Gantt to record stage progress.',
    );
  });

  it('429 reads "Try again in N s" from Retry-After, and degrades without it', () => {
    expect(apiErrorMessage(new ApiError(429, 'x', 'slow', 'RATE_LIMITED', 7), 'f')).toBe(
      "You're commenting too fast. Try again in 7 s.",
    );
    expect(apiErrorMessage(new ApiError(429, 'x', 'slow', 'RATE_LIMITED'), 'f')).toBe(
      "You're commenting too fast. Try again in a minute.",
    );
    // A 429 from a proxy with no code still gets friendly copy.
    expect(apiErrorMessage(new ApiError(429, 'x'), 'f')).toBe("You're commenting too fast. Try again in a minute.");
  });

  it('parseApiError reads a delta-seconds Retry-After and ignores an HTTP-date', async () => {
    const body = JSON.stringify({ detail: 'slow', code: 'RATE_LIMITED' });
    const seconds = await parseApiError(new Response(body, { status: 429, headers: { 'Retry-After': '12' } }));
    expect(seconds.retryAfterSeconds).toBe(12);
    expect(seconds.code).toBe('RATE_LIMITED');
    const dated = await parseApiError(
      new Response(body, { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } }),
    );
    expect(dated.retryAfterSeconds).toBeUndefined();
  });
});
