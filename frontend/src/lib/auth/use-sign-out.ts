import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { setDevUserEmail } from '@/lib/api/dev-user';
import { useSessionStore } from '@/stores/session';

import type { LoginLocationState } from './leave-guard';
import { broadcastSignedOut } from './session-channel';

/** Every per-tab key this app writes to `sessionStorage` starts with this. */
export const APP_SESSION_STORAGE_PREFIX = 'rpd-';

/**
 * Window event dispatched on sign-out, after `sessionStorage` is cleared.
 * A persisted in-memory store (e.g. the Matrix compare selection) listens for
 * it to reset its own state; this module never imports those stores.
 */
export const SIGNED_OUT_EVENT = 'rpd:signed-out';

export type { LoginLocationState } from './leave-guard';

export interface SignOutOptions {
  /** ADR 0060 L2: the login page shows the inactivity notice. */
  reason?: 'idle';
  /** ADR 0060 L1: tell the other tabs (default). `false` when this sign-out came from another tab. */
  broadcast?: boolean;
}

/**
 * P21-R01 (security S21-L2): remove every `rpd-` key from `sessionStorage`
 * (e.g. `rpd-matrix-compare`, which holds project names and hubs), so the
 * next user in the same tab never sees them. Keys are collected first and then
 * removed, since removing while indexing shifts the indices. Guarded: storage
 * may be unavailable (privacy mode), and sign-out must still complete.
 */
export function clearAppSessionStorage(): void {
  try {
    const storage = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(APP_SESSION_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // storage unavailable — nothing persisted to clear
  }
}

/**
 * Sign out: forget the dev-mode user choice, drop every cached query (so the
 * next user never sees the previous user's hub-scoped data), clear the app's
 * per-tab `sessionStorage` keys, tell the other tabs (ADR 0060 L1), tell
 * in-memory stores to reset, and return to the login page. Under OIDC there is
 * no server session to end yet — this clears the client side only. It never
 * saves anything or starts a run.
 */
export function useSignOut(): (options?: SignOutOptions) => void {
  const queryClient = useQueryClient();
  const reset = useSessionStore((s) => s.reset);
  const navigate = useNavigate();
  return React.useCallback(
    (options: SignOutOptions = {}) => {
      setDevUserEmail(null);
      queryClient.clear();
      reset();
      clearAppSessionStorage();
      if (options.broadcast !== false) broadcastSignedOut();
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
      // P49-R01 (A2): an idle or remote sign-out is forced, so the leave guards let it through
      // (`shouldBlockLeave`) and the login page shows the notice for an idle one.
      const state: LoginLocationState | undefined =
        options.reason === 'idle' ? { signedOut: 'idle' } : options.broadcast === false ? { signedOut: 'remote' } : undefined;
      navigate('/login', { replace: true, state });
    },
    [queryClient, reset, navigate],
  );
}
