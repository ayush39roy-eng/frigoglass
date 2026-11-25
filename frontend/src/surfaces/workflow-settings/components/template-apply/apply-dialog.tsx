import * as React from 'react';
import { ChevronDown, Search, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import { formatInteger } from '@/lib/format';
import { compileSearch } from '@/lib/project-search';
import { cn } from '@/lib/utils';

import type {
  ApplyPreviewChoosableProject,
  ApplyPreviewNeverProject,
  ApplyPreviewOwnEffortProject,
  ApplyPreviewProject,
  ApplyPreviewResponse,
  ApplyPreviewStep,
  ApplySelection,
} from '../../api/types';
import type { ApplyFlow } from '../../hooks/use-template-apply';
import { holdText, signedWeeks } from '../../lib/template-drafts';
import { APPLY_FLAG_NOTE, NEVER_REASON, projects, TEMPLATE_COPY } from '../../lib/template-copy';
import { ProjectRows } from './project-rows';

type DialogFlow = Extract<ApplyFlow, { kind: 'checking' | 'review' | 'applying' | 'refused' }>;

/**
 * P33-T17: the apply dialog (ADR 0045 §2, API_CONTRACT_P33 E2 / Part I).
 * Four sections from the served apply preview:
 *   Updated automatically — not started, always follow the template;
 *   Choose               — started but not at the changed steps: all, or ticks;
 *   Uses its own weeks   — own effort figure, length not changed (OR-4);
 *   Not changed          — frozen / closed / already reached (collapsed).
 * Every count, list and before → after is a served field (I9).
 */
export function ApplyDialog({
  flow,
  onApply,
  onBack,
  onClose,
}: {
  flow: DialogFlow | null;
  onApply: (selection: ApplySelection) => void;
  onBack: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const open = flow !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="template-apply-dialog">
        <DialogHeader>
          <DialogTitle>Save template changes</DialogTitle>
          <DialogDescription>Check which projects these changes reach. Nothing is saved until you press Apply.</DialogDescription>
        </DialogHeader>
        {flow?.options.notice ? (
          <p
            role="note"
            className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-fg"
            data-testid="template-apply-notice"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {flow.options.notice}
          </p>
        ) : null}
        {flow ? <ChangeSummary lines={flow.options.summary} /> : null}
        {flow?.kind === 'checking' ? (
          <div className="space-y-2" aria-busy="true">
            <p role="status" className="text-xs text-text-muted">
              Checking which projects these changes reach…
            </p>
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}
        {flow?.kind === 'refused' ? (
          <>
            <p role="alert" className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg" data-testid="template-apply-error">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {flow.message}
            </p>
            <DialogFooter>
              {flow.preview && !flow.reloaded ? (
                <Button type="button" variant="ghost" onClick={onBack}>
                  Back
                </Button>
              ) : null}
              <Button type="button" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : null}
        {flow?.kind === 'review' || flow?.kind === 'applying' ? (
          <ReviewBody key={previewKey(flow.preview)} preview={flow.preview} applying={flow.kind === 'applying'} onApply={onApply} onCancel={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function previewKey(p: ApplyPreviewResponse): string {
  return p.choosable.map((c) => c.project_id).join(',');
}

function ChangeSummary({ lines }: { lines: string[] }): React.JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <ul aria-label="Changes to save" className="space-y-0.5 rounded-md bg-surface-sunken px-3 py-2 text-xs text-text" data-numeric="">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

function ReviewBody({
  preview,
  applying,
  onApply,
  onCancel,
}: {
  preview: ApplyPreviewResponse;
  applying: boolean;
  onApply: (selection: ApplySelection) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [mode, setMode] = React.useState<'all' | 'choose'>('choose');
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(new Set());
  const { counts } = preview;
  const chosen = mode === 'all' ? counts.choosable : ticked.size;

  const selection = (): ApplySelection => {
    if (mode === 'all' && counts.choosable > 0) return { mode: 'all_not_reached', project_ids: [] };
    if (mode === 'choose' && ticked.size > 0) return { mode: 'selected', project_ids: [...ticked] };
    return { mode: 'none', project_ids: [] };
  };

  return (
    <>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-numeric="" data-testid="apply-counts">
        <Count label="Updated automatically" value={counts.automatic} />
        <Count label="You choose" value={counts.choosable} />
        <Count label="Use their own weeks" value={counts.own_effort} />
        <Count label="Not changed" value={counts.never} />
      </dl>

      <Section title="Updated automatically" count={counts.automatic} help={TEMPLATE_COPY.automaticHelp} testId="apply-automatic">
        <ProjectRows
          rows={preview.automatic}
          rowKey={(p) => p.project_id}
          label="Projects updated automatically"
          renderRow={(p: ApplyPreviewProject) => <ProjectLine name={p.name} hub={p.hub} detail={p.status} steps={p.steps} />}
        />
      </Section>

      <ChooseSection preview={preview} mode={mode} setMode={setMode} ticked={ticked} setTicked={setTicked} />

      <Section title={TEMPLATE_COPY.ownEffortTitle} count={counts.own_effort} help={TEMPLATE_COPY.ownEffortHelp} testId="apply-own-effort">
        <ProjectRows
          rows={preview.own_effort}
          rowKey={(p) => p.project_id}
          label="Projects that use their own weeks"
          renderRow={(p: ApplyPreviewOwnEffortProject) => (
            <ProjectLine name={p.name} hub={p.hub} detail={p.status} note={`${p.step_ids.join(', ')}: ${APPLY_FLAG_NOTE.own_effort_length_not_applied}`} />
          )}
        />
      </Section>

      <Section title={TEMPLATE_COPY.neverTitle} count={counts.never} help={TEMPLATE_COPY.neverHelp} testId="apply-never">
        <ProjectRows
          rows={preview.never}
          rowKey={(p) => `${p.project_id}-${p.reason}`}
          label="Projects not changed"
          renderRow={(p: ApplyPreviewNeverProject) => (
            <ProjectLine name={p.name} hub={p.hub} detail={NEVER_REASON[p.reason]} note={p.reason === 'reached_stage' ? `Already reached: ${p.step_ids.join(', ')}` : undefined} />
          )}
        />
      </Section>

      <DialogFooter className="items-center sm:justify-between">
        <p className="text-xs text-text-muted" data-testid="apply-footer-summary" data-numeric="">
          Changes {projects(counts.automatic)} automatically
          {counts.choosable > 0 ? ` and ${projects(chosen)} you chose` : ''}.
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={applying}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onApply(selection())} disabled={applying} data-testid="apply-confirm">
            {applying ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function Count({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <dt className="text-2xs text-text-muted">{label}</dt>
      <dd className="text-lg font-bold text-text">{formatInteger(value)}</dd>
    </div>
  );
}

/** A collapsible section; empty sections say so and cannot open. */
function Section({
  title,
  count,
  help,
  testId,
  children,
}: {
  title: string;
  count: number;
  help: string;
  testId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const headingId = React.useId();
  const panelId = React.useId();
  return (
    <section aria-labelledby={headingId} className="space-y-1.5" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-text">
          {title} <span className="font-normal text-text-muted" data-numeric="">({formatInteger(count)})</span>
        </h3>
        {count > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-primary hover:bg-primary-subtle/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown aria-hidden="true" className={cn('size-3.5 transition-transform motion-reduce:transition-none', !open && '-rotate-90')} />
            {open ? 'Hide projects' : `Show ${projects(count)}`}
          </button>
        ) : null}
      </div>
      <p className="text-2xs text-text-muted">{count > 0 ? help : 'None.'}</p>
      {open && count > 0 ? <div id={panelId}>{children}</div> : null}
    </section>
  );
}

function ChooseSection({
  preview,
  mode,
  setMode,
  ticked,
  setTicked,
}: {
  preview: ApplyPreviewResponse;
  mode: 'all' | 'choose';
  setMode: (m: 'all' | 'choose') => void;
  ticked: ReadonlySet<string>;
  setTicked: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
}): React.JSX.Element {
  const headingId = React.useId();
  const searchId = React.useId();
  const [query, setQuery] = React.useState('');
  const n = preview.counts.choosable;
  // P51-T02: the shared project search (`*` / `?` wildcards, everything else literal).
  const search = compileSearch(query);
  const shown = search ? preview.choosable.filter((p) => search(p.name, p.hub)) : preview.choosable;

  const toggle = (id: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <section aria-labelledby={headingId} className="space-y-2 rounded-md border border-primary/30 bg-primary-subtle/20 p-3" data-testid="apply-choosable">
      <h3 id={headingId} className="text-sm font-semibold text-text">
        Choose <span className="font-normal text-text-muted" data-numeric="">({formatInteger(n)})</span>
      </h3>
      <p className="text-2xs text-text-muted">{n > 0 ? TEMPLATE_COPY.choosableHelp : 'None.'}</p>
      {n > 0 ? (
        <>
          <fieldset className="flex flex-col gap-1.5 text-sm">
            <legend className="sr-only">Which started projects get the change</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="apply-mode" value="all" checked={mode === 'all'} onChange={() => setMode('all')} className="size-4 accent-[hsl(var(--color-primary))]" />
              Apply to all {projects(n)} that have not reached these stages
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="apply-mode" value="choose" checked={mode === 'choose'} onChange={() => setMode('choose')} className="size-4 accent-[hsl(var(--color-primary))]" />
              Choose projects
              <span className="text-2xs text-text-muted" data-numeric="">
                ({formatInteger(ticked.size)} chosen)
              </span>
            </label>
          </fieldset>
          {mode === 'choose' ? (
            <div className="space-y-1.5">
              <div className="relative">
                <label htmlFor={searchId} className="sr-only">
                  Search projects to choose
                </label>
                <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle" />
                <Input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by project or hub" className="pl-7" />
              </div>
              <div className="flex gap-2 text-2xs">
                <button type="button" className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary-subtle/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setTicked((prev) => new Set([...prev, ...shown.map((p) => p.project_id)]))}>
                  Tick all shown
                </button>
                <button type="button" className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary-subtle/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setTicked(new Set())}>
                  Clear
                </button>
              </div>
              {shown.length === 0 ? (
                <p className="text-2xs text-text-muted">No project matches “{query}”.</p>
              ) : (
                <ProjectRows
                  rows={shown}
                  rowKey={(p) => p.project_id}
                  label="Started projects you can choose"
                  testId="apply-choose-list"
                  renderRow={(p: ApplyPreviewChoosableProject) => (
                    <label className="flex cursor-pointer items-start gap-2">
                      <Checkbox className="mt-0.5" checked={ticked.has(p.project_id)} onCheckedChange={(v) => toggle(p.project_id, v === true)} aria-label={`Apply to ${p.name}`} />
                      <ProjectLine name={p.name} hub={p.hub} detail={stageText(p)} steps={p.steps} />
                    </label>
                  )}
                />
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function stageText(p: ApplyPreviewChoosableProject): string {
  const s = p.current_stage;
  if (!s) return p.status;
  const status = s.status === 'Blocked' ? 'On Hold' : s.status;
  return `Now at ${s.step_id} ${s.name} (${status})`;
}

function ProjectLine({
  name,
  hub,
  detail,
  steps,
  note,
}: {
  name: string;
  hub: string;
  detail: string;
  steps?: ApplyPreviewStep[];
  note?: string | undefined;
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold text-text">{name}</span>
        <span className="text-text-muted">{hub}</span>
        <span className="text-text-subtle">{detail}</span>
      </span>
      {steps && steps.length > 0 ? <StepChanges steps={steps} /> : null}
      {note ? <span className="text-2xs text-text-muted">{note}</span> : null}
    </span>
  );
}

/** "PDD-E 4w → 5w · gap 0w → −2w · room Full → 1w" plus the R33-11 / P62 flag notes, from served fields. */
function StepChanges({ steps }: { steps: ApplyPreviewStep[] }): React.JSX.Element {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-text-muted" data-numeric="" data-testid="apply-step-changes">
      {steps.map((s) => (
        <span key={s.step_id} className="inline-flex flex-wrap items-center gap-1">
          <span className="font-mono font-semibold text-text">{s.step_id}</span>
          {s.eff_before !== s.eff_after ? (
            <span>
              {s.eff_before}w → {s.eff_after}w
            </span>
          ) : null}
          {s.gap_before !== s.gap_after ? (
            <span>
              gap {signedWeeks(s.gap_before)}w → {signedWeeks(s.gap_after)}w
            </span>
          ) : null}
          {s.hold_before !== s.hold_after ? (
            <span data-testid="apply-step-room">
              room weeks {holdText(s.hold_before)} → {holdText(s.hold_after)}
            </span>
          ) : null}
          {s.flags.map((f) => (
            <Badge key={f} tone="warning" className="whitespace-nowrap" data-testid={`apply-flag-${f}`}>
              {APPLY_FLAG_NOTE[f]}
            </Badge>
          ))}
        </span>
      ))}
    </span>
  );
}
