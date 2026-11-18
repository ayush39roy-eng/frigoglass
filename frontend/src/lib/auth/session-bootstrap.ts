/**
 * ADR 0060 L1 (P49): what runs once at startup, before the first render.
 *
 * 1. Delete the pre-P49 "Remember me" login from `localStorage`.
 * 2. With no session in this tab, ask an open tab for its session (BroadcastChannel
 *    handshake). No answer → the session gate sends the user to the login page.
 * 3. Join the channel: answer other tabs' requests, and sign this tab out when
 *    another tab signs out.
 */

import { getDevUserEmail, purgeLegacyDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';

import { REMOTE_SIGNED_OUT_EVENT, requestSessionFromOpenTab, startSessionChannel } from './session-channel';

/** This tab's user is cleared at once; the app shell (if mounted) runs the full sign-out path on the event. */
export function handleRemoteSignOut(): void {
  setDevUserEmail(null);
  window.dispatchEvent(new Event(REMOTE_SIGNED_OUT_EVENT));
}

export async function bootstrapSession(): Promise<() => void> {
  purgeLegacyDevUserEmail();
  if (getDevUserEmail() === null) {
    const email = await requestSessionFromOpenTab();
    // A sign-in in this tab during the wait wins.
    if (email !== null && getDevUserEmail() === null) setDevUserEmail(email);
  }
  return startSessionChannel({ onRemoteSignOut: handleRemoteSignOut });
}
