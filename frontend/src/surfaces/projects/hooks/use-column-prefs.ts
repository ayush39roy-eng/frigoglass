import * as React from 'react';

import {
  clampWidth,
  clearColumnPrefs,
  EMPTY_COLUMN_PREFS,
  readColumnPrefs,
  writeColumnPrefs,
  type ColumnPrefs,
} from '../lib/column-prefs';

/**
 * P35-T08: this user's register column layout, read once per user and
 * written on every change. Storage failures are swallowed by `column-prefs`
 * (the layout still applies for this visit).
 */
export function useColumnPrefs(userId: string | null | undefined) {
  const [state, setState] = React.useState<{ userId: string | null | undefined; prefs: ColumnPrefs }>(() => ({
    userId,
    prefs: readColumnPrefs(userId),
  }));
  // Another user signed in (dev user switch): load theirs.
  let current = state;
  if (state.userId !== userId) {
    current = { userId, prefs: readColumnPrefs(userId) };
    setState(current);
  }
  const prefs = current.prefs;

  const update = React.useCallback(
    (fn: (prev: ColumnPrefs) => ColumnPrefs) => {
      setState((prev) => {
        const next = fn(prev.prefs);
        writeColumnPrefs(userId, next);
        return { userId, prefs: next };
      });
    },
    [userId],
  );

  const setVisible = React.useCallback(
    (id: string, visible: boolean) =>
      update((p) => ({
        ...p,
        hidden: visible ? p.hidden.filter((h) => h !== id) : p.hidden.includes(id) ? p.hidden : [...p.hidden, id],
      })),
    [update],
  );

  const setWidth = React.useCallback(
    (id: string, px: number) => update((p) => ({ ...p, widths: { ...p.widths, [id]: clampWidth(px) } })),
    [update],
  );

  const reset = React.useCallback(() => {
    clearColumnPrefs(userId);
    setState({ userId, prefs: EMPTY_COLUMN_PREFS });
  }, [userId]);

  return { prefs, setVisible, setWidth, reset };
}
