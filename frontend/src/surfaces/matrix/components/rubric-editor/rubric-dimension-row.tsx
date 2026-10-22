import * as React from 'react';
import { ArrowDown, ArrowUp, GripVertical, RotateCcw, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import type { DraftDimension, RubricFieldError } from '../../lib/rubric-draft';
import { RUBRIC_LIMITS } from '../../lib/rubric-draft';

export const NEW_PILLAR = '__new_pillar__';

export interface DimensionRowProps {
  dim: DraftDimension;
  /** A stable accessible name for the row's controls: the served label (or the
   *  label it was added with), so a control's name does not change while typing. */
  name: string;
  position: number;
  groupSize: number;
  /** P26-T03: moves cross pillars, so only the very first / last dimension cannot move. */
  atStart?: boolean;
  atEnd?: boolean;
  editable: boolean;
  pillars: readonly string[];
  errors: RubricFieldError | undefined;
  /** Fields changed against the served rubric (`new` for an added dimension). */
  changed: readonly string[];
  /** Served scaled weight (current rubric, or the preview's), null when not served. */
  scaled: number | null;
  onChange: (patch: Partial<Omit<DraftDimension, 'uid' | 'key'>>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  registerFocus: (id: string, el: HTMLElement | null) => void;
  drag: {
    dragging: string | null;
    over: string | null;
    onDragStart: (uid: string) => void;
    onDragEnter: (uid: string) => void;
    onDrop: (uid: string) => void;
    onDragEnd: () => void;
  };
}

/**
 * One dimension of the rubric editor. Editable: label, pillar (or "New
 * pillar…"), weight 1..100, inverted, active, and reorder by drag (handle) or
 * by the Move up / Move down buttons (keyboard). Read-only: the same facts as
 * text. An inactive dimension is greyed out with "Reactivate" and the note
 * that its scores are kept (ADR 0037: never deleted).
 */
export function DimensionRow({
  dim,
  name,
  position,
  groupSize,
  atStart,
  atEnd,
  editable,
  pillars,
  errors,
  changed,
  scaled,
  onChange,
  onMove,
  onRemove,
  registerFocus,
  drag,
}: DimensionRowProps): React.JSX.Element {
  const [newPillar, setNewPillar] = React.useState<string | null>(null);
  const base = `rubric-${dim.uid}`;
  const labelText = name;
  const isNew = dim.key === null;
  const errId = (f: string) => `${base}-${f}-error`;
  const first = atStart ?? position === 1;
  const last = atEnd ?? position === groupSize;

  const commitNewPillar = () => {
    const name = (newPillar ?? '').trim();
    if (name !== '') onChange({ pillar: name });
    setNewPillar(null);
  };

  if (!editable) {
    return (
      <li
        className={cn(
          'grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border-t border-border/70 px-2 py-2 text-xs first:border-t-0',
          !dim.active && 'bg-surface-sunken text-text-muted',
        )}
        data-testid="rubric-row"
        data-active={dim.active}
      >
        <span className={cn('font-medium', dim.active ? 'text-text' : 'text-text-muted')}>
          {dim.label}
          {dim.inverted && !/inverted/i.test(dim.label) ? (
            <span className="ml-1.5 text-2xs font-normal text-text-muted">(inverted)</span>
          ) : null}
          {!dim.active ? (
            <Badge tone="neutral" className="ml-1.5">
              Inactive · scores are kept
            </Badge>
          ) : null}
        </span>
        <span className="tnum text-right text-text-muted" data-numeric="">
          weight {dim.weight}
          {scaled !== null ? ` (${scaled.toFixed(2)} of 100)` : ''}
        </span>
      </li>
    );
  }

  const dropTarget = drag.dragging !== null && drag.over === dim.uid && drag.dragging !== dim.uid;
  return (
    <li
      ref={(el) => registerFocus(`${dim.uid}-row`, el)}
      className={cn(
        'relative border-t border-border/70 px-2 py-2 text-xs first:border-t-0',
        !dim.active && 'bg-surface-sunken',
        drag.dragging === dim.uid && 'opacity-50',
        dropTarget && 'shadow-[inset_0_3px_0_hsl(var(--color-primary))]',
      )}
      data-testid="rubric-row"
      data-active={dim.active}
      data-uid={dim.uid}
      onDragOver={(e) => {
        if (drag.dragging !== null) {
          e.preventDefault();
          drag.onDragEnter(dim.uid);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        drag.onDrop(dim.uid);
      }}
    >
      <div className="flex flex-wrap items-start gap-2 sm:grid sm:grid-cols-[auto_minmax(8rem,1fr)_10rem_5.5rem_auto_auto]">
        <span
          draggable
          role="img"
          aria-label={`Drag to reorder ${labelText}`}
          title="Drag to reorder, within or across pillars (or use Move up / Move down)"
          className="mt-1.5 cursor-grab text-text-muted active:cursor-grabbing"
          data-testid="rubric-drag-handle"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', dim.uid);
            drag.onDragStart(dim.uid);
          }}
          onDragEnd={drag.onDragEnd}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </span>

        <div className="flex min-w-0 basis-40 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <label htmlFor={`${base}-label`} className="text-2xs font-medium text-text-muted">
              Label{' '}
              <span className="sr-only">of {labelText}</span>
            </label>
            {isNew ? (
              <Badge tone="success" data-testid="rubric-row-new">
                new
              </Badge>
            ) : null}
            {!isNew && changed.length > 0 ? (
              <span className="text-2xs font-semibold text-warning-subtle-fg" data-testid="rubric-row-edited">
                edited<span className="sr-only">: {changed.join(', ')}</span>
              </span>
            ) : null}
          </span>
          <Input
            id={`${base}-label`}
            ref={(el) => registerFocus(`${dim.uid}-label`, el)}
            value={dim.label}
            maxLength={RUBRIC_LIMITS.labelMax + 20}
            onChange={(e) => onChange({ label: e.target.value })}
            aria-invalid={errors?.label ? true : undefined}
            aria-describedby={errors?.label ? errId('label') : undefined}
            className="h-8 text-xs"
          />
          {errors?.label ? (
            <span id={errId('label')} className="text-2xs text-danger" data-testid="rubric-error-label">
              {errors.label}
            </span>
          ) : null}
        </div>

        <div className="flex w-full min-w-0 flex-col gap-0.5 sm:w-auto">
          <label htmlFor={`${base}-pillar`} className="text-2xs font-medium text-text-muted">
            Pillar{' '}
              <span className="sr-only">of {labelText}</span>
          </label>
          {newPillar === null ? (
            <select
              id={`${base}-pillar`}
              value={dim.pillar}
              onChange={(e) => {
                if (e.target.value === NEW_PILLAR) setNewPillar('');
                else onChange({ pillar: e.target.value });
              }}
              aria-invalid={errors?.pillar ? true : undefined}
              aria-describedby={errors?.pillar ? errId('pillar') : undefined}
              className="h-8 rounded border border-border-strong bg-surface px-1.5 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {pillars.includes(dim.pillar) ? null : <option value={dim.pillar}>{dim.pillar || '—'}</option>}
              {pillars.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              <option value={NEW_PILLAR}>New pillar…</option>
            </select>
          ) : (
            <span className="flex gap-1">
              <Input
                id={`${base}-pillar`}
                autoFocus
                value={newPillar}
                maxLength={RUBRIC_LIMITS.pillarMax + 20}
                placeholder="New pillar name"
                aria-label={`New pillar name for ${labelText}`}
                onChange={(e) => setNewPillar(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitNewPillar();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setNewPillar(null);
                  }
                }}
                className="h-8 text-xs"
              />
              <Button type="button" size="sm" variant="secondary" onClick={commitNewPillar}>
                Set
              </Button>
            </span>
          )}
          {errors?.pillar ? (
            <span id={errId('pillar')} className="text-2xs text-danger">
              {errors.pillar}
            </span>
          ) : null}
        </div>

        <div className="flex w-24 flex-col gap-0.5 sm:w-auto">
          <label htmlFor={`${base}-weight`} className="text-2xs font-medium text-text-muted">
            Weight{' '}
              <span className="sr-only">of {labelText}</span>
          </label>
          <Input
            id={`${base}-weight`}
            type="number"
            inputMode="numeric"
            min={RUBRIC_LIMITS.weightMin}
            max={RUBRIC_LIMITS.weightMax}
            step={1}
            value={dim.weight}
            onChange={(e) => onChange({ weight: e.target.value })}
            aria-invalid={errors?.weight ? true : undefined}
            aria-describedby={[errors?.weight ? errId('weight') : null, `${base}-scaled`].filter(Boolean).join(' ')}
            className="tnum h-8 text-right text-xs"
          />
          <span id={`${base}-scaled`} className="tnum text-2xs text-text-muted" data-numeric="">
            {scaled !== null ? `${scaled.toFixed(2)} of 100` : dim.active ? 'scaled on save' : 'inactive'}
          </span>
          {errors?.weight ? (
            <span id={errId('weight')} className="text-2xs text-danger" data-testid="rubric-error-weight">
              {errors.weight}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-1 pt-4">
          <label className="flex items-center gap-1.5 text-2xs text-text">
            <Checkbox
              checked={dim.inverted}
              onCheckedChange={(v) => onChange({ inverted: v === true })}
              aria-label={`Inverted: ${labelText}`}
            />
            Inverted
          </label>
          <label className="flex items-center gap-1.5 text-2xs text-text">
            <Checkbox
              checked={dim.active}
              onCheckedChange={(v) => onChange({ active: v === true })}
              aria-label={`Active: ${labelText}`}
              data-testid="rubric-active-toggle"
            />
            Active
          </label>
        </div>

        <div className="ml-auto flex items-center gap-0.5 pt-4" role="group" aria-label={`Order of ${labelText}`}>
          <Button
            ref={(el) => registerFocus(`${dim.uid}-up`, el)}
            type="button"
            variant="ghost"
            size="sm"
            className={cn('px-1.5', first && 'cursor-not-allowed opacity-40')}
            aria-disabled={first}
            aria-label={`Move ${labelText} up`}
            onClick={() => {
              if (!first) onMove(-1);
            }}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            ref={(el) => registerFocus(`${dim.uid}-down`, el)}
            type="button"
            variant="ghost"
            size="sm"
            className={cn('px-1.5', last && 'cursor-not-allowed opacity-40')}
            aria-disabled={last}
            aria-label={`Move ${labelText} down`}
            onClick={() => {
              if (!last) onMove(1);
            }}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          {isNew ? (
            <Button type="button" variant="ghost" size="sm" className="px-1.5" aria-label={`Remove ${labelText} (not saved yet)`} onClick={onRemove}>
              <Trash2 aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      {!dim.active ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-2 pl-6 text-2xs text-text-muted" data-testid="rubric-inactive-note">
          <Badge tone="neutral">Inactive</Badge>
          Not in the score; scores are kept.
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-6 px-2 text-2xs"
            onClick={() => onChange({ active: true })}
            aria-label={`Reactivate ${labelText}`}
          >
            <RotateCcw aria-hidden="true" />
            Reactivate
          </Button>
        </p>
      ) : null}
    </li>
  );
}
