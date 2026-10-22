import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Eye, Plus, RefreshCw, Save, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

import type { ScoringRubric, ScoringRubricPreview } from '../../api/types';
import { usePreviewScoringRubric, useSaveScoringRubric } from '../../hooks/use-matrix';
import {
  RUBRIC_LIMITS,
  WEIGHT_ERROR,
  addDimension,
  changedFields,
  draftActiveTotal,
  draftFromRubric,
  draftPillars,
  groupDraft,
  mapRubricError,
  moveBefore,
  movePillar,
  moveToPillarEnd,
  moveDimension,
  draftPillarWeights,
  orderedDraft,
  parseWeight,
  rebaseDraft,
  removeNewDimension,
  servedOrderIsGrouped,
  toDimensionInputs,
  updateDimension,
  validateDraft,
  type DraftDimension,
  type MappedRubricError,
  type RebaseChoice,
  type RebaseField,
  type RebaseResult,
  type RubricDraft,
} from '../../lib/rubric-draft';
import { pillarTinted } from '../../lib/grid-boxes';
import '../rubric-pillars.css';
import { DimensionRow, NEW_PILLAR } from './rubric-dimension-row';
import { RubricPreviewPanel } from './rubric-preview-panel';

/**
 * P26 (ADR 0037), inline since P26-T03: the rubric editor of the Prioritization
 * Matrix, shown in place of the dimensions table inside the "Scoring scale and
 * dimensions" card when an Admin / Super Admin (served `can_edit`) clicks
 * "Edit rubric". The card owns the draft and edit mode; this component edits it:
 *
 * - dimensions grouped by pillar, in display order: label, pillar (or a new
 *   one), weight 1..100, inverted, active; reorder by drag or Move up / down;
 *   add a dimension; deactivate / reactivate (never delete; scores are kept);
 *   the grid scrolls inside the card;
 * - validation mirroring the server's coded 422s on the fields;
 * - "Preview impact" (`POST /scoring-rubric/preview`, served figures only), in
 *   an expandable panel below the grid;
 * - a footer (sticky inside the card from `sm` up; on phones it follows the list,
 *   one page scroll): live total weight, the required reason, "Preview impact",
 *   "Save new version" (`PUT /scoring-rubric` with `version` and the reason) and
 *   "Cancel". A 409 `RUBRIC_VERSION_CONFLICT` offers a reload that keeps the
 *   draft for comparison and can re-apply it on the latest version: only the
 *   Admin's own changes (draft vs the version it was edited from) are applied,
 *   and conflicting fields are chosen per field, defaulting to the server value
 *   (QA-F26-1).
 *
 * The only arithmetic is the draft's live total of active weights; scores,
 * bands and scaled weights are served (I9).
 */
export interface RubricEditorProps {
  rubric: ScoringRubric;
  draft: RubricDraft;
  dirty: boolean;
  onDraftChange: (dims: DraftDimension[]) => void;
  onReplaceDraft: (draft: RubricDraft, dirty: boolean) => void;
  refetch: () => Promise<ScoringRubric | undefined>;
  /** Cancel was pressed (the card asks before discarding a changed draft). */
  onCancel: () => void;
  /** A save returned: the card leaves edit mode and shows `message`. */
  onSaved: (message: string) => void;
  /** The scrolling dimensions region (focused on entering edit mode). */
  regionRef?: React.Ref<HTMLDivElement>;
}

const EMPTY_MAPPED: MappedRubricError = { fields: {}, form: [], reason: null };

export function RubricEditor({
  rubric,
  draft,
  dirty,
  onDraftChange,
  onReplaceDraft,
  refetch,
  onCancel,
  onSaved,
  regionRef,
}: RubricEditorProps): React.JSX.Element {
  const editable = rubric.can_edit;
  const queryClient = useQueryClient();
  const previewMutation = usePreviewScoringRubric();
  const saveMutation = useSaveScoringRubric();
  const [reason, setReason] = React.useState('');
  const [preview, setPreview] = React.useState<{ data: ScoringRubricPreview; inputs: string } | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(true);
  const [server, setServer] = React.useState<MappedRubricError>(EMPTY_MAPPED);
  const [submitted, setSubmitted] = React.useState(false);
  const [conflict, setConflict] = React.useState<string | null>(null);
  const [comparison, setComparison] = React.useState<{ mine: DraftDimension[]; base: ScoringRubric } | null>(null);
  const [choices, setChoices] = React.useState<Record<string, RebaseChoice>>({});
  const [status, setStatus] = React.useState('');
  const [announce, setAnnounce] = React.useState('');
  const [newSeq, setNewSeq] = React.useState(1);
  const [addedNames, setAddedNames] = React.useState<Record<string, string>>({});
  const servedLabel = new Map(rubric.dimensions.map((d) => [d.key, d.label]));
  const stableName = (d: DraftDimension) =>
    (d.key !== null ? servedLabel.get(d.key) : addedNames[d.uid]) ?? (d.label.trim() || 'new dimension');
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const previewBodyId = React.useId();

  const focusMap = React.useRef(new Map<string, HTMLElement>());
  const pendingFocus = React.useRef<string | null>(null);
  const registerFocus = React.useCallback((id: string, el: HTMLElement | null) => {
    if (el) focusMap.current.set(id, el);
    else focusMap.current.delete(id);
  }, []);
  React.useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    focusMap.current.get(id)?.focus();
  });

  const dims = draft.dimensions;
  const groups = groupDraft(dims);
  const pillars = draftPillars(dims);
  const validation = validateDraft(dims);
  const inputsKey = JSON.stringify(toDimensionInputs(dims));
  const previewStale = preview !== null && preview.inputs !== inputsKey;
  const proposedTotal = draftActiveTotal(dims);
  const pillarWeights = draftPillarWeights(dims);
  const servedScaled = new Map(
    (preview && !previewStale ? preview.data.dimensions : rubric.dimensions).map((d) => [d.key, d.scaled_weight]),
  );
  const reasonError =
    server.reason ?? (submitted && reason.trim() === '' ? 'A reason is required to save a new version' : reason.trim().length > RUBRIC_LIMITS.reasonMax ? `At most ${String(RUBRIC_LIMITS.reasonMax)} characters` : null);
  const fieldErrors = (uid: string) => {
    const client = validation.fields[uid];
    const srv = server.fields[uid];
    return client || srv ? { ...(srv ?? {}), ...(client ?? {}) } : undefined;
  };
  const formErrors = [...new Set([...validation.form, ...server.form])];

  const change = (next: DraftDimension[]) => {
    setServer(EMPTY_MAPPED);
    setStatus('');
    onDraftChange(next);
  };

  const move = (d: DraftDimension, dir: -1 | 1) => {
    // P26-T03: at the end of a pillar the move crosses into the neighbouring pillar.
    const next = moveDimension(dims, d.uid, dir);
    const moved = next.find((x) => x.uid === d.uid) ?? d;
    const group = groupDraft(next).find((g) => g.pillar === moved.pillar);
    const pos = (group?.items.findIndex((x) => x.uid === d.uid) ?? 0) + 1;
    const ordered = orderedDraft(next);
    const at = ordered.findIndex((x) => x.uid === d.uid);
    pendingFocus.current = `${d.uid}-${dir === -1 ? 'up' : 'down'}`;
    // At the very ends, keep focus on the other button (this one becomes unavailable).
    if ((dir === -1 && at === 0) || (dir === 1 && at === ordered.length - 1)) {
      pendingFocus.current = `${d.uid}-${dir === -1 ? 'down' : 'up'}`;
    }
    const crossed = moved.pillar !== d.pillar ? ` into ${moved.pillar}` : '';
    setAnnounce(
      `${stableName(d)} moved ${dir === -1 ? 'up' : 'down'}${crossed}: position ${String(pos)} of ${String(group?.items.length ?? 1)} in ${moved.pillar}.`,
    );
    change(next);
  };

  const doPreview = async () => {
    setSubmitted(false);
    setStatus('');
    if (!validation.valid) {
      setStatus('Fix the highlighted fields before previewing.');
      return;
    }
    const sent = orderedDraft(dims);
    try {
      const data = await previewMutation.mutateAsync({ dimensions: toDimensionInputs(sent) });
      setServer(EMPTY_MAPPED);
      setPreview({ data, inputs: inputsKey });
      setPreviewOpen(true);
      setStatus('Preview ready, below the dimensions. Nothing is saved.');
    } catch (err) {
      handleError(err, sent);
    }
  };

  const handleError = (err: unknown, sent: DraftDimension[]) => {
    if (err instanceof ApiError && err.status === 409 && err.code === 'RUBRIC_VERSION_CONFLICT') {
      setConflict(err.detail ?? 'The rubric was changed by someone else.');
      setStatus('Someone else changed the rubric; reload and re-apply.');
      return;
    }
    if (err instanceof ApiError && err.status === 422) {
      setServer(mapRubricError(err.code, err.detail, sent));
      setStatus('The server rejected the rubric; see the highlighted fields.');
      return;
    }
    if (err instanceof ApiError && err.isForbidden) {
      setStatus('Your role cannot edit the scoring rubric.');
      return;
    }
    setStatus('The request failed. Please try again.');
  };

  const doSave = async () => {
    setSubmitted(true);
    setStatus('');
    if (!validation.valid || reason.trim() === '' || reason.trim().length > RUBRIC_LIMITS.reasonMax) {
      setStatus('Fix the highlighted fields before saving.');
      return;
    }
    const sent = orderedDraft(dims);
    try {
      const saved = await saveMutation.mutateAsync({
        version: draft.baseVersion,
        reason: reason.trim(),
        dimensions: toDimensionInputs(sent),
      });
      queryClient.setQueryData(queryKeys.scoringRubric(), saved);
      onReplaceDraft(draftFromRubric(saved), false);
      onSaved(
        saved.version === draft.baseVersion
          ? `Nothing changed: the rubric is still version ${String(saved.version)}.`
          : `Saved as version ${String(saved.version)}. Every project's score was recomputed; the schedule is unchanged.`,
      );
    } catch (err) {
      handleError(err, sent);
    }
  };

  const reload = async () => {
    // QA-F26-1: keep the version the draft was edited from, so only the Admin's own changes are re-applied.
    const mine = orderedDraft(dims);
    const base = draft.base;
    const latest = await refetch();
    if (!latest) return;
    setComparison({ mine, base });
    setChoices({});
    setConflict(null);
    setPreview(null);
    onReplaceDraft(draftFromRubric(latest), false);
    setStatus(`Reloaded version ${String(latest.version)}. Your draft is kept above the dimensions for comparison.`);
  };

  const rebased = comparison ? rebaseDraft(comparison.mine, comparison.base, rubric, choices) : null;

  const reapply = () => {
    if (!rebased) return;
    const kept = rebased.conflicts.filter((c) => (choices[c.id] ?? 'current') === 'current').length;
    onReplaceDraft(rebased.draft, true);
    setComparison(null);
    setChoices({});
    setStatus(
      `Your changes are re-applied on version ${String(rubric.version)}${
        kept > 0 ? ` (${String(kept)} ${kept === 1 ? 'conflict keeps' : 'conflicts keep'} the current value)` : ''
      }. Preview and save it again.`,
    );
  };

  const onDrop = (targetUid: string) => {
    if (dragging !== null) {
      const d = dims.find((x) => x.uid === dragging);
      const target = dims.find((x) => x.uid === targetUid);
      if (d && target && d.uid !== target.uid) {
        change(moveBefore(dims, dragging, targetUid));
        setAnnounce(
          `${d.label} moved before ${target.label}${d.pillar !== target.pillar ? `, into ${target.pillar}` : ''}.`,
        );
      }
    }
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="flex flex-col" data-testid="rubric-inline-editor">
      <div
        ref={regionRef}
        className="space-y-4 px-card py-s3 sm:max-h-[min(60vh,40rem)] sm:overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        role="region"
        aria-label={`Editing the rubric (version ${String(draft.baseVersion)})`}
        tabIndex={0}
        data-testid="rubric-editor"
      >
        <p className="sr-only" role="status" aria-live="polite" data-testid="rubric-announce">
          {announce}
        </p>
        <p className="text-2xs text-text-muted">
          Weights are scaled to 100: each active dimension counts weight × 100 ÷ the total of active weights. The server
          computes every score; inactive dimensions do not count. Every save is a new, audited version and recomputes
          every score; the schedule is not touched.
        </p>
        {editable && !servedOrderIsGrouped(rubric) ? (
          <p className="text-2xs text-text-muted" data-testid="rubric-order-note">
            The stored order of version {rubric.version} does not keep every pillar together. The list below (and the
            Matrix grid) shows each pillar together; saving a new version stores this grouped order.
          </p>
        ) : null}

        {conflict ? (
          <div role="alert" className="space-y-2 rounded border border-warning/50 bg-warning-subtle px-3 py-2 text-xs text-text" data-testid="rubric-conflict">
            <p className="font-semibold">Someone else changed the rubric; reload and re-apply.</p>
            <p className="text-text-muted">{conflict}</p>
            <Button type="button" size="sm" variant="secondary" onClick={() => void reload()} className="h-auto whitespace-normal py-1 text-left">
              <RefreshCw aria-hidden="true" />
              Reload latest version (keep my draft for comparison)
            </Button>
          </div>
        ) : null}

        {rebased ? (
          <RebasePanel
            result={rebased}
            latest={rubric}
            choices={choices}
            onChoose={(id, choice) => setChoices((m) => ({ ...m, [id]: choice }))}
            onReapply={reapply}
            onDismiss={() => {
              setComparison(null);
              setChoices({});
            }}
            editable={editable}
          />
        ) : null}

        {formErrors.length > 0 ? (
          <ul role="alert" className="space-y-0.5 rounded border border-danger/40 bg-danger-subtle px-3 py-2 text-xs text-danger-subtle-fg" data-testid="rubric-form-errors">
            {formErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}

        <div className="mg-pillar-scope rp-stack overflow-hidden rounded border-2 border-border-strong/60 bg-surface" data-testid="rubric-pillar-stack">
        {groups.map((group, gi) => (
          <section
            key={group.pillar}
            aria-labelledby={`pillar-${String(gi)}`}
            className="rp-section"
            data-tint={pillarTinted(gi)}
            data-testid="rubric-pillar"
            data-pillar={group.pillar}
          >
            <header className="rp-pillar-cell flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
              <h4 id={`pillar-${String(gi)}`} className="text-sm text-text">
                <span className="rp-pillar-name font-bold">{group.pillar}</span>{' '}
                <span className="tnum ml-1 text-2xs font-normal text-text-muted" data-numeric="" data-testid="rubric-pillar-draft-summary">
                  · {group.items.length} {group.items.length === 1 ? 'dimension' : 'dimensions'} · weight{' '}
                  {pillarWeights.get(group.pillar) ?? 0}
                  {dirty ? ' (draft)' : ''}
                </span>
              </h4>
              {editable && groups.length > 1 ? (
                <span className="flex gap-0.5" role="group" aria-label={`Order of pillar ${group.pillar}`}>
                  <Button
                    ref={(el) => registerFocus(`pillar-${group.pillar}-up`, el)}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn('h-6 px-1.5', gi === 0 && 'cursor-not-allowed opacity-40')}
                    aria-disabled={gi === 0}
                    aria-label={`Move pillar ${group.pillar} up`}
                    onClick={() => {
                      if (gi === 0) return;
                      pendingFocus.current = gi - 1 === 0 ? `pillar-${group.pillar}-down` : `pillar-${group.pillar}-up`;
                      setAnnounce(`Pillar ${group.pillar} moved up.`);
                      change(movePillar(dims, group.pillar, -1));
                    }}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    ref={(el) => registerFocus(`pillar-${group.pillar}-down`, el)}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn('h-6 px-1.5', gi === groups.length - 1 && 'cursor-not-allowed opacity-40')}
                    aria-disabled={gi === groups.length - 1}
                    aria-label={`Move pillar ${group.pillar} down`}
                    onClick={() => {
                      if (gi === groups.length - 1) return;
                      pendingFocus.current = gi + 1 === groups.length - 1 ? `pillar-${group.pillar}-up` : `pillar-${group.pillar}-down`;
                      setAnnounce(`Pillar ${group.pillar} moved down.`);
                      change(movePillar(dims, group.pillar, 1));
                    }}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                </span>
              ) : null}
            </header>
            <ul
              aria-label={`${group.pillar} dimensions`}
              onDragOver={(e) => {
                if (dragging !== null) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const d = dims.find((x) => x.uid === dragging);
                if (d) {
                  change(moveToPillarEnd(dims, d.uid, group.pillar));
                  if (d.pillar !== group.pillar) setAnnounce(`${d.label} moved to the end of ${group.pillar}.`);
                }
                setDragging(null);
                setOver(null);
              }}
            >
              {group.items.map((d, i) => (
                <DimensionRow
                  key={d.uid}
                  dim={d}
                  name={stableName(d)}
                  position={i + 1}
                  groupSize={group.items.length}
                  atStart={gi === 0 && i === 0}
                  atEnd={gi === groups.length - 1 && i === group.items.length - 1}
                  editable={editable}
                  pillars={pillars}
                  errors={editable ? fieldErrors(d.uid) : undefined}
                  changed={changedFields(d, rubric)}
                  scaled={d.active ? (servedScaled.get(d.key ?? '') ?? null) : null}
                  onChange={(patch) => change(updateDimension(dims, d.uid, patch))}
                  onMove={(dir) => move(d, dir)}
                  onRemove={() => {
                    setAnnounce(`${d.label || 'New dimension'} removed.`);
                    change(removeNewDimension(dims, d.uid));
                  }}
                  registerFocus={registerFocus}
                  drag={{
                    dragging,
                    over,
                    onDragStart: setDragging,
                    onDragEnter: setOver,
                    onDrop,
                    onDragEnd: () => {
                      setDragging(null);
                      setOver(null);
                    },
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
        </div>

        {editable ? (
          <AddDimensionForm
            dims={dims}
            pillars={pillars}
            current={rubric.total_weight}
            proposed={proposedTotal}
            onAdd={(input) => {
              const uid = `new-${String(newSeq)}`;
              setNewSeq((n) => n + 1);
              setAddedNames((m) => ({ ...m, [uid]: input.label }));
              pendingFocus.current = `${uid}-label`;
              setAnnounce(`${input.label} added to ${input.pillar}.`);
              change(addDimension(dims, { uid, ...input }));
            }}
          />
        ) : null}
      </div>

      {preview ? (
        <div className="border-t-2 border-border px-card py-s3" data-testid="rubric-preview-wrap">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={previewOpen}
            aria-controls={previewBodyId}
            onClick={() => setPreviewOpen((v) => !v)}
            className="-ml-2 mb-2"
          >
            {previewOpen ? 'Hide impact preview' : 'Show impact preview'}
            {previewStale ? <span className="sr-only"> (out of date)</span> : null}
            <ChevronDown className={cn('transition-transform duration-fast motion-reduce:transition-none', previewOpen && 'rotate-180')} aria-hidden="true" />
          </Button>
          {previewOpen ? (
            <div id={previewBodyId}>
              <RubricPreviewPanel preview={preview.data} stale={previewStale} />
            </div>
          ) : null}
        </div>
      ) : null}

      <footer
        className="z-10 space-y-2 rounded-b-card sm:sticky sm:bottom-0 border-t-2 border-border bg-surface px-card py-s3 shadow-[0_-4px_12px_-8px_rgb(0_0_0/0.15)]"
        data-testid="rubric-footer"
      >
        <TotalsBar current={rubric.total_weight} proposed={dirty ? proposedTotal : null} />
        <div className="flex flex-col gap-0.5">
          <label htmlFor="rubric-reason" className="text-2xs font-medium text-text-muted">
            Reason for this change <span aria-hidden="true">*</span>
            <span className="sr-only"> (required)</span>
          </label>
          <textarea
            id="rubric-reason"
            value={reason}
            rows={2}
            maxLength={RUBRIC_LIMITS.reasonMax + 50}
            required
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? 'rubric-reason-error' : undefined}
            onChange={(e) => {
              setReason(e.target.value);
              setServer((s) => ({ ...s, reason: null }));
            }}
            placeholder="Why the rubric changes (recorded on the new version and in the audit log)"
            className="w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-xs text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-danger"
            data-testid="rubric-reason"
          />
          {reasonError ? (
            <span id="rubric-reason-error" className="text-2xs text-danger" data-testid="rubric-reason-error">
              {reasonError}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto min-w-0 basis-full text-2xs text-text-muted sm:basis-auto" role="status" data-testid="rubric-status">
            {status}
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} data-testid="rubric-cancel">
            <X aria-hidden="true" />
            Cancel
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void doPreview()} disabled={previewMutation.isPending}>
            <Eye aria-hidden="true" />
            {previewMutation.isPending ? 'Previewing…' : 'Preview impact'}
          </Button>
          <Button type="button" size="sm" onClick={() => void doSave()} disabled={saveMutation.isPending}>
            <Save aria-hidden="true" />
            {saveMutation.isPending ? 'Saving…' : 'Save new version'}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function TotalsBar({ current, proposed }: { current: number; proposed: number | null }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs" data-testid="rubric-totals" aria-live="polite">
      <span>
        Current total weight{' '}
        <strong className="tnum text-text" data-numeric="">
          {current}
        </strong>
      </span>
      {proposed !== null && proposed !== current ? (
        <span data-testid="rubric-proposed-total">
          Proposed (draft){' '}
          <strong className="tnum text-text" data-numeric="">
            {proposed}
          </strong>
        </span>
      ) : null}
      <span className="text-2xs text-text-muted">scaled to 100 on save</span>
    </div>
  );
}

function AddDimensionForm({
  dims,
  pillars,
  current,
  proposed,
  onAdd,
}: {
  dims: readonly DraftDimension[];
  pillars: readonly string[];
  current: number;
  proposed: number;
  onAdd: (input: { label: string; pillar: string; weight: string }) => void;
}): React.JSX.Element {
  const [label, setLabel] = React.useState('');
  const [pillarChoice, setPillarChoice] = React.useState(pillars[0] ?? NEW_PILLAR);
  const [newPillar, setNewPillar] = React.useState('');
  const [weight, setWeight] = React.useState('');
  const [errors, setErrors] = React.useState<{ label?: string; pillar?: string; weight?: string }>({});
  const pillar = pillarChoice === NEW_PILLAR ? newPillar.trim() : pillarChoice;
  const w = parseWeight(weight);
  const withNew = proposed + (w ?? 0);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    const l = label.trim();
    if (l === '') next.label = 'A label is required';
    else if (l.length > RUBRIC_LIMITS.labelMax) next.label = `At most ${String(RUBRIC_LIMITS.labelMax)} characters`;
    else if (dims.some((d) => d.label.trim().toLowerCase() === l.toLowerCase()))
      next.label = 'Another dimension has this label (labels must be unique)';
    if (pillar === '') next.pillar = 'Choose a pillar or name a new one';
    else if (pillar.length > RUBRIC_LIMITS.pillarMax) next.pillar = `At most ${String(RUBRIC_LIMITS.pillarMax)} characters`;
    if (w === null) next.weight = WEIGHT_ERROR;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onAdd({ label: l, pillar, weight: String(w) });
    setLabel('');
    setWeight('');
    setNewPillar('');
    if (pillarChoice === NEW_PILLAR) setPillarChoice(pillar);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-2 rounded-dash border-[1.5px] border-dashed border-border-strong bg-surface p-3" aria-labelledby="rubric-add-heading" data-testid="rubric-add-form">
      <h4 id="rubric-add-heading" className="text-sm font-semibold text-text">
        Add dimension
      </h4>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
          <label htmlFor="rubric-add-label" className="text-2xs font-medium text-text-muted">
            Label
          </label>
          <Input
            id="rubric-add-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-invalid={errors.label ? true : undefined}
            aria-describedby={errors.label ? 'rubric-add-label-error' : undefined}
            className="h-8 text-xs"
          />
          {errors.label ? (
            <span id="rubric-add-label-error" className="text-2xs text-danger">
              {errors.label}
            </span>
          ) : null}
        </div>
        <div className="flex w-44 flex-col gap-0.5">
          <label htmlFor="rubric-add-pillar" className="text-2xs font-medium text-text-muted">
            Pillar
          </label>
          <select
            id="rubric-add-pillar"
            value={pillarChoice}
            onChange={(e) => setPillarChoice(e.target.value)}
            className="h-8 rounded border border-border-strong bg-surface px-1.5 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {pillars.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value={NEW_PILLAR}>New pillar…</option>
          </select>
          {pillarChoice === NEW_PILLAR ? (
            <Input
              aria-label="New pillar name"
              placeholder="New pillar name"
              value={newPillar}
              onChange={(e) => setNewPillar(e.target.value)}
              aria-invalid={errors.pillar ? true : undefined}
              aria-describedby={errors.pillar ? 'rubric-add-pillar-error' : undefined}
              className="mt-1 h-8 text-xs"
            />
          ) : null}
          {errors.pillar ? (
            <span id="rubric-add-pillar-error" className="text-2xs text-danger">
              {errors.pillar}
            </span>
          ) : null}
        </div>
        <div className="flex w-24 flex-col gap-0.5">
          <label htmlFor="rubric-add-weight" className="text-2xs font-medium text-text-muted">
            Weight
          </label>
          <Input
            id="rubric-add-weight"
            type="number"
            inputMode="numeric"
            min={RUBRIC_LIMITS.weightMin}
            max={RUBRIC_LIMITS.weightMax}
            step={1}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            aria-invalid={errors.weight ? true : undefined}
            aria-describedby={errors.weight ? 'rubric-add-weight-error' : undefined}
            className="tnum h-8 text-right text-xs"
          />
          {errors.weight ? (
            <span id="rubric-add-weight-error" className="text-2xs text-danger">
              {errors.weight}
            </span>
          ) : null}
        </div>
        <Button type="submit" size="sm" variant="secondary" className="mt-4">
          <Plus aria-hidden="true" />
          Add dimension
        </Button>
      </div>
      <p className="tnum text-2xs text-text-muted" data-numeric="" data-testid="rubric-add-totals">
        Total weight: current {current} → proposed {w === null ? proposed : withNew}
        {w === null ? '' : ' with this dimension'}. All weights are scaled to 100 on save; existing scores are kept, and
        projects start with this dimension unscored (it counts 0 and marks their score incomplete).
      </p>
    </form>
  );
}

const FIELD_NAME: Record<RebaseField | 'order', string> = {
  label: 'label',
  pillar: 'pillar',
  weight: 'weight',
  inverted: 'inverted',
  active: 'active',
  order: 'order',
};

/**
 * After a 409 reload (QA-F26-1): the Admin's own changes (their draft against
 * the version it was edited from), and how they land on the latest version.
 * Changes nobody else touched apply as they are; a conflict (the same field
 * changed on both sides, or a change to a dimension someone else deactivated or
 * renamed, or the same label added twice) is shown per field — "Your value 40 ·
 * Current 30" — with a choice that defaults to the current server value.
 */
function RebasePanel({
  result,
  latest,
  choices,
  onChoose,
  onReapply,
  onDismiss,
  editable,
}: {
  result: RebaseResult;
  latest: ScoringRubric;
  choices: Readonly<Record<string, RebaseChoice>>;
  onChoose: (id: string, choice: RebaseChoice) => void;
  onReapply: () => void;
  onDismiss: () => void;
  editable: boolean;
}): React.JSX.Element {
  const radioName = React.useId();
  const { applied, conflicts } = result;
  return (
    <section
      aria-labelledby="rubric-comparison-heading"
      className="space-y-2 rounded border border-border-strong bg-surface-raised px-3 py-2 text-xs"
      data-testid="rubric-comparison"
    >
      <h4 id="rubric-comparison-heading" className="flex flex-wrap items-center gap-2 font-semibold text-text">
        Your previous draft, compared with version {latest.version}
        {conflicts.length > 0 ? (
          <Badge tone="warning" data-testid="rubric-conflict-count">
            {conflicts.length === 1 ? '1 conflict' : `${String(conflicts.length)} conflicts`}
          </Badge>
        ) : null}
      </h4>
      <p className="text-text-muted">
        Only the changes you made are re-applied. Everything you did not change keeps the value of version {latest.version}.
      </p>
      {applied.length === 0 && conflicts.length === 0 ? (
        <p className="text-text-muted">Your draft had no changes to re-apply.</p>
      ) : null}
      {applied.length > 0 ? (
        <div>
          <p className="font-medium text-text">Re-applied as they are</p>
          <ul className="mt-0.5 space-y-0.5" data-testid="rubric-rebase-applied">
            {applied.map((c) => (
              <li key={c.id} className="tnum text-text-muted" data-numeric="">
                <span className="font-medium text-text">{c.name}</span>
                {' · '}
                {c.field === 'added'
                  ? `added by you (${c.to})`
                  : c.field === 'order'
                    ? 'your order'
                    : `${FIELD_NAME[c.field]} ${c.from} → ${c.to}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {conflicts.length > 0 ? (
        <div className="space-y-1.5" data-testid="rubric-rebase-conflicts">
          <p className="font-medium text-text">
            Changed on both sides: choose per field. The current value is kept unless you choose yours.
          </p>
          {conflicts.map((c) => {
            const choice = choices[c.id] ?? 'current';
            const name = `${radioName}-${c.id}`;
            return (
              <fieldset
                key={c.id}
                className="rounded border border-warning/50 bg-surface px-2 py-1.5"
                data-testid="rubric-rebase-conflict"
                data-conflict={c.id}
              >
                <legend className="px-1 font-medium text-text">
                  {c.name} · {FIELD_NAME[c.field]}
                </legend>
                {c.note ? <p className="text-2xs text-text-muted">{c.note}</p> : null}
                <p className="tnum text-text" data-numeric="" data-testid="rubric-rebase-values">
                  Your value {c.mine} · Current {c.current}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  <label className="inline-flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name={name}
                      checked={choice === 'current'}
                      disabled={!editable}
                      onChange={() => onChoose(c.id, 'current')}
                      className="accent-primary"
                    />
                    Keep current ({c.current})
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name={name}
                      checked={choice === 'mine'}
                      disabled={!editable}
                      onChange={() => onChoose(c.id, 'mine')}
                      className="accent-primary"
                    />
                    Use mine ({c.mine})
                  </label>
                </div>
              </fieldset>
            );
          })}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {editable ? (
          <Button type="button" size="sm" variant="secondary" onClick={onReapply}>
            Re-apply my draft on version {latest.version}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
