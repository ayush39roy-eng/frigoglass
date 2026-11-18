/**
 * ADR 0060 L1 (P49): the cross-tab session channel.
 *
 * The signed-in user is kept in `sessionStorage` only (per tab), so a new tab
 * starts with no session. On startup it asks the other open tabs of the app
 * ("session-request"); the first signed-in tab answers ("session-offer") with
 * its user email, and the new tab adopts it. With no other tab open, nobody
 * answers within `HANDSHAKE_TIMEOUT_MS` and the new tab shows the login page.
 * Closing every tab therefore ends the session.
 *
 * Sign-out in one tab is broadcast ("signed-out") and signs out every tab.
 *
 * Every received message is validated: it must come from this origin on this
 * channel, have exactly the expected shape, and carry nothing but the request
 * id and, on an offer, the user email (the dev-mode identity, not a
 * credential). Anything else is ignored.
 */

import { getDevUserEmail } from '@/lib/api/dev-user';

import { isSharedSessionIdle } from './idle';

export const SESSION_CHANNEL_NAME = 'rpd-session';

/** How long a new tab waits for an open tab to answer. */
export const HANDSHAKE_TIMEOUT_MS = 300;

/** Window event dispatched when another tab signed out (this tab's user is already cleared). */
export const REMOTE_SIGNED_OUT_EVENT = 'rpd:remote-signed-out';

export type SessionMessage =
  | { type: 'session-request'; id: string }
  | { type: 'session-offer'; id: string; email: string }
  | { type: 'signed-out' };

const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,189}$/;

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/** Parse one received message; `null` for anything that is not exactly a session message. */
export function parseSessionMessage(data: unknown): SessionMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  if (Object.getPrototypeOf(data) !== Object.prototype) return null;
  const record = data as Record<string, unknown>;
  switch (record.type) {
    case 'session-request':
      if (!hasExactKeys(record, ['type', 'id'])) return null;
      if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) return null;
      return { type: 'session-request', id: record.id };
    case 'session-offer':
      if (!hasExactKeys(record, ['type', 'id', 'email'])) return null;
      if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) return null;
      if (typeof record.email !== 'string' || !EMAIL_PATTERN.test(record.email)) return null;
      return { type: 'session-offer', id: record.id, email: record.email };
    case 'signed-out':
      if (!hasExactKeys(record, ['type'])) return null;
      return { type: 'signed-out' };
    default:
      return null;
  }
}

/** Same origin and the expected channel. (BroadcastChannel is same-origin already; this is belt and braces.) */
function isFromThisApp(event: MessageEvent, channel: BroadcastChannel): boolean {
  if (channel.name !== SESSION_CHANNEL_NAME) return false;
  return event.origin === '' || event.origin === window.location.origin;
}

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SESSION_CHANNEL_NAME);
  } catch {
    return null;
  }
}

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/**
 * Ask the open tabs for their session. Resolves with the first valid offer's
 * email, or `null` after `timeoutMs` (no other tab, or no browser support).
 */
export function requestSessionFromOpenTab(timeoutMs: number = HANDSHAKE_TIMEOUT_MS): Promise<string | null> {
  const channel = openChannel();
  if (channel === null) return Promise.resolve(null);
  const id = newRequestId();
  return new Promise((resolve) => {
    let done = false;
    const finish = (email: string | null): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      channel.close();
      resolve(email);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    channel.onmessage = (event: MessageEvent) => {
      if (!isFromThisApp(event, channel)) return;
      const message = parseSessionMessage(event.data);
      if (message?.type === 'session-offer' && message.id === id) finish(message.email);
    };
    try {
      channel.postMessage({ type: 'session-request', id } satisfies SessionMessage);
    } catch {
      finish(null);
    }
  });
}

let liveChannel: BroadcastChannel | null = null;

/**
 * Keep this tab on the channel: answer session requests while this tab is
 * signed in (and the shared session is not idle), and call
 * `onRemoteSignOut` when another tab signs out. Returns a stop function.
 */
export function startSessionChannel(handlers: { onRemoteSignOut: () => void }): () => void {
  const channel = openChannel();
  if (channel === null) return () => undefined;
  liveChannel?.close();
  liveChannel = channel;
  channel.onmessage = (event: MessageEvent) => {
    if (!isFromThisApp(event, channel)) return;
    const message = parseSessionMessage(event.data);
    if (message === null) return;
    if (message.type === 'session-request') {
      const email = getDevUserEmail();
      if (email === null || !EMAIL_PATTERN.test(email) || isSharedSessionIdle()) return;
      channel.postMessage({ type: 'session-offer', id: message.id, email } satisfies SessionMessage);
    } else if (message.type === 'signed-out') {
      handlers.onRemoteSignOut();
    }
  };
  return () => {
    channel.close();
    if (liveChannel === channel) liveChannel = null;
  };
}

/** Tell every other tab that this tab signed out. */
export function broadcastSignedOut(): void {
  const message: SessionMessage = { type: 'signed-out' };
  try {
    if (liveChannel !== null) {
      liveChannel.postMessage(message);
      return;
    }
    const channel = openChannel();
    if (channel === null) return;
    channel.postMessage(message);
    channel.close();
  } catch {
    // channel closed or unsupported — the other tabs still time out on their own
  }
}
