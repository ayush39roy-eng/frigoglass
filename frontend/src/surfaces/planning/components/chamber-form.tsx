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
import { useWorkflowStepTemplates } from '@/lib/api/reference';
import { LAB_REGIONS, type LabRegion } from '@/types/enums';

import type { ChamberCreateRequest, ChamberRead } from '../api/types';
import {
  chamberFormSchema,
  parseOptionalNumber,
  type ChamberFormInput,
  type ChamberFormValues,
} from './chamber-form-schema';

/**
 * Create / edit dialog for one chamber (`POST /chambers` / `PATCH
 * /chambers/{id}`). `react-hook-form` + `zod` for the numeric/text fields
 * (frontend-builder SKILL); `lab_region` and `allowed_stages` are local
 * component state merged in at submit — same pattern as
 * `engineer-form.tsx`/Registration's `project-form.tsx`.
 *
 * `allowed_stages` is restricted client-side to lab-kind step ids
 * (`useWorkflowStepTemplates`, filtered to `kind === 'lab'`) as a
 * responsiveness hint — the backend
 * (`api/routers/chambers.py::_validate_allowed_stages`) is the authority and
 * 422s on a design-kind step id regardless of what this picker allows.
 */
export interface ChamberFormDialogProps {
  mode: 'create' | 'edit';
  /** Required (non-null) when `mode === 'edit'`. */
  chamber: ChamberRead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: ChamberCreateRequest) => Promise<unknown>;
}

export function ChamberFormDialog({
  mode,
  chamber,
  open,
  onOpenChange,
  onSubmit,
}: ChamberFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {mode === 'edit' && chamber === null ? null : (
          <ChamberForm
            key={chamber?.id ?? 'new'}
            mode={mode}
            chamber={chamber}
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function numToStr(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function ChamberForm({
  mode,
  chamber,
  onOpenChange,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  chamber: ChamberRead | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: ChamberFormDialogProps['onSubmit'];
}): React.JSX.Element {
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [labRegion, setLabRegion] = React.useState<string>(chamber?.lab_region ?? '');
  const [stages, setStages] = React.useState<string[]>(chamber?.allowed_stages ?? []);

  const stepTemplatesQuery = useWorkflowStepTemplates();
  const labSteps = (stepTemplatesQuery.data ?? []).filter((s) => s.kind === 'lab');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ChamberFormInput, unknown, ChamberFormValues>({
    resolver: zodResolver(chamberFormSchema),
    defaultValues: {
      code: chamber?.code ?? '',
      max_concurrent: numToStr(chamber?.max_concurrent) ?? '1',
      platforms: numToStr(chamber?.platforms),
      efficiency: numToStr(chamber?.efficiency),
      weeks_per_chamber: numToStr(chamber?.weeks_per_chamber),
    },
    mode: 'onChange',
  });

  const toggleStage = (stageId: string, checked: boolean) => {
    setStages((prev) => (checked ? [...prev, stageId] : prev.filter((s) => s !== stageId)));
  };

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    if (!labRegion) {
      setSubmitError('Lab region is required.');
      return;
    }
    // `platforms`/`efficiency`/`weeks_per_chamber` are optional-with-a-server-
    // default on the backend (`ChamberCreateRequest`), but the field TYPE
    // there is a plain `int`/`float`, not `int | None` — unlike Registration's
    // financial fields, the backend would 422 on an explicit `null`. Falling
    // back to the same defaults the backend would apply keeps the request
    // body always well-typed (no `undefined` under `exactOptionalPropertyTypes`)
    // and sends exactly the value the form is showing.
    const body: ChamberCreateRequest = {
      code: values.code,
      lab_region: labRegion as LabRegion,
      max_concurrent: Number(values.max_concurrent),
      platforms: parseOptionalNumber(values.platforms) ?? 1,
      efficiency: parseOptionalNumber(values.efficiency) ?? 1.0,
      weeks_per_chamber: parseOptionalNumber(values.weeks_per_chamber) ?? 0,
      allowed_stages: stages,
    };
    try {
      await onSubmit(body);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) {
        setSubmitError('Your role cannot create or edit chambers.');
      } else if (err instanceof ApiError) {
        setSubmitError(err.detail ?? 'The chamber could not be saved. Please try again.');
      } else {
        setSubmitError('The chamber could not be saved. Please try again.');
      }
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{mode === 'create' ? 'Add a chamber' : `Edit ${chamber?.code}`}</DialogTitle>
        <DialogDescription>
          A lab-step scheduling resource. Only &quot;Max concurrent&quot; gates booking (ADR 0003) —
          efficiency and weeks-per-chamber are reporting-only figures shown on RPD Capacity (
          <span className="italic">docs/OPEN_QUESTIONS.md #3</span>).
        </DialogDescription>
      </DialogHeader>

      <div className="my-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" htmlFor="ch-code" error={errors.code?.message} required>
            <Input id="ch-code" aria-invalid={errors.code ? true : undefined} {...register('code')} />
          </Field>
          <Field label="Lab region" htmlFor="ch-region" required>
            <Select value={labRegion} onValueChange={setLabRegion}>
              <SelectTrigger id="ch-region" className="h-8">
                <SelectValue placeholder="Select a lab region" />
              </SelectTrigger>
              <SelectContent>
                {LAB_REGIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Max concurrent"
            htmlFor="ch-max"
            error={errors.max_concurrent?.message}
            required
          >
            <Input
              id="ch-max"
              type="number"
              min={1}
              step="1"
              inputMode="numeric"
              className="tnum"
              aria-invalid={errors.max_concurrent ? true : undefined}
              {...register('max_concurrent')}
            />
          </Field>
          <Field label="Platforms" htmlFor="ch-platforms" error={errors.platforms?.message}>
            <Input
              id="ch-platforms"
              type="number"
              min={1}
              step="1"
              inputMode="numeric"
              className="tnum"
              aria-invalid={errors.platforms ? true : undefined}
              {...register('platforms')}
            />
          </Field>
          <Field label="Efficiency" htmlFor="ch-efficiency" error={errors.efficiency?.message}>
            <Input
              id="ch-efficiency"
              type="number"
              min={0.01}
              step="0.01"
              inputMode="decimal"
              className="tnum"
              aria-invalid={errors.efficiency ? true : undefined}
              {...register('efficiency')}
            />
          </Field>
          <Field
            label="Weeks per chamber"
            htmlFor="ch-weeks"
            error={errors.weeks_per_chamber?.message}
          >
            <Input
              id="ch-weeks"
              type="number"
              min={0}
              step="0.1"
              inputMode="decimal"
              className="tnum"
              aria-invalid={errors.weeks_per_chamber ? true : undefined}
              {...register('weeks_per_chamber')}
            />
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
            Allowed stages
          </legend>
          <p className="text-2xs text-text-muted">
            Lab-kind workflow steps this chamber may book (Invariant I4). Restricted to lab-kind
            steps only — the API rejects a design-kind step id here.
          </p>
          {stepTemplatesQuery.isPending ? (
            <p className="text-2xs text-text-subtle">Loading workflow steps…</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {labSteps.map((step) => (
                <label key={step.id} className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={stages.includes(step.id)}
                    onCheckedChange={(next) => toggleStage(step.id, next === true)}
                  />
                  {step.id} — {step.name}
                </label>
              ))}
            </div>
          )}
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
          {isSubmitting ? 'Saving…' : mode === 'create' ? 'Add chamber' : 'Save changes'}
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
