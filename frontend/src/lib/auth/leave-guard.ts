import type { Location } from 'react-router-dom';

/**
 * P49-R01 (ADR 0060 A2): `location.state` on the `/login` navigation of a
 * sign-out this tab did not ask for: after 30 minutes idle (`'idle'`, the
 * login page shows the inactivity notice) or because another tab signed out
 * (`'remote'`). The session is already gone, so no leave guard may hold it;
 * unsaved edits are lost, as ADR 0060 says, after the 2-minute warning.
 */
export interface LoginLocationState {
  signedOut?: 'idle' | 'remote';
}

/** True for a forced sign-out's navigation, which every `useBlocker` leave guard lets through. */
export function isForcedSignOutNavigation(next: Pick<Location, 'state'>): boolean {
  const state = next.state as LoginLocationState | null | undefined;
  return state?.signedOut === 'idle' || state?.signedOut === 'remote';
}

/** The predicate the leave guards pass to `useBlocker`: block a route change while `when`, never a forced sign-out. */
export function shouldBlockLeave(
  when: boolean,
  { currentLocation, nextLocation }: { currentLocation: Location; nextLocation: Location },
): boolean {
  return when && currentLocation.pathname !== nextLocation.pathname && !isForcedSignOutNavigation(nextLocation);
}
