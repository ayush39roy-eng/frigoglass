/**
 * Error copy for "Ask the agent" (ADR 0014). Kept separate from
 * `lib/api/error-messages.ts`'s generic `apiErrorMessage` because the two
 * statuses that matter most here need copy that generic helper cannot
 * produce: the 503 body is `{"error": "AGENT_UNAVAILABLE"}`, not the usual
 * `{"detail","code"}` envelope (so there is no `code` to look up), and the
 * 429 here is a distinct per-user Groq-call budget (`ASK_AGENT_RATE_LIMIT`,
 * 5 per minute) — reusing the comment limiter's literal "You're commenting
 * too fast" copy would be wrong, even though the *pattern* (Retry-After-aware
 * "try again in N s") is the same one `rateLimitedMessage` already uses.
 */

import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';

export const AGENT_UNAVAILABLE_MESSAGE = "Ask the agent isn't configured for this environment.";
export const ASK_AGENT_FORBIDDEN_MESSAGE = "You don't have access to ask about this project.";

export function askAgentRateLimitMessage(retryAfterSeconds: number | undefined): string {
  return retryAfterSeconds === undefined
    ? 'Too many questions. Please wait a moment before asking again.'
    : `Too many questions. Try again in ${String(Math.max(1, retryAfterSeconds))} s.`;
}

export function askAgentErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503) return AGENT_UNAVAILABLE_MESSAGE;
    if (err.status === 429) return askAgentRateLimitMessage(err.retryAfterSeconds);
    if (err.isForbidden) return ASK_AGENT_FORBIDDEN_MESSAGE;
  }
  return apiErrorMessage(err, 'The agent could not answer that. Please try again.');
}
