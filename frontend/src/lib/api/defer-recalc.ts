import { isDeferringRecalc } from '@/stores/recalc-mode';

import type { QueryParamValue } from './client';

/**
 * P61 (ADR 0069): the plan writes that accept `defer_recalc`. With the
 * "Auto-recalculate" switch Off, `apiSendWithHeaders` adds `defer_recalc: true`
 * to the JSON body of these requests (a body field only; the backend has no
 * query param). Any other write is sent untouched: the backend bodies are
 * `extra="forbid"`, so the flag must never reach an endpoint that lacks it.
 *
 *   POST  /projects/register-edits          register batch, board bulk move
 *   PATCH /projects/{id}                    registration form / Workspace details
 *   POST  /projects/{id}/priority[/preview] priority move (+ preview)
 *   POST  /projects/{id}/band-rank[/preview] band-rank move (+ preview)
 *   PATCH /projects/{id}/stages/{step}      Workspace step edits
 *   PUT   /projects/{id}/vip                VIP pin
 *   PUT   /gantt/step-pins                  Gantt step weeks
 *   POST  /check-ins                        weekly check-in
 *   POST  /workflow-templates/apply         category timeline apply
 */
const DEFERRABLE: readonly { method: string; pattern: RegExp }[] = [
  { method: 'POST', pattern: /^\/projects\/register-edits$/ },
  { method: 'PATCH', pattern: /^\/projects\/(?!register-edits$)[^/]+$/ },
  { method: 'POST', pattern: /^\/projects\/[^/]+\/(?:priority|band-rank)(?:\/preview)?$/ },
  { method: 'PATCH', pattern: /^\/projects\/[^/]+\/stages\/[^/]+$/ },
  { method: 'PUT', pattern: /^\/projects\/[^/]+\/vip$/ },
  { method: 'PUT', pattern: /^\/gantt\/step-pins$/ },
  { method: 'POST', pattern: /^\/check-ins$/ },
  { method: 'POST', pattern: /^\/workflow-templates\/apply$/ },
];

function normalise(path: string): string {
  const bare = path.split('?')[0] ?? path;
  return bare.startsWith('/') ? bare : `/${bare}`;
}

export function isDeferrableWrite(method: string, path: string): boolean {
  const p = normalise(path);
  return DEFERRABLE.some((d) => d.method === method && d.pattern.test(p));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adds the flag when the switch is Off and the endpoint accepts it. */
export function withDeferRecalc(
  method: string,
  path: string,
  body: unknown,
  query: Record<string, QueryParamValue> | undefined,
): { body: unknown; query: Record<string, QueryParamValue> | undefined } {
  if (!isDeferringRecalc() || !isDeferrableWrite(method, path)) return { body, query };
  if (isPlainObject(body)) return { body: { ...body, defer_recalc: true }, query };
  return { body, query };
}

// ---------------------------------------------------------------------------
// Plan-write listeners: the freshness banner refetches after any plan save.
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribePlanWrites(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyPlanWrite(method: string, path: string): void {
  // A preview writes nothing.
  if (!isDeferrableWrite(method, path) || normalise(path).endsWith('/preview')) return;
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A listener never breaks a save.
    }
  }
}
