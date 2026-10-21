import * as React from 'react';
import { useMutation } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';

import { postAsk, postEstimate, postSimulate, postSolve } from '../api/whatif-api';
import type {
  AskRequest,
  EstimateRequest,
  SimulateRequest,
  SolveRequest,
} from '../api/whatif-types';

/** Scenario runs are pure reads on a POST: never retried automatically (a 429
 *  would only be made worse, and a timeout should be the user's call). */
export function useEstimate() {
  return useMutation({ mutationFn: (body: EstimateRequest) => postEstimate(body), retry: false });
}
export function useSimulate() {
  return useMutation({ mutationFn: (body: SimulateRequest) => postSimulate(body), retry: false });
}
export function useSolve() {
  return useMutation({ mutationFn: (body: SolveRequest) => postSolve(body), retry: false });
}
export function useAsk() {
  return useMutation({ mutationFn: (body: AskRequest) => postAsk(body), retry: false });
}

// --- error classification -------------------------------------------------------------

export type WhatIfErrorKind =
  | 'out_of_scope'
  | 'forbidden'
  | 'unauthorized'
  | 'invalid'
  | 'rate_limited'
  | 'timeout'
  | 'agent_unavailable'
  | 'upstream'
  | 'agent_timeout'
  | 'network'
  | 'other';

export interface WhatIfErrorInfo {
  kind: WhatIfErrorKind;
  message: string;
  retryAfterSeconds?: number;
  /** A retry may help (the same request is worth sending again). */
  retryable: boolean;
}

/** The readable part of a 422 `INVALID_SCENARIO` body. The client keeps a list detail as a
 *  JSON string, `[{"loc":…,"type":"scenario_limit","msg":"at most 200 projects can be added in
 *  one scenario (got 201)"}]`; show the `msg` text(s). A plain string detail is shown as is. */
export function scenarioLimitMessage(detail: string | undefined): string {
  const fallback = 'one of the numbers is over a limit. Reduce the counts and try again.';
  if (!detail) return fallback;
  let msgs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(detail);
    if (Array.isArray(parsed)) {
      msgs = parsed
        .map((e: unknown) => (e && typeof e === 'object' && 'msg' in e ? (e as { msg: unknown }).msg : null))
        .filter((m): m is string => typeof m === 'string' && m.length > 0);
    } else if (typeof parsed === 'string') {
      msgs = [parsed];
    }
  } catch {
    msgs = [detail];
  }
  if (msgs.length === 0) return fallback;
  const text = msgs.join('; ');
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Map an API failure of the four what-if endpoints to plain copy. The ask
 *  endpoint's 503 body is `{"error": "AGENT_UNAVAILABLE"}` (no `code`), so for
 *  `ask` any 503 that is not a `WHATIF_TIMEOUT` is "chat not configured". */
export function classifyWhatIfError(error: unknown, endpoint: 'scenario' | 'ask'): WhatIfErrorInfo {
  if (!(error instanceof ApiError)) {
    return { kind: 'other', message: 'Something went wrong. Please try again.', retryable: true };
  }
  const { status, code } = error;
  if (status === 0) {
    return { kind: 'network', message: 'The API is unreachable. Check your connection and try again.', retryable: true };
  }
  if (status === 401) {
    return { kind: 'unauthorized', message: 'Your session has expired. Sign in again to continue.', retryable: false };
  }
  if (status === 403) {
    return code === 'SCENARIO_OUT_OF_SCOPE'
      ? {
          kind: 'out_of_scope',
          message:
            'This scenario names a hub or lab region outside the hubs you plan for. Remove that line, or change it to one of your own hubs.',
          retryable: false,
        }
      : { kind: 'forbidden', message: 'Your role cannot use the What-if planner.', retryable: false };
  }
  if (status === 422) {
    return code === 'INVALID_SCENARIO'
      ? {
          kind: 'invalid',
          message: `The planner could not use this scenario: ${scenarioLimitMessage(error.detail)}`,
          retryable: false,
        }
      : {
          kind: 'invalid',
          message: 'The server did not accept these values. Check the form for out-of-range numbers and try again.',
          retryable: false,
        };
  }
  if (status === 429) {
    const secs = error.retryAfterSeconds;
    // The in-flight limit (P18-R02, one heavy job per user) answers with a plain detail string.
    const stillRunning = /still running/i.test(error.detail ?? '');
    const lead = stillRunning
      ? 'Your previous what-if calculation is still running.'
      : 'Too many requests in a short time.';
    return {
      kind: 'rate_limited',
      message:
        secs === undefined
          ? `${lead} Wait a moment, then try again.`
          : `${lead} You can try again in ${String(Math.max(1, secs))} s.`,
      ...(secs !== undefined ? { retryAfterSeconds: Math.max(1, secs) } : {}),
      retryable: true,
    };
  }
  if (status === 503) {
    if (code === 'WHATIF_TIMEOUT') {
      return {
        kind: 'timeout',
        message: 'This took too long; try a smaller scenario.',
        retryable: true,
      };
    }
    if (endpoint === 'ask') {
      return { kind: 'agent_unavailable', message: 'Chat is not configured; use the forms.', retryable: false };
    }
    return { kind: 'other', message: 'The planner is temporarily unavailable. Please try again.', retryable: true };
  }
  if (status === 502) {
    return {
      kind: 'upstream',
      message: 'The assistant could not reach its model provider. Try again in a moment.',
      retryable: true,
    };
  }
  if (status === 504) {
    return {
      kind: 'agent_timeout',
      message: 'The assistant took too long to answer. Try again, or ask a shorter question.',
      retryable: true,
    };
  }
  return { kind: 'other', message: 'Something went wrong. Please try again.', retryable: true };
}

// --- Retry-After countdown ---------------------------------------------------------------

/**
 * Seconds left until a rate-limited request may be retried. Restarts from
 * `seconds` whenever `token` changes (a new 429); `null` seconds = no countdown.
 */
export function useRetryCountdown(seconds: number | null, token: unknown): number {
  const initial = seconds ?? 0;
  const [state, setState] = React.useState({ seconds, token, left: initial });
  // A new 429 (new token or seconds) restarts the count; done in render, not in an effect.
  let left = state.left;
  if (state.seconds !== seconds || state.token !== token) {
    left = initial;
    setState({ seconds, token, left: initial });
  }
  const counting = left > 0;
  React.useEffect(() => {
    if (!counting) return;
    const id = window.setInterval(() => {
      setState((s) => (s.left <= 1 ? { ...s, left: 0 } : { ...s, left: s.left - 1 }));
    }, 1000);
    return () => window.clearInterval(id);
  }, [counting, seconds, token]);
  return left;
}
