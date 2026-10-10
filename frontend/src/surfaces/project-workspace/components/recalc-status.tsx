import * as React from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';

export function RecalculateButton({
  onClick,
  busy,
  size = 'sm',
  variant = 'primary',
}: {
  onClick: () => void;
  busy: boolean;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary';
}): React.JSX.Element {
  return (
    <Button type="button" size={size} variant={variant} onClick={onClick} disabled={busy}>
      <RefreshCw className={busy ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />
      {busy ? 'Recalculating…' : 'Recalculate schedule'}
    </Button>
  );
}

/** The live solver status moved to the shared `RunProgressStatus` (P11) so the
 *  priority move can use it too; re-exported here under its original name. */
export { RunProgressStatus as RecalcStatus } from '@/components/shared/run-progress-status';
