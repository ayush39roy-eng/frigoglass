import * as React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpFromLine } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import type { ProjectPriority } from '@/types/enums';
import type { RubricPreviewProject, ScoringRubricPreview } from '../../api/types';
import { changedPreviewProjects } from '../../lib/rubric-draft';

/**
 * P26: the served impact of a proposed rubric (`POST /scoring-rubric/preview`,
 * nothing saved). Every figure is a served field (I9): totals, counts, band
 * transitions and, per project whose score or band changes, the old and new
 * score out of 100, score band and suggested band after the P1 capacity fill.
 * The table only sorts the served rows.
 */

type SortKey = 'project' | 'hub' | 'old' | 'new' | 'score_band' | 'suggested_band';
type SortDir = 'ascending' | 'descending';

const BAND_RANK: Record<string, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

function bandRank(b: ProjectPriority | null): number {
  return b === null ? 99 : (BAND_RANK[b] ?? 98);
}

function cmpNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compare(a: RubricPreviewProject, b: RubricPreviewProject, key: SortKey): number {
  switch (key) {
    case 'project':
      return a.project_name.localeCompare(b.project_name);
    case 'hub':
      return a.hub.localeCompare(b.hub) || a.project_name.localeCompare(b.project_name);
    case 'old':
      return cmpNullable(a.old_normalized_pct, b.old_normalized_pct);
    case 'new':
      return cmpNullable(a.new_normalized_pct, b.new_normalized_pct);
    case 'score_band':
      return bandRank(a.new_score_band) - bandRank(b.new_score_band);
    case 'suggested_band':
      return bandRank(a.new_suggested_band) - bandRank(b.new_suggested_band);
  }
}

const pct = (v: number | null) => (v === null ? 'Unscored' : `${String(v)}/100`);
const band = (v: ProjectPriority | null) => v ?? 'Unscored';

function SortHeader({
  label,
  column,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}): React.JSX.Element {
  const active = sort.key === column;
  const Icon = active ? (sort.dir === 'ascending' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      scope="col"
      aria-sort={active ? sort.dir : 'none'}
      className={cn('px-2 py-1.5 font-semibold', align === 'right' ? 'text-right' : 'text-left')}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 rounded-sm text-2xs font-bold uppercase tracking-wider text-text-subtle hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        <Icon className="size-3" aria-hidden="true" />
      </button>
    </th>
  );
}

export function RubricPreviewPanel({
  preview,
  stale,
}: {
  preview: ScoringRubricPreview;
  /** The draft changed after this preview was taken. */
  stale: boolean;
}): React.JSX.Element {
  const [sort, setSort] = React.useState<{ key: SortKey; dir: SortDir }>({ key: 'project', dir: 'ascending' });
  const changed = changedPreviewProjects(preview);
  const rows = [...changed].sort((a, b) => {
    const c = compare(a, b, sort.key);
    return sort.dir === 'ascending' ? c : -c;
  });
  const onSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'ascending' ? 'descending' : 'ascending' } : { key, dir: 'ascending' }));

  return (
    <section
      aria-labelledby="rubric-preview-heading"
      className={cn('space-y-3 rounded-dash border-[1.5px] border-border bg-surface p-3', stale && 'border-dashed')}
      data-testid="rubric-preview"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="rubric-preview-heading" className="text-sm font-semibold text-text">
          Impact preview
        </h4>
        {stale ? (
          <Badge tone="warning" data-testid="rubric-preview-stale">
            Out of date — the draft changed; preview again
          </Badge>
        ) : (
          <span className="text-2xs text-text-muted">Nothing is saved by a preview.</span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4" data-testid="rubric-preview-summary">
        <div>
          <dt className="text-2xs text-text-muted">Total weight</dt>
          <dd className="tnum font-semibold text-text" data-numeric="" data-testid="rubric-preview-total">
            {preview.current_total_weight} → {preview.proposed_total_weight}
          </dd>
        </div>
        <div>
          <dt className="text-2xs text-text-muted">Scored projects</dt>
          <dd className="tnum font-semibold text-text" data-numeric="">
            {preview.scored_projects}
          </dd>
        </div>
        <div>
          <dt className="text-2xs text-text-muted">Score band changes</dt>
          <dd className="tnum font-semibold text-text" data-numeric="" data-testid="rubric-preview-score-band-count">
            {preview.score_band_change_count}
          </dd>
        </div>
        <div>
          <dt className="text-2xs text-text-muted">Suggested band changes</dt>
          <dd className="tnum font-semibold text-text" data-numeric="" data-testid="rubric-preview-suggested-band-count">
            {preview.suggested_band_change_count}
          </dd>
        </div>
      </dl>
      {preview.band_changes.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Score band changes" data-testid="rubric-band-changes">
          {preview.band_changes.map((c) => (
            <li key={`${c.from_band}-${c.to_band}`}>
              <Badge tone="outline" className="tnum">
                {c.count} {c.from_band} → {c.to_band}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-2xs text-text-muted">No project changes score band.</p>
      )}

      {rows.length === 0 ? (
        <p className="text-2xs text-text-muted" data-testid="rubric-preview-no-changes">
          No project in your scope changes score or band.
        </p>
      ) : (
        <div
          className="max-h-80 overflow-auto rounded border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="region"
          aria-label="Projects whose score or band changes"
          tabIndex={0}
        >
          <table className="w-full min-w-[40rem] border-collapse text-xs" data-testid="rubric-preview-table">
            <caption className="sr-only">
              Projects whose score or band changes: old and new score out of 100, score band and suggested band after
              the P1 capacity fill. Sortable.
            </caption>
            <thead className="sticky top-0 z-[1] bg-surface-sunken">
              <tr>
                <SortHeader label="Project" column="project" sort={sort} onSort={onSort} />
                <SortHeader label="Hub" column="hub" sort={sort} onSort={onSort} />
                <SortHeader label="Old" column="old" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="New" column="new" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="Score band" column="score_band" sort={sort} onSort={onSort} />
                <SortHeader label="Suggested band" column="suggested_band" sort={sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.project_id} className="border-t border-border/70" data-testid="rubric-preview-row">
                  <th scope="row" className="max-w-[14rem] truncate px-2 py-1.5 text-left font-medium text-text" title={p.project_name}>
                    {p.project_name}
                  </th>
                  <td className="px-2 py-1.5 text-text-muted">{p.hub}</td>
                  <td className="tnum px-2 py-1.5 text-right text-text-muted" data-numeric="">
                    {pct(p.old_normalized_pct)}
                  </td>
                  <td className="tnum px-2 py-1.5 text-right font-semibold text-text" data-numeric="">
                    {pct(p.new_normalized_pct)}
                    {p.missing_dimension_keys.length > 0 ? (
                      <span className="block text-2xs font-normal text-text-muted">
                        incomplete ({p.missing_dimension_keys.length})
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={cn(p.score_band_changed && 'font-semibold text-text')}>
                      {band(p.old_score_band)} → {band(p.new_score_band)}
                    </span>
                    {p.score_band_changed ? <span className="sr-only"> (changed)</span> : null}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={cn('inline-flex items-center gap-1', p.suggested_band_changed && 'font-semibold text-text')}>
                      {band(p.old_suggested_band)} → {band(p.new_suggested_band)}
                      {p.new_capacity_fill ? (
                        <span className="inline-flex items-center gap-0.5 text-2xs font-normal text-text-muted" title="P1 by capacity fill">
                          <ArrowUpFromLine className="size-3" aria-hidden="true" />
                          capacity fill
                        </span>
                      ) : null}
                    </span>
                    {p.suggested_band_changed ? <span className="sr-only"> (changed)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
