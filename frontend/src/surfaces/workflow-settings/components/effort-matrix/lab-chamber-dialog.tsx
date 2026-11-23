import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface LabChamberRequest {
  /** The served steps without a chamber, e.g. ["PDD-J", "PDD-L"]. */
  steps: string[];
  /** Lab steps (as served) whose chambers may take them, in workflow order. */
  options: string[];
  /** Preselected option (e.g. "PDD-H"). */
  defaultLike: string | null;
  resolve: (like: string | null) => void;
}

/** "PDD-J" / "PDD-J and PDD-L" / "PDD-J, PDD-K and PDD-L". */
function listSteps(steps: readonly string[]): string {
  if (steps.length <= 1) return steps[0] ?? 'this step';
  return `${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1] ?? ''}`;
}

export function LabChamberDialog({ request }: { request: LabChamberRequest | null }): React.JSX.Element {
  // The pick belongs to one request; a new request starts from its default.
  const [picked, setPicked] = React.useState<{ request: LabChamberRequest; like: string } | null>(null);
  const like =
    picked !== null && picked.request === request ? picked.like : (request?.defaultLike ?? request?.options[0] ?? '');
  const setLike = (next: string) => {
    if (request) setPicked({ request, like: next });
  };
  const selectId = React.useId();
  const steps = request ? listSteps(request.steps) : '';
  const hasOptions = (request?.options.length ?? 0) > 0;

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) request?.resolve(null);
      }}
    >
      <DialogContent className="max-w-md" data-testid="lab-chamber-dialog">
        <DialogHeader>
          <DialogTitle>No lab chamber accepts {steps}</DialogTitle>
          <DialogDescription>
            Projects reaching {request && request.steps.length > 1 ? 'these steps' : 'this step'} could not be scheduled.{' '}
            {hasOptions
              ? `Run ${request && request.steps.length > 1 ? 'them' : 'it'} on the same chambers as another lab step?`
              : 'No other lab step has chambers to share. Add the step to a chamber under Chambers first.'}
          </DialogDescription>
        </DialogHeader>
        {hasOptions ? (
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor={selectId} className="text-text-muted">
              Same chambers as
            </label>
            <select
              id={selectId}
              value={like}
              onChange={(e) => setLike(e.target.value)}
              className="h-8 rounded-md border border-input bg-surface px-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="lab-chamber-like"
            >
              {request?.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="secondary" size="sm" onClick={() => request?.resolve(null)}>
            Cancel
          </Button>
          {hasOptions ? (
            <Button type="button" size="sm" disabled={like === ''} onClick={() => request?.resolve(like)}>
              Use the same chambers and save
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
