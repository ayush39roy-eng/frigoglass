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
import { apiErrorMessage } from '@/lib/api/error-messages';
import { useCategoriesForHub, type Hub } from '@/lib/api/reference';
import { HORIZON_WEEKS } from '@/lib/domain-constants';
import {
  PROJECT_PRIORITIES,
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  type ProjectCategory,
  type ProjectPriority,
  type ProjectType,
} from '@/types/enums';

import { useEngineerOptions } from '../hooks/use-registration';
import type { ProjectCreateRequest, ProjectRead } from '../api/types';
import { REQUIRED_FIELD_LABELS } from './required-fields-hint';
import {
  parseOptionalNumber,
  projectFormSchema,
  type ProjectFormInput,
  type ProjectFormValues,
} from './project-form-schema';

/**
 * Create / edit dialog for one project (`POST /projects` / `PATCH
 * /projects/{id}`). `react-hook-form` + `zod` (`frontend-builder` SKILL) for
 * the text/number fields; the hub / leader / category / type / priority
 * selects and the `carry_over` checkbox are local component state merged in
 * at submit — same pattern as the Matrix's `score-edit-dialog.tsx`.
 *
 * Asterisks mark the seven Project Registration "hard gate" fields (required
 * to leave Draft, `docs/PROJECT_AND_STACK.md` §2 / `required-fields-hint.ts`)
 * — a responsiveness hint only. The authoritative answer is always
 * `GET /projects/{id}/hard-gate-status`, shown separately by
 * `hard-gate-panel.tsx` on the row/edit view, not by this form.
 */

const NONE = '__none__';

/** `number | null | undefined` → the string a text-mode numeric input holds
 *  (RHF form values for numeric fields are strings here — see
 *  `project-form-schema.ts`'s module docstring for why). */
function numToStr(value: number | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

export interface ProjectFormDialogProps {
  mode: 'create' | 'edit';
  /** Required (non-null) when `mode === 'edit'`. */
  project: ProjectRead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hubs: Hub[];
  onSubmit: (body: ProjectCreateRequest) => Promise<unknown>;
}

export function ProjectFormDialog({
  mode,
  project,
  open,
  onOpenChange,
  hubs,
  onSubmit,
}: ProjectFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {mode === 'edit' && project === null ? null : (
          <ProjectForm
            key={project?.id ?? 'new'}
            mode={mode}
            project={project}
            hubs={hubs}
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function requiredMark(field: keyof typeof REQUIRED_FIELD_LABELS): React.ReactNode {
  return (
    <span className="text-danger" title={`Required before leaving Draft (${REQUIRED_FIELD_LABELS[field]})`}>
      {' '}
      *
    </span>
  );
}

/**
 * The form body. `variant="dialog"` (default) renders inside `<ProjectFormDialog>`;
 * `variant="inline"` renders the same fields and validation in place — used by
 * the Project Workspace's Details panel (P9-T04b) so both surfaces share one
 * schema and one submit path. Radix Dialog title/description/footer only
 * render in the dialog variant.
 */
export function ProjectForm({
  mode,
  project,
  hubs,
  onOpenChange,
  onSubmit,
  variant = 'dialog',
}: {
  mode: 'create' | 'edit';
  project: ProjectRead | null;
  hubs: Hub[];
  onOpenChange: (open: boolean) => void;
  onSubmit: ProjectFormDialogProps['onSubmit'];
  variant?: 'dialog' | 'inline';
}): React.JSX.Element {
  const Header = variant === 'dialog' ? DialogHeader : InlineHeader;
  const Title = variant === 'dialog' ? DialogTitle : InlineTitle;
  const Description = variant === 'dialog' ? DialogDescription : InlineDescription;
  const Footer = variant === 'dialog' ? DialogFooter : InlineFooter;
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [hubId, setHubId] = React.useState<string>(project?.hub_id ?? '');
  const [leaderId, setLeaderId] = React.useState<string>(project?.leader_engineer_id ?? NONE);
  const [category, setCategory] = React.useState<string>(project?.category ?? NONE);
  const [type, setType] = React.useState<string>(project?.type ?? NONE);
  const [priority, setPriority] = React.useState<string>(project?.priority ?? NONE);
  const [carryOver, setCarryOver] = React.useState<boolean>(project?.carry_over ?? false);
  // P9: lab steps are skipped when this is off (ADR 0007 §5). Default ON.
  const [certificationTesting, setCertificationTesting] = React.useState<boolean>(
    project?.certification_testing_required ?? true,
  );

  const engineersQuery = useEngineerOptions(hubId || undefined);
  // P9: category options depend on the hub's workflow (contract §6). The server
  // list wins; the `is_oem` split is the fallback while it loads / offline.
  const selectedHub = React.useMemo(() => hubs.find((h) => h.id === hubId), [hubs, hubId]);
  const categories = useCategoriesForHub(selectedHub);
  const categoryOptions = categories.options;
  // A category from another workflow cannot survive a hub change (the server
  // 422s CATEGORY_WORKFLOW_MISMATCH) — clear it, synchronously, in render.
  const [prevOptionsKey, setPrevOptionsKey] = React.useState(categoryOptions.join('|'));
  const optionsKey = categoryOptions.join('|');
  if (optionsKey !== prevOptionsKey) {
    setPrevOptionsKey(optionsKey);
    if (category !== NONE && !categoryOptions.includes(category as ProjectCategory)) {
      setCategory(NONE);
    }
  }

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProjectFormInput, unknown, ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      name: project?.name ?? '',
      external_code: project?.external_code ?? undefined,
      actual_start_week: numToStr(project?.actual_start_week),
      delay_weeks: numToStr(project?.delay_weeks ?? 0),
      reg_year: numToStr(project?.reg_year),
      comments: project?.comments ?? undefined,
      customer_name: project?.customer_name ?? undefined,
      tcogs_eur: numToStr(project?.tcogs_eur),
      selling_price_eur: numToStr(project?.selling_price_eur),
      gross_margin_pct: numToStr(project?.gross_margin_pct),
      capex_keur: numToStr(project?.capex_keur),
      rm_savings_keur: numToStr(project?.rm_savings_keur),
      target_end_week: numToStr(project?.target_end_week),
      estimated_design_weeks: numToStr(project?.estimated_design_weeks),
      estimated_lab_weeks: numToStr(project?.estimated_lab_weeks),
    },
    mode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    if (!hubId) {
      setSubmitError('Hub is required.');
      return;
    }
    const body: ProjectCreateRequest = {
      name: values.name,
      external_code: values.external_code ?? null,
      hub_id: hubId,
      leader_engineer_id: leaderId === NONE ? null : leaderId,
      category: category === NONE ? null : (category as ProjectCategory),
      type: type === NONE ? null : (type as ProjectType),
      priority: priority === NONE ? null : (priority as ProjectPriority),
      actual_start_week: parseOptionalNumber(values.actual_start_week) ?? null,
      delay_weeks: parseOptionalNumber(values.delay_weeks) ?? 0,
      reg_year: parseOptionalNumber(values.reg_year) ?? null,
      carry_over: carryOver,
      comments: values.comments ?? null,
      customer_name: values.customer_name ?? null,
      tcogs_eur: parseOptionalNumber(values.tcogs_eur) ?? null,
      selling_price_eur: parseOptionalNumber(values.selling_price_eur) ?? null,
      gross_margin_pct: parseOptionalNumber(values.gross_margin_pct) ?? null,
      capex_keur: parseOptionalNumber(values.capex_keur) ?? null,
      rm_savings_keur: parseOptionalNumber(values.rm_savings_keur) ?? null,
      target_end_week: parseOptionalNumber(values.target_end_week) ?? null,
      certification_testing_required: certificationTesting,
      estimated_design_weeks: parseOptionalNumber(values.estimated_design_weeks) ?? null,
      estimated_lab_weeks: parseOptionalNumber(values.estimated_lab_weeks) ?? null,
    };
    try {
      await onSubmit(body);
      onOpenChange(false);
    } catch (err) {
      // Never include `body` (customer_name / tcogs_eur / selling_price_eur /
      // gross_margin_pct) in an error message or log — CLAUDE.md.
      if (err instanceof ApiError && err.isForbidden) {
        setSubmitError('Your role cannot create or edit projects.');
      } else if (err instanceof ApiError) {
        // CATEGORY_WORKFLOW_MISMATCH and other coded 422s get readable copy.
        setSubmitError(apiErrorMessage(err, 'The project could not be saved. Please try again.'));
      } else {
        setSubmitError('The project could not be saved. Please try again.');
      }
    }
  });

  return (
    <form onSubmit={submit} noValidate aria-label={mode === 'create' ? 'Register a project' : `Edit ${project?.name ?? 'project'}`}>
      <Header>
        <Title>{mode === 'create' ? 'Register a project' : `Edit ${project?.name}`}</Title>
        <Description>
          Every new project starts in Draft. Fields marked <span className="text-danger">*</span>{' '}
          are required before it can leave Draft (Project Registration&apos;s hard gate) — the
          project can be saved as a Draft without them.
        </Description>
      </Header>

      <div className={variant === 'dialog' ? 'my-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1' : 'my-4 space-y-5'}>
        <fieldset className="space-y-3">
          <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
            Identity
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="reg-name" error={errors.name?.message} required>
              <Input id="reg-name" aria-invalid={errors.name ? true : undefined} {...register('name')} />
            </Field>
            <Field label="External code" htmlFor="reg-external-code" error={errors.external_code?.message}>
              <Input id="reg-external-code" {...register('external_code')} />
            </Field>
            <Field label="Hub" htmlFor="reg-hub" required>
              <Select value={hubId} onValueChange={setHubId}>
                <SelectTrigger id="reg-hub" className="h-8">
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
            <Field label={<>Leader{requiredMark('leader_engineer_id')}</>} htmlFor="reg-leader">
              <Select value={leaderId} onValueChange={setLeaderId} disabled={!hubId}>
                <SelectTrigger id="reg-leader" className="h-8">
                  <SelectValue placeholder={hubId ? 'Select a leader' : 'Select a hub first'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unassigned</SelectItem>
                  {(engineersQuery.data ?? []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label={<>Category{requiredMark('category')}</>}
              htmlFor="reg-category"
              hint={
                selectedHub
                  ? selectedHub.is_oem
                    ? 'OEM hub — OEM workflow categories'
                    : 'PDD workflow categories'
                  : 'Select a hub to narrow the list'
              }
            >
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="reg-category" className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unset</SelectItem>
                  {categoryOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={<>Type{requiredMark('type')}</>} htmlFor="reg-type">
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="reg-type" className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unset</SelectItem>
                  {PROJECT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {PROJECT_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Priority" htmlFor="reg-priority">
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger id="reg-priority" className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unset</SelectItem>
                  {PROJECT_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label={<>Actual start week{requiredMark('actual_start_week')}</>}
              htmlFor="reg-start-week"
              error={errors.actual_start_week?.message}
            >
              <Input
                id="reg-start-week"
                type="number"
                min={1}
                max={78}
                inputMode="numeric"
                className="tnum"
                aria-invalid={errors.actual_start_week ? true : undefined}
                {...register('actual_start_week')}
              />
            </Field>
            <Field label="Delay (weeks)" htmlFor="reg-delay" error={errors.delay_weeks?.message}>
              <Input
                id="reg-delay"
                type="number"
                min={0}
                inputMode="numeric"
                className="tnum"
                aria-invalid={errors.delay_weeks ? true : undefined}
                {...register('delay_weeks')}
              />
            </Field>
            <Field label="Registration year" htmlFor="reg-year" error={errors.reg_year?.message}>
              <Input
                id="reg-year"
                type="number"
                inputMode="numeric"
                className="tnum"
                aria-invalid={errors.reg_year ? true : undefined}
                {...register('reg_year')}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs text-text">
            <Checkbox checked={carryOver} onCheckedChange={(next) => setCarryOver(next === true)} />
            Carried over from a prior year
          </label>
        </fieldset>

        {/* A top border + top padding marks this as its own section rather than
            a continuation of Identity — matching the existing separation between
            the Financial section below and everything above it. The P9 planning
            fields (target end week, certification, estimated weeks) get the same
            first-class treatment as every other field group, not an appended one. */}
        <fieldset className="space-y-3 border-t border-border pt-5">
          <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
            Planning
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Expected completion (week)"
              htmlFor="reg-target-end-week"
              error={errors.target_end_week?.message}
              hint={`Week 1–${String(HORIZON_WEEKS)}. Drawn as the "Expected completion" line on the timeline; leave empty to use the process-derived finish.`}
            >
              <Input
                id="reg-target-end-week"
                type="number"
                min={1}
                max={HORIZON_WEEKS}
                inputMode="numeric"
                className="tnum"
                aria-invalid={errors.target_end_week ? true : undefined}
                {...register('target_end_week')}
              />
            </Field>
            <div className="flex flex-col gap-1">
              {/* An empty label-height spacer, not text, keeps this control's
                  checkbox row aligned with the <Input> baseline of its siblings
                  in the grid without duplicating/renaming the accessible name
                  tested at "Certification testing required". */}
              <span className="block h-4" aria-hidden="true" />
              <label className="flex h-8 items-center gap-2 text-xs text-text">
                <Checkbox
                  checked={certificationTesting}
                  onCheckedChange={(next) => setCertificationTesting(next === true)}
                  aria-describedby="reg-cert-hint"
                />
                Certification testing required
              </label>
              <span id="reg-cert-hint" className="pl-6 text-2xs text-text-subtle">
                Lab steps are skipped when off.
              </span>
            </div>
            <Field
              label="Estimated design weeks"
              htmlFor="reg-est-design"
              error={errors.estimated_design_weeks?.message}
              hint="Capacity “Estimated” column only — never changes the schedule."
            >
              <Input
                id="reg-est-design"
                type="number"
                min={0}
                step="0.5"
                inputMode="decimal"
                className="tnum"
                aria-invalid={errors.estimated_design_weeks ? true : undefined}
                {...register('estimated_design_weeks')}
              />
            </Field>
            <Field
              label="Estimated lab weeks"
              htmlFor="reg-est-lab"
              error={errors.estimated_lab_weeks?.message}
              hint="Capacity “Estimated” column only — never changes the schedule."
            >
              <Input
                id="reg-est-lab"
                type="number"
                min={0}
                step="0.5"
                inputMode="decimal"
                className="tnum"
                aria-invalid={errors.estimated_lab_weeks ? true : undefined}
                {...register('estimated_lab_weeks')}
              />
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-3 border-t border-border pt-5">
          <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
            Financial — commercially sensitive
          </legend>
          <p className="text-2xs text-text-muted">
            Encrypted at rest and excluded from application logs and audit-log entries. Visible
            here only because your role has write access to Project Registration.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Customer name" htmlFor="reg-customer" error={errors.customer_name?.message}>
              <Input id="reg-customer" {...register('customer_name')} />
            </Field>
            <Field
              label={<>TCOGS (EUR){requiredMark('tcogs_eur')}</>}
              htmlFor="reg-tcogs"
              error={errors.tcogs_eur?.message}
            >
              <Input
                id="reg-tcogs"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                className="tnum"
                aria-invalid={errors.tcogs_eur ? true : undefined}
                {...register('tcogs_eur')}
              />
            </Field>
            <Field
              label={<>Selling price (EUR){requiredMark('selling_price_eur')}</>}
              htmlFor="reg-selling-price"
              error={errors.selling_price_eur?.message}
            >
              <Input
                id="reg-selling-price"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                className="tnum"
                aria-invalid={errors.selling_price_eur ? true : undefined}
                {...register('selling_price_eur')}
              />
            </Field>
            <Field
              label={<>Gross margin (%){requiredMark('gross_margin_pct')}</>}
              htmlFor="reg-gross-margin"
              error={errors.gross_margin_pct?.message}
            >
              <Input
                id="reg-gross-margin"
                type="number"
                step="0.01"
                inputMode="decimal"
                className="tnum"
                aria-invalid={errors.gross_margin_pct ? true : undefined}
                {...register('gross_margin_pct')}
              />
            </Field>
            <Field label="CAPEX (kEUR)" htmlFor="reg-capex" error={errors.capex_keur?.message}>
              <Input
                id="reg-capex"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                className="tnum"
                aria-invalid={errors.capex_keur ? true : undefined}
                {...register('capex_keur')}
              />
            </Field>
            <Field
              label="RM savings (kEUR)"
              htmlFor="reg-rm-savings"
              error={errors.rm_savings_keur?.message}
            >
              <Input
                id="reg-rm-savings"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                className="tnum"
                aria-invalid={errors.rm_savings_keur ? true : undefined}
                {...register('rm_savings_keur')}
              />
            </Field>
          </div>
        </fieldset>

        {/* P9-R03 (qa Q-F3, axe `label`, critical): a single control needs a real
            <label htmlFor>. A <fieldset><legend> names a GROUP, not the textarea,
            so the textarea had no accessible name. Styled like the section legends. */}
        <div className="space-y-2">
          <Label
            htmlFor="reg-comments"
            className="block text-2xs font-semibold uppercase tracking-wide text-text-muted"
          >
            Comments
          </Label>
          <textarea
            id="reg-comments"
            rows={3}
            className="flex w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            {...register('comments')}
          />
        </div>
      </div>

      {submitError ? (
        <p role="alert" className="mb-2 text-2xs text-danger">
          {submitError}
        </p>
      ) : null}

      <Footer>
        <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : mode === 'create' ? 'Create draft' : 'Save changes'}
        </Button>
      </Footer>
    </form>
  );
}

function InlineHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-1">{children}</div>;
}
function InlineTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className="text-h2 text-text">{children}</h3>;
}
function InlineDescription({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-2xs text-text-muted">{children}</p>;
}
function InlineFooter({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex justify-end gap-2">{children}</div>;
}

function Field({
  label,
  htmlFor,
  error,
  required,
  hint,
  children,
}: {
  label: React.ReactNode;
  htmlFor: string;
  error?: string | undefined;
  required?: boolean | undefined;
  /** Helper text under the control (P9 planning fields). */
  hint?: string | undefined;
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
      ) : hint ? (
        <span className="text-2xs text-text-subtle">{hint}</span>
      ) : null}
    </div>
  );
}
