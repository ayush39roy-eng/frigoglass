import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import type { Hub } from '@/lib/api/reference';
import { ENGINEER_ALLOWED_CATEGORIES, type EngineerAllowedCategory } from '@/types/enums';

import type { EngineerCreateRequest, EngineerRead } from '../api/types';
import {
  engineerFormSchema,
  type EngineerFormInput,
  type EngineerFormValues,
} from './engineer-form-schema';

/**
 * Create / edit dialog for one engineer (`POST /engineers` / `PATCH
 * /engineers/{id}`). `react-hook-form` + `zod` for `name`/`fte`
 * (frontend-builder SKILL); the hub select and the `allowed_categories`
 * checkbox list are local component state merged in at submit — same pattern
 * as Registration's `project-form.tsx` / Matrix's `score-edit-dialog.tsx`.
 */
export interface EngineerFormDialogProps {
  mode: 'create' | 'edit';
  /** Required (non-null) when `mode === 'edit'`. */
  engineer: EngineerRead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hubs: Hub[];
  onSubmit: (body: EngineerCreateRequest) => Promise<unknown>;
}

export function EngineerFormDialog({
  mode,
  engineer,
  open,
  onOpenChange,
  hubs,
  onSubmit,
}: EngineerFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {mode === 'edit' && engineer === null ? null : (
          <EngineerForm
            key={engineer?.id ?? 'new'}
            mode={mode}
            engineer={engineer}
            hubs={hubs}
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EngineerForm({
  mode,
  engineer,
  hubs,
  onOpenChange,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  engineer: EngineerRead | null;
  hubs: Hub[];
  onOpenChange: (open: boolean) => void;
  onSubmit: EngineerFormDialogProps['onSubmit'];
}): React.JSX.Element {
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [hubId, setHubId] = React.useState<string>(engineer?.hub_id ?? '');
  const [categories, setCategories] = React.useState<EngineerAllowedCategory[]>(
    engineer?.allowed_categories ?? [],
  );

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EngineerFormInput, unknown, EngineerFormValues>({
    resolver: zodResolver(engineerFormSchema),
    defaultValues: {
      name: engineer?.name ?? '',
      fte: String(engineer?.fte ?? 1.0),
    },
    mode: 'onChange',
  });

  const toggleCategory = (category: EngineerAllowedCategory, checked: boolean) => {
    setCategories((prev) =>
      checked ? [...prev, category] : prev.filter((c) => c !== category),
    );
  };

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    if (!hubId) {
      setSubmitError('Hub is required.');
      return;
    }
    const body: EngineerCreateRequest = {
      name: values.name,
      hub_id: hubId,
      fte: Number(values.fte),
      allowed_categories: categories,
    };
    try {
      await onSubmit(body);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) {
        setSubmitError('Your role cannot create or edit engineers.');
      } else if (err instanceof ApiError) {
        setSubmitError(err.detail ?? 'The engineer could not be saved. Please try again.');
      } else {
        setSubmitError('The engineer could not be saved. Please try again.');
      }
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{mode === 'create' ? 'Add an engineer' : `Edit ${engineer?.name}`}</DialogTitle>
        <DialogDescription>
          A design-step scheduling resource — also the pool of eligible project leaders on Project
          Registration.
        </DialogDescription>
      </DialogHeader>

      <div className="my-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="eng-name" error={errors.name?.message} required>
            <Input id="eng-name" aria-invalid={errors.name ? true : undefined} {...register('name')} />
          </Field>
          <Field label="Hub" htmlFor="eng-hub" required>
            <Select value={hubId} onValueChange={setHubId}>
              <SelectTrigger id="eng-hub" className="h-8">
                <SelectValue placeholder="Select a hub" />
              </SelectTrigger>
              <SelectContent>
                {hubs.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="FTE" htmlFor="eng-fte" error={errors.fte?.message} required>
            <Input
              id="eng-fte"
              type="number"
              min={0.1}
              step="0.1"
              inputMode="decimal"
              className="tnum"
              aria-invalid={errors.fte ? true : undefined}
              {...register('fte')}
            />
          </Field>
        </div>
        <p className="text-2xs text-text-muted">
          FTE is a reporting figure only (RPD Capacity&apos;s design-capacity display) — per ADR
          0002, it does not gate the scheduler&apos;s booking rules in v1 (
          <span className="italic">docs/OPEN_QUESTIONS.md #2</span>).
        </p>

        <fieldset className="space-y-2">
          <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
            Allowed categories
          </legend>
          <p className="text-2xs text-text-muted">
            Categories (and/or OEM) this engineer may lead. A design step booked to a leader whose
            allowed categories exclude the project&apos;s category raises CAT_NOT_ALLOWED (a
            warning, not a scheduling block).
          </p>
          <div className="flex flex-wrap gap-3">
            {ENGINEER_ALLOWED_CATEGORIES.map((category) => (
              <label key={category} className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={categories.includes(category)}
                  onCheckedChange={(next) => toggleCategory(category, next === true)}
                />
                {category}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {submitError ? (
        <p role="alert" className="mb-2 text-2xs text-danger">
          {submitError}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : mode === 'create' ? 'Add engineer' : 'Save changes'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  error,
  required,
  children,
}: {
  label: React.ReactNode;
  htmlFor: string;
  error?: string | undefined;
  required?: boolean | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </Label>
      {children}
      {error ? (
        <span role="alert" className="text-2xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
