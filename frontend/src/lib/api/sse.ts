/**
 * `fetch()`-streamed Server-Sent Events reader for solver progress
 * (`GET /schedule-runs/{id}/progress`, P3-T05).
 *
 * Binding P3-T05 consequence: the endpoint authenticates via request headers
 * (and the dev `X-Dev-User-Email` header), which a bare `EventSource` cannot
 * send — so this reads the response body stream with `fetch()` and parses the
 * plain `data: <json>\n\n` framing itself. `:`-prefixed heartbeat comments are
 * ignored. The stream closes on a terminal `status` (`completed` / `failed` /
 * `cancelled`) or when the caller aborts.
 */

import { apiUrl, devUserHeader, parseApiError, ApiError } from './client';

export interface SolverProgressEvent {
  schedule_run_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
  timestamp?: string;
  percent?: number;
  message?: string;
  error?: string;
}

export const TERMINAL_PROGRESS_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Parse every complete SSE frame in `buffer`; returns the parsed payloads and
 *  the unconsumed remainder. Exported for tests. */
export function parseSseFrames(buffer: string): { events: SolverProgressEvent[]; rest: string } {
  const events: SolverProgressEvent[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  const rest = frames.pop() ?? '';
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue; // heartbeat comment or empty frame
    try {
      events.push(JSON.parse(data) as SolverProgressEvent);
    } catch {
      // malformed frame — skip it rather than tearing down the stream
    }
  }
  return { events, rest };
}

/**
 * Stream progress events for a schedule run. Resolves with the terminal event
 * (or the last one seen if the server closed early); rejects with `ApiError`
 * on a non-2xx response, and with the abort error if `signal` aborts.
 */
export async function streamSolverProgress(
  scheduleRunId: string,
  onEvent: (event: SolverProgressEvent) => void,
  signal?: AbortSignal,
): Promise<SolverProgressEvent | null> {
  let response: Response;
  try {
    response = await fetch(apiUrl(`/schedule-runs/${scheduleRunId}/progress`), {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...devUserHeader() },
      credentials: 'include',
      signal: signal ?? null,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'Network request failed — the API is unreachable.');
  }
  if (!response.ok) throw await parseApiError(response);
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last: SolverProgressEvent | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseFrames(buffer);
      buffer = rest;
      for (const event of events) {
        last = event;
        onEvent(event);
        if (TERMINAL_PROGRESS_STATUSES.has(event.status)) {
          await reader.cancel();
          return event;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return last;
}
