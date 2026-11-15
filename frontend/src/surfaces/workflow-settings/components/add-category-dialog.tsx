import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

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
import type { Category } from '@/lib/category-catalog';
import { cn } from '@/lib/utils';
import type { WorkflowId } from '@/types/enums';

import { createCategory } from '../api/workflow-settings-api';
import type { CategoryCreateRequest, CategoryCreateResponse } from '../api/types';
import { invalidateTemplateQueries } from '../hooks/use-workflow-settings';
import { ADD_CATEGORY_COPY, addCategoryError, type AddCategoryField as Field } from '../lib/add-category-copy';

/**
 * P33-T18 (ADR 0047 §2, API_CONTRACT_P33 B2): "+ Add category". The new
 * category copies a template of the same workflow (lengths, gaps and the
 * effort weights) and takes a place in the scheduling order. Nothing becomes
 * stale and no recalculation starts. Every check is the server's; the codes it
 * answers are turned into a message next to the field they concern.
 */

const WORKFLOW_LABEL: Record<WorkflowId, string> = { PDD: 'Standard PDD', OEM: 'OEM' };
const FIRST = '__first__';

export function AddCategoryDialog({
  open,
  onOpenChange,
  categories,
  defaultWorkflow,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every category, in rank order (B1 / C1). */
  categories: readonly Category[];
  defaultWorkflow: WorkflowId;
  onCreated: (category: Category) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="add-category-dialog">
        <DialogHeader>
          <DialogTitle>Add a category</DialogTitle>
          <DialogDescription>
            The new category starts as a copy of another category&apos;s template. Engineers who can work on that
            category can work on the new one too. Nothing is recalculated.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <AddCategoryForm
            categories={categories}
            defaultWorkflow={defaultWorkflow}
            onCancel={() => onOpenChange(false)}
            onCreated={(c) => {
              onOpenChange(false);
              onCreated(c);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AddCategoryForm({
  categories,
  defaultWorkflow,
  onCancel,
  onCreated,
}: {
  categories: readonly Category[];
  defaultWorkflow: WorkflowId;
  onCancel: () => void;
  onCreated: (category: Category) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const ids = {
    code: React.useId(),
    label: React.useId(),
    workflow: React.useId(),
    copy: React.useId(),
    position: React.useId(),
  };
  const ordered = React.useMemo(() => [...categories].sort((a, b) => a.rank - b.rank), [categories]);
  const [code, setCode] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [workflow, setWorkflow] = React.useState<WorkflowId>(defaultWorkflow);
  const sources = ordered.filter((c) => c.workflow_id === workflow);
  const [copyFrom, setCopyFrom] = React.useState<string>(sources[0]?.code ?? '');
  const [insertAfter, setInsertAfter] = React.useState<string>(sources[0]?.code ?? FIRST);
  const [error, setError] = React.useState<{ field: Field; message: string } | null>(null);

  const create = useMutation({
    mutationFn: (body: CategoryCreateRequest) => createCategory(body),
    onSuccess: (res: CategoryCreateResponse) => {
      invalidateTemplateQueries(queryClient, { categories: true });
      onCreated(res.category);
    },
    onError: (err) => setError(addCategoryError(err)),
  });

  const changeWorkflow = (next: WorkflowId) => {
    setWorkflow(next);
    const first = ordered.find((c) => c.workflow_id === next)?.code ?? '';
    setCopyFrom(first);
    setInsertAfter(first || FIRST);
    setError(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (code.trim() === '') {
      setError({ field: 'code', message: ADD_CATEGORY_COPY.required });
      return;
    }
    const trimmedLabel = label.trim();
    create.mutate({
      code: code.trim(),
      label: trimmedLabel === '' ? null : trimmedLabel,
      workflow_id: workflow,
      copy_from: copyFrom,
      insert_after: insertAfter === FIRST ? null : insertAfter,
    });
  };

  const fieldError = (field: Field) =>
    error?.field === field ? (
      <p id={`${ids.code}-${field}-err`} role="alert" className="text-2xs text-danger">
        {error.message}
      </p>
    ) : null;
  const describedBy = (field: Field) => (error?.field === field ? `${ids.code}-${field}-err` : undefined);
  const selectClass = cn(
    'flex h-8 w-full rounded border border-border-strong bg-surface px-2 text-sm text-text',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
  );

  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={ids.code}>Code</Label>
          <Input
            id={ids.code}
            value={code}
            maxLength={16}
            placeholder="e.g. B2"
            onChange={(e) => setCode(e.target.value)}
            aria-invalid={error?.field === 'code' || undefined}
            aria-describedby={describedBy('code')}
            autoComplete="off"
          />
          {fieldError('code')}
        </div>
        <div className="space-y-1">
          <Label htmlFor={ids.label}>Name (optional)</Label>
          <Input id={ids.label} value={label} maxLength={60} placeholder="e.g. Light refresh" onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.workflow}>Workflow</Label>
        <select id={ids.workflow} className={selectClass} value={workflow} onChange={(e) => changeWorkflow(e.target.value as WorkflowId)}>
          {(Object.keys(WORKFLOW_LABEL) as WorkflowId[]).map((w) => (
            <option key={w} value={w}>
              {WORKFLOW_LABEL[w]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.copy}>Copy the template from</Label>
        <select
          id={ids.copy}
          className={selectClass}
          value={copyFrom}
          onChange={(e) => setCopyFrom(e.target.value)}
          aria-invalid={error?.field === 'copy_from' || undefined}
          aria-describedby={describedBy('copy_from')}
        >
          {sources.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label !== c.code ? `${c.code} — ${c.label}` : c.code}
            </option>
          ))}
        </select>
        {fieldError('copy_from')}
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.position}>Place in the scheduling order</Label>
        <select
          id={ids.position}
          className={selectClass}
          value={insertAfter}
          onChange={(e) => setInsertAfter(e.target.value)}
          aria-invalid={error?.field === 'insert_after' || undefined}
          aria-describedby={`${ids.position}-help${describedBy('insert_after') ? ` ${String(describedBy('insert_after'))}` : ''}`}
          data-testid="add-category-position"
        >
          <option value={FIRST}>First (before {ordered[0]?.code ?? 'every category'})</option>
          {ordered.map((c) => (
            <option key={c.code} value={c.code}>
              After {c.code}
            </option>
          ))}
        </select>
        <p id={`${ids.position}-help`} className="text-2xs text-text-muted">
          The scheduler uses this order as a tie-breaker between projects with the same priority, position and
          status.
        </p>
        {fieldError('insert_after')}
      </div>
      {fieldError('form')}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending || copyFrom === ''}>
          {create.isPending ? 'Adding…' : 'Add category'}
        </Button>
      </DialogFooter>
    </form>
  );
}
