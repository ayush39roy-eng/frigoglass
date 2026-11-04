import * as React from 'react';
import { BookmarkPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useImportPlan } from '../import-store';
import {
  defaultScenarioName,
  MAX_SCENARIO_NAME,
  MAX_SCENARIOS,
  useImportScenarios,
} from '../scenarios-store';

/**
 * "Save as scenario" (P32-R05 C2): names the current computed result and keeps a snapshot
 * of rows + options + edits + the served response in the session-only scenarios store.
 */
export function SaveScenarioButton({
  disabled,
  onSaved,
}: {
  disabled: boolean;
  onSaved?: (id: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const scenarios = useImportScenarios((s) => s.scenarios);
  const save = useImportScenarios((s) => s.save);
  const full = scenarios.length >= MAX_SCENARIOS;
  const inputId = React.useId();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const st = useImportPlan.getState();
    if (!st.result || name.trim() === '') return;
    const id = save({
      name,
      origin: 'saved',
      rules: null,
      fileName: st.parsed?.file_name ?? null,
      rows: st.rows,
      options: st.options,
      edits: st.edits,
      response: st.result,
    });
    setOpen(false);
    if (id) onSaved?.(id);
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || full}
        title={full ? `At most ${String(MAX_SCENARIOS)} scenarios; delete one first` : undefined}
        onClick={() => {
          setName(defaultScenarioName(scenarios));
          setOpen(true);
        }}
      >
        <BookmarkPlus />
        Save as scenario
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" data-testid="import-save-scenario">
          <form onSubmit={submit} className="space-y-s4">
            <DialogHeader>
              <DialogTitle>Save as scenario</DialogTitle>
              <DialogDescription>Kept for this session only, to compare on the Compare tab.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1">
              <Label htmlFor={inputId} className="text-2xs text-text-muted">
                Scenario name
              </Label>
              <Input
                id={inputId}
                value={name}
                maxLength={MAX_SCENARIO_NAME}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={name.trim() === ''}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
