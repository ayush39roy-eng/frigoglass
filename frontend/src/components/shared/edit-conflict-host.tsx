import * as React from 'react';

import { useEditConflictHostStore } from '@/stores/edit-conflict-host';

import { EditConflictDialog } from './edit-conflict-dialog';

/** P47-T03 (ADR 0059 C2): the app-wide conflict dialog (mounted once by the shell). */
export function EditConflictHost(): React.JSX.Element {
  const pending = useEditConflictHostStore((st) => st.pending);
  const mount = useEditConflictHostStore((st) => st.mount);
  const finish = useEditConflictHostStore((st) => st.finish);
  React.useEffect(() => mount(), [mount]);
  return (
    <EditConflictDialog
      open={pending !== null}
      conflicts={pending?.conflicts ?? []}
      note={pending?.note}
      onUseTheirs={() => finish('theirs')}
      onKeepMine={() => finish('mine')}
      onDismiss={() => finish(null)}
    />
  );
}
