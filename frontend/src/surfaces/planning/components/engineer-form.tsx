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
import { capacityHubsOnly, joinNames, memberHubsByCapacityHub } from '@/lib/hub-labels';
import { useCategoryCatalogSnapshot } from '@/lib/category-catalog';
import type { EngineerAllowedCategory } from '@/types/enums';

import type { EngineerCreateRequest, EngineerRead, EngineerUpdateRequest } from '../api/types';
import { isInactive } from '../lib/deactivation';
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
  /** Create sends the full body; editing an INACTIVE engineer sends `{ name }`
   *  only (P38, ADR 0053 §7: any other field is 409 ENGINEER_INACTIVE). */
  onSubmit: (body: EngineerCreateRequest | EngineerUpdateRequest) => Promise<unknown>;
  /** P19-T04: the hub pre-selected on create (a hub card's "Add" action). */
  defaultHubId?: string | undefined;
}

export function EngineerFormDialog({
  mode,
  engineer,
  open,
  onOpenChange,
  hubs,
  onSubmit,
  defaultHubId,
}: EngineerFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {mode === 'edit' && engineer === null ? null : (
          <EngineerForm
            key={engineer?.id ?? `new-${defaultHubId ?? ''}`}
            mode={mode}
            engineer={engineer}
            hubs={hubs}
            defaultHubId={defaultHubId}
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
  defaultHubId,
}: {
  defaultHubId?: string | undefined;
  mode: 'create' | 'edit';
  engineer: EngineerRead | null;
  hubs: Hub[];
  onOpenChange: (open: boolean) => void;
  onSubmit: EngineerFormDialogProps['onSubmit'];
}): React.JSX.Element {
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const nameOnly = mode === 'edit' && engineer !== null && isInactive(engineer);
  // P29 (API_CONTRACT_P29 §5.2): an engineer sits on a capacity hub only; a
  // member hub (OEM-HCK, OEM-Seitek) is a 422 HUB_NOT_CAPACITY_HUB, so it is
  // not offered. Their design work is done by their capacity hub's engineers.
  const hubOptions = React.useMemo(() => capacityHubsOnly(hubs), [hubs]);
  const memberGroups = React.useMemo(() => memberHubsByCapacityHub(hubs), [hubs]);
  const [hubId, setHubId] = React.useState<string>(() => {
    const initial = engineer?.hub_id ?? defaultHubId ?? '';
    return hubOptions.some((h) => h.id === initial) ? initial : '';
  });
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

  // P33-T14: the served categories (PDD, the blanket OEM, OEM-workflow; rank order),
  // plus any stored value the list does not carry.
  const catalog = useCategoryCatalogSnapshot();
  const eligibility = catalog.eligibilityCodes();
  const categoryChoices = [...eligibility, ...categories.filter((c) => !eligibility.includes(c))];

  const toggleCategory = (category: EngineerAllowedCategory, checked: boolean) => {
    setCategories((prev) =>
      checked ? [...prev, category] : prev.filter((c) => c !== category),
    );
  };

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    if (nameOnly) {
      try {
        await onSubmit({ name: values.name });
        onOpenChange(false);
      } catch (err) {
        setSubmitError(
          err instanceof ApiError && err.isForbidden
            ? 'Your role cannot create or edit engineers.'
            : err instanceof ApiError
              ? (err.detail ?? 'The name could not be saved. Please try again.')
              : 'The name could not be saved. Please try again.',
        );
      }
      return;
    }
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
          {nameOnly
            ? 'This engineer is inactive: only the name can be changed. Reactivate them to change anything else.'
            : 'A design-step scheduling resource — also the pool of eligible project leaders on Project Registration.'}
        </DialogDescription>
      </DialogHeader>

      <div className="my-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="eng-name" error={errors.name?.message} required>
            <Input id="eng-name" aria-invalid={errors.name ? true : undefined} {...register('name')} />
          </Field>
          <Field label="Hub" htmlFor="eng-hub" required>
            <Select value={hubId} onValueChange={setHubId} disabled={nameOnly}>
              <SelectTrigger id="eng-hub" className="h-8">
                <SelectValue placeholder="Select a hub" />
              </SelectTrigger>
              <SelectContent>
                {hubOptions.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {memberGroups.map((g) => (
              <span key={g.capacityHub} className="text-2xs text-text-muted" data-testid="engineer-hub-members-note">
                {joinNames(g.members)} {g.members.length === 1 ? 'uses' : 'use'} {g.capacityHub}&rsquo;s engineers.
              </span>
            ))}
          </Field>
          <Field label="FTE" htmlFor="eng-fte" error={errors.fte?.message} required>
            <Input
              id="eng-fte"
              type="number"
              min={0.1}
              step="0.1"
              inputMode="decimal"
              className="tnum"
              disabled={nameOnly}
              aria-invalid={errors.fte ? true : undefined}
              {...register('fte')}
            />
          </Field>
        </div>
        <p className="text-2xs text-text-muted" data-testid="engineer-fte-help">
          FTE sets the engineer&apos;s speed on the design steps they lead: at 0.5 FTE they work at
          half speed, so 4 weeks of work take 8 calendar weeks (ADR 0032). It also scales their
          design capacity on RPD Capacity.
        </p>

        <fieldset className="space-y-2" disabled={nameOnly}>
          <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
            Allowed categories
          </legend>
          <p className="text-2xs text-text-muted">
            Categories (and/or OEM) this engineer may lead. A design step booked to a leader whose
            allowed categories exclude the project&apos;s category raises CAT_NOT_ALLOWED (a
            warning, not a scheduling block).
          </p>
          <div className="flex flex-wrap gap-3">
            {categoryChoices.map((category) => (
              <label key={category} className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  disabled={nameOnly}
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
