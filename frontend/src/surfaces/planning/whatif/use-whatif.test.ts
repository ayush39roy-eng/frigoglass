import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/client';

import { classifyWhatIfError, scenarioLimitMessage } from './use-whatif';

describe('classifyWhatIfError', () => {
  it.each([
    [new ApiError(403, 'x', 'no', 'SCENARIO_OUT_OF_SCOPE'), 'scenario', 'out_of_scope'],
    [new ApiError(403, 'x'), 'scenario', 'forbidden'],
    [new ApiError(401, 'x'), 'scenario', 'unauthorized'],
    [new ApiError(422, 'x', 'unknown chamber id', 'INVALID_SCENARIO'), 'scenario', 'invalid'],
    [new ApiError(422, 'x', '[{"loc":[]}]'), 'scenario', 'invalid'],
    [new ApiError(429, 'x', undefined, undefined, 7), 'scenario', 'rate_limited'],
    [new ApiError(503, 'x', 'late', 'WHATIF_TIMEOUT'), 'scenario', 'timeout'],
    [new ApiError(503, 'x'), 'ask', 'agent_unavailable'],
    [new ApiError(503, 'x', 'late', 'WHATIF_TIMEOUT'), 'ask', 'timeout'],
    [new ApiError(502, 'x'), 'ask', 'upstream'],
    [new ApiError(504, 'x', undefined, 'AGENT_TIMEOUT'), 'ask', 'agent_timeout'],
    [new ApiError(0, 'x'), 'ask', 'network'],
    [new Error('boom'), 'ask', 'other'],
  ] as const)('%#', (error, endpoint, kind) => {
    expect(classifyWhatIfError(error, endpoint).kind).toBe(kind);
  });

  it('carries the Retry-After seconds and never retries a scope or validation error', () => {
    const limited = classifyWhatIfError(new ApiError(429, 'x', undefined, undefined, 7), 'ask');
    expect(limited.retryAfterSeconds).toBe(7);
    expect(limited.message).toContain('7 s');
    expect(classifyWhatIfError(new ApiError(403, 'x', undefined, 'SCENARIO_OUT_OF_SCOPE'), 'scenario').retryable).toBe(false);
    expect(classifyWhatIfError(new ApiError(422, 'x', 'bad', 'INVALID_SCENARIO'), 'scenario').message).toContain('bad');
  });

  it('says the chat is not configured for an ask 503', () => {
    expect(classifyWhatIfError(new ApiError(503, 'x'), 'ask').message).toBe('Chat is not configured; use the forms.');
  });

  it('turns a 422 INVALID_SCENARIO total-over-cap list body into a readable sentence', () => {
    const detail = JSON.stringify([
      {
        loc: ['body', 'scenario'],
        type: 'scenario_limit',
        msg: 'at most 200 projects can be added in one scenario (got 201)',
      },
    ]);
    const info = classifyWhatIfError(new ApiError(422, 'x', detail, 'INVALID_SCENARIO'), 'scenario');
    expect(info.kind).toBe('invalid');
    expect(info.message).toBe(
      'The planner could not use this scenario: at most 200 projects can be added in one scenario (got 201).',
    );
    expect(info.message).not.toContain('loc');
    expect(scenarioLimitMessage(undefined)).toContain('over a limit');
  });

  it('words the in-flight 429 (plain detail, Retry-After 2) and the capped 503', () => {
    const busy = classifyWhatIfError(
      new ApiError(
        429,
        'x',
        'A what-if calculation of yours is still running. Please wait for it to finish before starting another.',
        undefined,
        2,
      ),
      'scenario',
    );
    expect(busy.kind).toBe('rate_limited');
    expect(busy.retryAfterSeconds).toBe(2);
    expect(busy.message).toContain('still running');
    expect(busy.message).toContain('2 s');
    expect(classifyWhatIfError(new ApiError(503, 'x', 'slow', 'WHATIF_TIMEOUT'), 'scenario').message).toBe(
      'This took too long; try a smaller scenario.',
    );
  });
});
