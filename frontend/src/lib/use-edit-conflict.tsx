import * as React from 'react';

import { EditConflictDialog } from '@/components/shared/edit-conflict-dialog';
import type { ConflictChoice, EditConflict } from '@/lib/api/edit-conflict';

interface Pending {
  conflicts: EditConflict[];
  note: string | undefined;
  resolve: (choice: ConflictChoice) => void;
}

export interface UseEditConflict {
  /** Opens the dialog; resolves with the user's choice (`null` = closed). */
  ask: (conflicts: EditConflict[], note?: string) => Promise<ConflictChoice>;
  /** Render once in the surface. */
  dialog: React.JSX.Element;
  /** The dialog is showing: counts as "an edit in progress" for freshness. */
  open: boolean;
}

/**
 * P47-T03 (ADR 0059 C2): the conflict dialog as a promise. A surface calls
 * `ask(conflicts)` from its save handler (or hands it to
 * `saveWithConflictCheck`) and renders `dialog` once.
 */
export function useEditConflict(
  formatValue?: (conflict: EditConflict, value: unknown) => string | null,
): UseEditConflict {
  const [pending, setPending] = React.useState<Pending | null>(null);
  /** The open question's resolver (set in `ask`, cleared in `finish`). */
  const pendingRef = React.useRef<Pending | null>(null);

  // An unmounted surface answers "closed" so no save awaits forever.
  React.useEffect(() => () => pendingRef.current?.resolve(null), []);

  const ask = React.useCallback(
    (conflicts: EditConflict[], note?: string) =>
      new Promise<ConflictChoice>((resolve) => {
        pendingRef.current?.resolve(null);
        const next: Pending = { conflicts, note, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );
  const finish = React.useCallback((choice: ConflictChoice) => {
    pendingRef.current?.resolve(choice);
    pendingRef.current = null;
    setPending(null);
  }, []);

  const dialog = (
    <EditConflictDialog
      open={pending !== null}
      conflicts={pending?.conflicts ?? []}
      note={pending?.note}
      formatValue={formatValue}
      onUseTheirs={() => finish('theirs')}
      onKeepMine={() => finish('mine')}
      onDismiss={() => finish(null)}
    />
  );
  return { ask, dialog, open: pending !== null };
}
