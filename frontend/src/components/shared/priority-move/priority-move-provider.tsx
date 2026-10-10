import * as React from 'react';

import { PriorityMoveContext } from './priority-move-context';
import { usePriorityMoveFlow } from './use-priority-move-flow';

/**
 * Hosts one priority-move flow for a page (ADR 0015). Every
 * `<PriorityMoveControl>` below it shares this flow, and its confirm dialog and
 * progress panel live here rather than in a (possibly virtualized) row.
 */
export function PriorityMoveProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { api, element } = usePriorityMoveFlow();
  return (
    <PriorityMoveContext.Provider value={api}>
      {children}
      {element}
    </PriorityMoveContext.Provider>
  );
}
