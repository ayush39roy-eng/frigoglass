import * as React from 'react';

import { StepTimingContext } from './step-timing-context';
import { useStepTimingFlow } from './use-step-timing-flow';

/**
 * Hosts one step-timing flow for the Gantt page (ADR 0019). Every step bar's
 * drag handles and "Edit timing" button share it; its dialog and progress
 * panel live here rather than in a virtualized row.
 */
export function StepTimingProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { api, element } = useStepTimingFlow();
  return (
    <StepTimingContext.Provider value={api}>
      {children}
      {element}
    </StepTimingContext.Provider>
  );
}
