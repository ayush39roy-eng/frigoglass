/** P13-T12: the Priority board toolbar's state and option labels (kept out of
 *  the component file so React Fast Refresh stays component-only). */

export const ALL = '__all__';

/** Server limit on `q` (contract §3). */
export const SEARCH_MAX = 100;

export interface BoardToolbarState {
  search: string;
  category: string;
  type: string;
  status_: string;
  leader: string;
}

export const EMPTY_TOOLBAR: BoardToolbarState = { search: '', category: ALL, type: ALL, status_: ALL, leader: ALL };

export interface LeaderOption {
  id: string;
  /** GDPR (OQ #8): null unless the leader is the caller. */
  name: string | null;
}

/** A leader with no served name stays a distinct option, labelled
 *  "Name unavailable" plus a short id suffix. */
export function leaderOptionLabel(leader: LeaderOption): string {
  return leader.name ?? `Name unavailable · ${leader.id.slice(-4)}`;
}
