import * as React from 'react';

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

import type { ImportStepEdit, StepEditable } from '../import-types';
import { shortWeekLabel } from '../week-labels';

export interface TimingDialogTarget {
  ref: string;
  stepId: string;
  title: string;
  editable: StepEditable;
  hasPredecessors: boolean;
  current: Pick<ImportStepEdit, 'duration_weeks' | 'start_not_before_week' | 'overlap_weeks'>;
}

type Fields = { start: string; duration: string; overlap: string };

function toText(v: number | null): string {
  return v === null ? '' : String(v);
}

function parseField(raw: string, min: number, max: number): { value: number | null; error?: string } {
  const t = raw.trim();
  if (t === '') return { value: null };
  if (!/^\d+$/.test(t)) return { value: null, error: 'Whole weeks only.' };
  const n = Number(t);
  if (n < min || n > max) return { value: null, error: `Between ${String(min)} and ${String(max)}.` };
  return { value: n };
}

/**
 * The keyboard path to the Gantt gestures: earliest start (absolute week), work weeks and
 * overlap with the previous step. Blank = no planner value. Saved into the edits map only.
 */
export function ImportStepTimingDialog({
  target,
  baseYear,
  currentWeek,
  horizonWeeks,
  onClose,
  onSave,
}: {
  target: TimingDialogTarget | null;
  baseYear: number;
  currentWeek: number;
  horizonWeeks: number;
  onClose: () => void;
  onSave: (edit: Pick<ImportStepEdit, 'duration_weeks' | 'start_not_before_week' | 'overlap_weeks'>) => void;
}): React.JSX.Element {
  const [fields, setFields] = React.useState<Fields>({
    start: '',
    duration: '',
    overlap: '',
  });
  const [shownFor, setShownFor] = React.useState<TimingDialogTarget | null>(null);
  if (target !== shownFor) {
    setShownFor(target);
    if (target)
      setFields({
        start: toText(target.current.start_not_before_week),
        duration: toText(target.current.duration_weeks),
        overlap: toText(target.current.overlap_weeks),
      });
  }
  const canMove = target?.editable === 'move_resize';
  const start = parseField(fields.start, currentWeek, horizonWeeks);
  const duration = parseField(fields.duration, 1, 104);
  const overlap = parseField(fields.overlap, 0, 104);
  const invalid = Boolean(start.error || duration.error || overlap.error);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid || !target) return;
    onSave({
      start_not_before_week: canMove ? start.value : target.current.start_not_before_week,
      duration_weeks: duration.value,
      overlap_weeks:
        canMove && target.hasPredecessors && overlap.value !== 0
          ? overlap.value
          : canMove
            ? null
            : target.current.overlap_weeks,
    });
  };

  return (
    <Dialog open={target !== null} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={save} className="grid gap-s4">
          <DialogHeader>
            <DialogTitle>Edit timing</DialogTitle>
            <DialogDescription>
              {target?.title}. Nothing is saved: the What-if is recomputed with this change.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-s3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="imp-t-start" className="text-2xs text-text-muted">
                Earliest start (week no.)
              </Label>
              <Input
                id="imp-t-start"
                inputMode="numeric"
                disabled={!canMove}
                value={fields.start}
                aria-invalid={Boolean(start.error)}
                aria-describedby="imp-t-start-hint"
                onChange={(e) => setFields((f) => ({ ...f, start: e.target.value }))}
              />
              <p id="imp-t-start-hint" className="text-2xs text-text-muted">
                {start.error ??
                  (start.value !== null
                    ? shortWeekLabel(start.value, baseYear)
                    : `${String(currentWeek)}–${String(horizonWeeks)}`)}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="imp-t-dur" className="text-2xs text-text-muted">
                Duration (weeks)
              </Label>
              <Input
                id="imp-t-dur"
                inputMode="numeric"
                value={fields.duration}
                aria-invalid={Boolean(duration.error)}
                aria-describedby="imp-t-dur-hint"
                onChange={(e) => setFields((f) => ({ ...f, duration: e.target.value }))}
              />
              <p id="imp-t-dur-hint" className="text-2xs text-text-muted">
                {duration.error ?? '1–104, blank = lead time'}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="imp-t-ovl" className="text-2xs text-text-muted">
                Overlap with previous step (weeks)
              </Label>
              <Input
                id="imp-t-ovl"
                inputMode="numeric"
                disabled={!canMove || !target?.hasPredecessors}
                value={fields.overlap}
                aria-invalid={Boolean(overlap.error)}
                aria-describedby="imp-t-ovl-hint"
                onChange={(e) => setFields((f) => ({ ...f, overlap: e.target.value }))}
              />
              <p id="imp-t-ovl-hint" className="text-2xs text-text-muted">
                {overlap.error ?? '0 = after the previous step'}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid}>
              Apply and recompute
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
