import * as React from 'react';
import { Clock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ACTIVITY_EVENTS,
  ACTIVITY_WRITE_THROTTLE_MS,
  IDLE_TIMEOUT_MS,
  IDLE_WARNING_BEFORE_MS,
  LAST_ACTIVITY_KEY,
  formatCountdown,
  isSharedSessionIdle,
  readSharedLastActivity,
  writeSharedLastActivity,
} from '@/lib/auth/idle';
import { REMOTE_SIGNED_OUT_EVENT } from '@/lib/auth/session-channel';
import { useSignOut } from '@/lib/auth/use-sign-out';

/** How often the idle check runs. */
export const IDLE_TICK_MS = 1_000;

/** A remote sign-out within this margin of the idle deadline is reported as an idle one. */
const REMOTE_IDLE_SLACK_MS = 5_000;

/**
 * ADR 0060 (P49): mounted inside the signed-in app shell only (never on the
 * login page). Runs the idle logout (L2) and follows a sign-out made in
 * another tab (L1). Both use the existing sign-out path (`useSignOut`), which
 * never saves anything or starts a run.
 */
export function SessionLifecycle(): React.JSX.Element {
  const signOut = useSignOut();

  React.useEffect(() => {
    const onRemote = (): void => {
      const idle = isSharedSessionIdle(Date.now() + REMOTE_IDLE_SLACK_MS);
      signOut(idle ? { broadcast: false, reason: 'idle' } : { broadcast: false });
    };
    window.addEventListener(REMOTE_SIGNED_OUT_EVENT, onRemote);
    return () => window.removeEventListener(REMOTE_SIGNED_OUT_EVENT, onRemote);
  }, [signOut]);

  const onIdle = React.useCallback(() => signOut({ reason: 'idle' }), [signOut]);
  return <IdleLogout onIdle={onIdle} />;
}

/**
 * ADR 0060 L2: activity (pointer, key, wheel, touch, scroll) in any tab resets
 * the clock; the last activity time is shared through `localStorage`. The
 * warning opens `IDLE_WARNING_BEFORE_MS` before `IDLE_TIMEOUT_MS`; while it is
 * open, only "Stay signed in" (or closing it) counts as activity here, while
 * activity in another tab still closes it. At the timeout, `onIdle` runs once.
 */
export function IdleLogout({ onIdle }: { onIdle: () => void }): React.JSX.Element {
  const onIdleRef = React.useRef(onIdle);
  React.useEffect(() => {
    onIdleRef.current = onIdle;
  }, [onIdle]);

  const lastLocal = React.useRef(0);
  const lastWrite = React.useRef(0);
  const trailing = React.useRef<number | null>(null);
  const warningOpen = React.useRef(false);
  const fired = React.useRef(false);
  const [remaining, setRemaining] = React.useState<number | null>(null);

  /** Share `at` unless another tab already shared a later time. */
  const publish = React.useCallback((at: number) => {
    const shared = readSharedLastActivity();
    if (shared === null || at > shared) writeSharedLastActivity(at);
    lastWrite.current = Date.now();
  }, []);

  const evaluate = React.useCallback(() => {
    if (fired.current) return;
    const now = Date.now();
    const last = Math.max(lastLocal.current, readSharedLastActivity() ?? 0);
    const left = last + IDLE_TIMEOUT_MS - now;
    if (left <= 0) {
      fired.current = true;
      warningOpen.current = false;
      setRemaining(null);
      onIdleRef.current();
      return;
    }
    if (left <= IDLE_WARNING_BEFORE_MS) {
      warningOpen.current = true;
      setRemaining(left);
    } else if (warningOpen.current) {
      warningOpen.current = false;
      setRemaining(null);
    }
  }, []);

  React.useEffect(() => {
    const now = Date.now();
    const shared = readSharedLastActivity();
    // A load is not activity (an auto reload must not extend the session), so
    // the shared time is kept; it is only created when missing.
    if (shared === null) {
      writeSharedLastActivity(now);
      lastWrite.current = now;
    }
    lastLocal.current = shared ?? now;

    const onActivity = (): void => {
      if (warningOpen.current || fired.current) return;
      const at = Date.now();
      lastLocal.current = at;
      if (at - lastWrite.current >= ACTIVITY_WRITE_THROTTLE_MS) {
        publish(at);
        return;
      }
      if (trailing.current === null) {
        trailing.current = window.setTimeout(
          () => {
            trailing.current = null;
            if (!fired.current) publish(lastLocal.current);
          },
          lastWrite.current + ACTIVITY_WRITE_THROTTLE_MS - at,
        );
      }
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') evaluate();
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === LAST_ACTIVITY_KEY) evaluate();
    };

    const listenerOptions: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, listenerOptions);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);
    const interval = window.setInterval(evaluate, IDLE_TICK_MS);
    evaluate();

    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, listenerOptions);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
      window.clearInterval(interval);
      if (trailing.current !== null) window.clearTimeout(trailing.current);
      trailing.current = null;
    };
  }, [evaluate, publish]);

  const staySignedIn = React.useCallback(() => {
    if (fired.current) return;
    const now = Date.now();
    lastLocal.current = now;
    publish(now);
    warningOpen.current = false;
    setRemaining(null);
  }, [publish]);

  return (
    <Dialog
      open={remaining !== null}
      onOpenChange={(open) => {
        if (!open) staySignedIn();
      }}
    >
      <DialogContent data-testid="idle-warning" className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-4 text-warning" aria-hidden="true" />
            Are you still there?
          </DialogTitle>
          <DialogDescription>
            You will be signed out in{' '}
            <span className="font-mono font-semibold tabular-nums text-text" data-testid="idle-countdown">
              {formatCountdown(remaining ?? 0)}
            </span>{' '}
            for inactivity. Unsaved changes will be lost.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={staySignedIn}>
            Stay signed in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
