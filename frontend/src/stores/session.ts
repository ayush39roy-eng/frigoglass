import { create } from 'zustand';

import { ApiError } from '@/lib/api/client';
import { fetchMe, type MeResponse, type SurfacePermission } from '@/lib/api/session';
import type { SurfaceKey } from '@/types/enums';

/**
 * The signed-in principal (ADR 0010 §2). Populated ONCE on boot from `GET /me`
 * by `<SessionGate>` and re-read after a dev-mode user switch. Server state that
 * lives here, not in TanStack Query, on purpose: every surface, the sidebar
 * and every route guard read it synchronously on every render, and a
 * permission table that could be `undefined` mid-refetch would flicker every
 * write control on the screen.
 *
 * The permissions here are a CONVENIENCE for the UI. The server enforces the
 * matrix on every request (`docs/PROJECT_AND_STACK.md` §5); a stale or
 * tampered table only changes what the browser draws, never what it can do.
 */

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SessionErrorKind = 'unauthorized' | 'network' | 'other';

export interface SessionState {
  status: SessionStatus;
  me: MeResponse | null;
  errorKind: SessionErrorKind | null;
  /** Fetch `/me`. Safe to call repeatedly; concurrent calls share one flight. */
  load: () => Promise<void>;
  /** Test/bootstrap seam: install a session without a network call. */
  seed: (me: MeResponse) => void;
  reset: () => void;
}

const NO_ACCESS: SurfacePermission = { read: false, write: false };

let inflight: Promise<void> | null = null;

export const useSessionStore = create<SessionState>()((set) => ({
  status: 'idle',
  me: null,
  errorKind: null,

  load: () => {
    if (inflight) return inflight;
    set({ status: 'loading', errorKind: null });
    inflight = fetchMe()
      .then((me) => {
        set({ status: 'ready', me, errorKind: null });
      })
      .catch((err: unknown) => {
        const kind: SessionErrorKind =
          err instanceof ApiError
            ? err.isUnauthorized
              ? 'unauthorized'
              : err.status === 0
                ? 'network'
                : 'other'
            : 'other';
        set({ status: 'error', me: null, errorKind: kind });
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },

  seed: (me) => set({ status: 'ready', me, errorKind: null }),

  reset: () => {
    inflight = null;
    set({ status: 'idle', me: null, errorKind: null });
  },
}));

/** Pure lookup — a missing key is "no access", never a crash on an older payload. */
export function permissionFor(me: MeResponse | null, surface: SurfaceKey): SurfacePermission {
  if (!me) return NO_ACCESS;
  const cell = me.permissions[surface] as SurfacePermission | undefined;
  return cell ?? NO_ACCESS;
}

/** `{read, write}` for one surface, re-rendering only when that cell changes. */
export function usePermission(surface: SurfaceKey): SurfacePermission {
  const me = useSessionStore((s) => s.me);
  return permissionFor(me, surface);
}

export function useSession(): Pick<SessionState, 'status' | 'me' | 'errorKind'> {
  const status = useSessionStore((s) => s.status);
  const me = useSessionStore((s) => s.me);
  const errorKind = useSessionStore((s) => s.errorKind);
  return { status, me, errorKind };
}
