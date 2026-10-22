import * as React from 'react';
import { BookOpenText, History, Lock, Pencil } from 'lucide-react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { SCORING_SCALE, scoringAnchor } from '@/lib/domain-constants';
import { formatTimestamp } from '@/lib/format';

import { POINTS_RULE_COPY } from '../api/types';
import { useScoringRubric } from '../hooks/use-matrix';
import { draftFromRubric, type RubricDraft } from '../lib/rubric-draft';
import { groupByPillar, sortByPillar, type PillarGroup } from '../lib/pillars';
import { pillarTinted } from '../lib/grid-boxes';
import { useMediaQuery } from '../lib/use-media-query';
import { formatWeight } from '../lib/scoring-model-core';
import { useScoringModel } from '../scoring-model';
import { RubricEditor } from './rubric-editor/rubric-editor';
import { RubricVersionHistory } from './rubric-editor/rubric-version-history';
import './virtual-matrix-grid.css';
import './rubric-pillars.css';

/** Phones: each pillar becomes a boxed section with its dimensions stacked inside. */
const PHONE_QUERY = '(max-width: 639px)';

interface ShownDimension {
  key: string;
  label: string;
  pillar: string;
  weight: number;
  scaled_weight: number | null;
}

/**
 * "Scoring scale and dimensions" (P9 contract §8; P26 ADR 0037; P26-T03): the
 * single place the rubric is read AND edited in the Prioritization Matrix.
 *
 * - Always expanded, compact: the 0–5 scale and, per ACTIVE dimension of the
 *   served rubric (`GET /scoring-rubric`; the served `/priorities/dimensions`
 *   model until it arrives), its pillar, served weight (scaled of 100) and, where
 *   the deck describes it, what a 1 and a 5 mean — grouped by pillar in display
 *   order, with the served total weight. The table body scrolls inside the card.
 * - Header: "Edit rubric" only for the served `can_edit` (Admin / Super Admin),
 *   otherwise "Read-only · managed by Admins"; "Version history" for everyone
 *   (a small dialog with the existing history view).
 * - Edit mode swaps the table for the inline editor (`RubricEditor`) in the same
 *   card. Cancel with changes asks first; leaving the page (reload, close, or an
 *   in-app link) with unsaved changes asks too.
 *
 * No score is derived here (Invariant I9).
 */
export function ScoringRubricPanel(): React.JSX.Element {
  const model = useScoringModel();
  const query = useScoringRubric(true);
  const rubric = query.data;
  const canEdit = rubric?.can_edit === true;

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<RubricDraft | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [notice, setNotice] = React.useState('');

  const cardRef = React.useRef<HTMLDivElement>(null);
  const editButtonRef = React.useRef<HTMLButtonElement>(null);
  const editorRegionRef = React.useRef<HTMLDivElement>(null);
  const focusNext = React.useRef<'edit' | 'editor' | null>(null);
  React.useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    (target === 'edit' ? editButtonRef.current : editorRegionRef.current)?.focus();
  });

  // An untouched draft follows a newer served version (render-time adjustment).
  if (editing && rubric && draft && !dirty && draft.baseVersion !== rubric.version) {
    setDraft(draftFromRubric(rubric));
  }
  // The edit right went away (served `can_edit` false): leave edit mode.
  if (editing && rubric && !rubric.can_edit) {
    setEditing(false);
    setDraft(null);
    setDirty(false);
  }

  const startEdit = () => {
    if (!rubric) return;
    setDraft(draftFromRubric(rubric));
    setDirty(false);
    setNotice('');
    setEditing(true);
    focusNext.current = 'editor';
  };
  const leaveEdit = (message = '') => {
    setEditing(false);
    setDraft(null);
    setDirty(false);
    setConfirmCancel(false);
    setNotice(message);
    focusNext.current = 'edit';
  };
  const requestCancel = () => {
    if (dirty) setConfirmCancel(true);
    else leaveEdit();
  };

  const unsaved = editing && dirty;
  // Reload / closing the tab with unsaved rubric changes asks first.
  React.useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);
  // In-app navigation needs a data router (the app has one; some tests do not).
  const dataRouter = React.useContext(UNSAFE_DataRouterContext);

  const served: readonly ShownDimension[] = rubric
    ? rubric.dimensions.filter((d) => d.active)
    : model.dimensions;
  const shown = sortByPillar(served);
  const phone = useMediaQuery(PHONE_QUERY);
  const inactive = rubric ? rubric.dimensions.filter((d) => !d.active) : [];
  const totalWeight = rubric ? rubric.total_weight : model.total_weight;

  return (
    <Card ref={cardRef} data-testid="scoring-rubric-card">
      <CardHeader className="flex-wrap gap-y-2">
        <div className="min-w-0">
          <CardTitle id="scoring-rubric-card-title" className="flex items-center gap-s2">
            <BookOpenText className="size-4 text-text-muted" aria-hidden="true" />
            Scoring scale and dimensions
          </CardTitle>
          {rubric ? (
            <p className="tnum mt-0.5 text-2xs text-text-muted" data-numeric="" data-testid="rubric-card-summary">
              Version {rubric.version} · total weight {rubric.total_weight} (scaled to 100) · changed{' '}
              {formatTimestamp(rubric.changed_at)}
              {rubric.changed_by_name ? ` by ${rubric.changed_by_name}` : ''}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rubric && !canEdit ? (
            <span className="inline-flex items-center gap-1 text-2xs text-text-muted" data-testid="rubric-readonly-note">
              <Lock className="size-3" aria-hidden="true" />
              Read-only · managed by Admins
            </span>
          ) : null}
          {editing ? (
            <Badge tone="warning" data-testid="rubric-editing-badge">
              Editing{dirty ? ' · unsaved changes' : ''}
            </Badge>
          ) : null}
          <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-1"
                aria-label="Rubric version history"
                data-testid="rubric-history-button"
              >
                <History aria-hidden="true" />
                Version history
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85dvh] max-w-2xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden" data-testid="rubric-history-dialog">
              <DialogHeader>
                <DialogTitle>Rubric version history</DialogTitle>
                <DialogDescription>
                  Every saved version of the scoring rubric, newest first: who, when, why, and what changed.
                </DialogDescription>
              </DialogHeader>
              <div className="-mx-1 min-h-0 overflow-y-auto px-1" role="region" aria-label="Rubric versions" tabIndex={0}>
                <RubricVersionHistory enabled={historyOpen} />
              </div>
            </DialogContent>
          </Dialog>
          {canEdit && !editing ? (
            <Button
              ref={editButtonRef}
              type="button"
              variant="secondary"
              size="sm"
              onClick={startEdit}
              data-testid="rubric-edit-button"
            >
              <Pencil aria-hidden="true" />
              Edit rubric
            </Button>
          ) : null}
        </div>
      </CardHeader>

      {notice ? (
        <p role="status" className="border-b border-border bg-success-subtle px-card py-2 text-xs text-text" data-testid="rubric-card-notice">
          {notice}
        </p>
      ) : null}

      <div className="px-card pt-s3">
        <dl className="flex flex-wrap gap-x-s4 gap-y-1 text-2xs text-text-muted" aria-label="Score scale">
          {SCORING_SCALE.map((s) => (
            <div key={s.score} className="flex items-center gap-1.5">
              <dt className="mg-chip tnum text-2xs" data-intensity={s.score} data-numeric="">
                {s.score}
              </dt>
              <dd>{s.label}</dd>
            </div>
          ))}
        </dl>
      </div>

      {editing && rubric && draft ? (
        <RubricEditor
          rubric={rubric}
          draft={draft}
          dirty={dirty}
          regionRef={editorRegionRef}
          onDraftChange={(dims) => {
            setDraft((d) => (d ? { ...d, dimensions: dims } : d));
            setDirty(true);
          }}
          onReplaceDraft={(next, isDirty) => {
            setDraft(next);
            setDirty(isDirty);
          }}
          refetch={async () => (await query.refetch()).data}
          onCancel={requestCancel}
          onSaved={(message) => leaveEdit(message)}
        />
      ) : (
        <CardContent className="space-y-s3 pt-s3">
          {phone ? <StackedPillars dims={shown} /> : <PillarTable dims={shown} />}
          {inactive.length > 0 ? (
            <p className="text-2xs text-text-muted" data-testid="rubric-inactive-list">
              Inactive (not in the score; their scores are kept): {inactive.map((d) => d.label).join(', ')}.
            </p>
          ) : null}
          <p className="text-2xs text-text-subtle" data-testid="rubric-total-line">
            {POINTS_RULE_COPY}{' '}
            {totalWeight === null ? '' : `Active weights total ${String(totalWeight)}, shown scaled to 100. `}The weighted
            score, normalised percentage and band are computed by the server (DOMAIN_RULES.md) — this rubric only explains
            the inputs.
          </p>
        </CardContent>
      )}

      <DiscardDialog
        open={confirmCancel}
        title="Discard your rubric changes?"
        description="Your unsaved changes to the rubric will be lost. Nothing has been saved."
        onKeep={() => setConfirmCancel(false)}
        onDiscard={() => leaveEdit('Changes discarded. The rubric is unchanged.')}
        returnFocus={() =>
          (editButtonRef.current ?? cardRef.current?.querySelector<HTMLElement>('[data-testid="rubric-cancel"]'))?.focus()
        }
      />
      {dataRouter ? <LeaveGuard when={unsaved} /> : null}
    </Card>
  );
}

/** Blocks in-app navigation while the rubric has unsaved changes, and asks. */
function LeaveGuard({ when }: { when: boolean }): React.JSX.Element {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname);
  return (
    <DiscardDialog
      open={blocker.state === 'blocked'}
      title="Leave with unsaved rubric changes?"
      description="You are editing the scoring rubric. If you leave this page, your unsaved changes are lost."
      keepLabel="Stay on this page"
      discardLabel="Leave and discard"
      onKeep={() => blocker.reset?.()}
      onDiscard={() => blocker.proceed?.()}
    />
  );
}

function DiscardDialog({
  open,
  title,
  description,
  keepLabel = 'Keep editing',
  discardLabel = 'Discard changes',
  onKeep,
  onDiscard,
  returnFocus,
}: {
  open: boolean;
  title: string;
  description: string;
  keepLabel?: string;
  discardLabel?: string;
  onKeep: () => void;
  onDiscard: () => void;
  /** Where focus goes when the dialog closes (it has no trigger to return to). */
  returnFocus?: () => void;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep();
      }}
    >
      <DialogContent
        role="alertdialog"
        className="max-w-md"
        data-testid="rubric-discard-dialog"
        onCloseAutoFocus={(e) => {
          if (!returnFocus) return;
          e.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onKeep} autoFocus>
            {keepLabel}
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={onDiscard}>
            {discardLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Strategic Alignment · 3 · 75 (25.4 of 100)": the pillar's dimension count and
 * the sum of its dimensions' SERVED weights and scaled weights (display-only
 * aggregation of served fields; no score is derived from it).
 */
function pillarSummary(group: PillarGroup<ShownDimension>): { count: number; weight: string } {
  const weight = group.items.reduce((sum, d) => sum + d.weight, 0);
  const scaled = group.items.every((d) => d.scaled_weight !== null)
    ? group.items.reduce((sum, d) => sum + (d.scaled_weight ?? 0), 0)
    : null;
  return { count: group.items.length, weight: formatWeight(weight, scaled) };
}

function NotDescribed(): React.JSX.Element {
  return (
    <>
      <span aria-hidden="true" className="text-text-subtle">—</span>
      <span className="sr-only">not described</span>
    </>
  );
}

/** One hue per pillar (owner ask 2026-10-22: the read table looked flat). Drawn
 *  from the dashboard categorical ramp; decoration only, the pillar name is
 *  always printed beside it. */
const PILLAR_HUES = ['--dash-cat-1', '--dash-cat-2', '--dash-cat-8', '--dash-cat-5', '--dash-cat-6', '--dash-cat-7'] as const;

function pillarHueStyle(index: number): React.CSSProperties {
  return { '--rp-hue': `var(${PILLAR_HUES[index % PILLAR_HUES.length] ?? '--dash-cat-1'})` } as React.CSSProperties;
}

function PillarHeading({ group, index }: { group: PillarGroup<ShownDimension>; index: number }): React.JSX.Element {
  const { count, weight } = pillarSummary(group);
  return (
    <span className="flex flex-col gap-0.5" data-testid="rubric-pillar-summary" data-pillar-index={index}>
      <span className="rp-pillar-name text-sm font-bold leading-tight">{group.pillar}</span>
      <span className="tnum text-2xs text-text-muted" data-numeric="">
        <span className="sr-only">{count === 1 ? '1 dimension' : `${String(count)} dimensions`}, total weight </span>
        <span aria-hidden="true">
          {count} · {weight}
        </span>
        <span className="sr-only">{weight}</span>
      </span>
    </span>
  );
}

/** The read table, pillar first: one <tbody> per pillar, the pillar cell spans its rows. */
function PillarTable({ dims }: { dims: readonly ShownDimension[] }): React.JSX.Element {
  const groups = groupByPillar(dims);
  // Visual scale only: the heaviest served scaled weight fills the weight bar.
  const maxScaled = dims.reduce((m, d) => Math.max(m, d.scaled_weight ?? 0), 0);
  return (
    <div
      className="mg-pillar-scope max-h-[26rem] overflow-auto rounded border-2 border-border-strong/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="region"
      aria-label="Scoring dimensions"
      tabIndex={0}
      data-testid="rubric-dimensions-scroll"
    >
      <table className="rp-table w-full min-w-[44rem] text-xs" data-testid="rubric-dimensions-table">
        <caption className="sr-only">
          Active scoring dimensions grouped by pillar: each pillar&apos;s dimension count and total weight, then per
          dimension its served weight (scaled of 100) and what a score of 1 and 5 mean.
        </caption>
        <thead className="sticky top-0 z-[2] bg-surface-sunken shadow-[inset_0_-2px_0_hsl(var(--color-border-strong))]">
          <tr className="text-left text-2xs font-bold uppercase tracking-wider text-text-subtle">
            <th scope="col" className="w-52 px-2 py-1.5">Pillar</th>
            <th scope="col" className="px-2 py-1.5">Dimension</th>
            <th scope="col" className="px-2 py-1.5 text-right">Weight</th>
            <th scope="col" className="px-2 py-1.5">
              <span className="inline-flex items-center gap-1.5">
                <span className="rp-anchor-dot rp-anchor-low" aria-hidden="true" />1 — Negligible
              </span>
            </th>
            <th scope="col" className="px-2 py-1.5">
              <span className="inline-flex items-center gap-1.5">
                <span className="rp-anchor-dot rp-anchor-high" aria-hidden="true" />5 — Exceptional
              </span>
            </th>
          </tr>
        </thead>
        {groups.map((group, gi) => (
          <tbody
            key={group.pillar}
            className="rp-group rp-hued"
            data-tint={pillarTinted(gi)}
            data-testid="rubric-pillar-group"
            data-pillar={group.pillar}
            style={pillarHueStyle(gi)}
          >
            {group.items.map((dim, i) => {
              const anchor = scoringAnchor(dim.key);
              return (
                <tr key={dim.key} data-testid="rubric-dimension-row">
                  {i === 0 ? (
                    <th
                      scope="rowgroup"
                      rowSpan={group.items.length}
                      className="rp-pillar-cell px-3 py-1.5 text-left align-top font-normal"
                      data-testid="rubric-pillar-cell"
                    >
                      <PillarHeading group={group} index={gi} />
                    </th>
                  ) : null}
                  <th scope="row" className="px-2 py-1.5 text-left font-medium text-text">
                    {dim.label}
                  </th>
                  <td className="tnum whitespace-nowrap px-2 py-1.5 text-right text-text" data-numeric="">
                    <span className="inline-flex items-center justify-end gap-2">
                      {dim.scaled_weight !== null && maxScaled > 0 ? (
                        <span className="rp-weight-track" aria-hidden="true">
                          <span style={{ width: `${String((dim.scaled_weight / maxScaled) * 100)}%` }} />
                        </span>
                      ) : null}
                      {formatWeight(dim.weight, dim.scaled_weight)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-text-muted">
                    {anchor ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="rp-anchor-dot rp-anchor-low" aria-hidden="true" />
                        {anchor.low}
                      </span>
                    ) : (
                      <NotDescribed />
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-text">
                    {anchor ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="rp-anchor-dot rp-anchor-high" aria-hidden="true" />
                        {anchor.high}
                      </span>
                    ) : (
                      <NotDescribed />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** Phones: one boxed section per pillar (header + its dimensions stacked). */
function StackedPillars({ dims }: { dims: readonly ShownDimension[] }): React.JSX.Element {
  const groups = groupByPillar(dims);
  return (
    <div
      className="mg-pillar-scope rp-stack max-h-[32rem] overflow-y-auto rounded border-2 border-border-strong/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="region"
      aria-label="Scoring dimensions"
      tabIndex={0}
      data-testid="rubric-dimensions-stacked"
    >
      {groups.map((group, gi) => (
        <section
          key={group.pillar}
          className="rp-section"
          data-tint={pillarTinted(gi)}
          aria-labelledby={`rubric-stack-pillar-${String(gi)}`}
          data-testid="rubric-pillar-group"
          data-pillar={group.pillar}
        >
          <h4 id={`rubric-stack-pillar-${String(gi)}`} className="rp-pillar-cell px-3 py-1.5">
            <PillarHeading group={group} index={gi} />
          </h4>
          <ul>
            {group.items.map((dim) => {
              const anchor = scoringAnchor(dim.key);
              return (
                <li key={dim.key} className="rp-item space-y-0.5 px-3 py-2 text-xs" data-testid="rubric-dimension-row">
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-text">{dim.label}</span>
                    <span className="tnum whitespace-nowrap text-text" data-numeric="">
                      {formatWeight(dim.weight, dim.scaled_weight)}
                    </span>
                  </p>
                  {anchor ? (
                    <p className="text-2xs text-text-muted">
                      1: {anchor.low} · 5: {anchor.high}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
