import * as React from 'react';
import { Check, Download, FolderOpen, GitCompareArrows, Library, Pencil, Trash2, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatTimestamp } from '@/lib/format';

import { int } from '../../components/figures';
import { downloadSavedScenario } from '../import-api';
import { useImportPlan } from '../import-store';
import type { SavedScenarioSummary } from '../import-types';
import { groupBySource, MAX_SAVED_NAME, savedViewOf, storedEntryOf } from '../saved-scenarios';
import { MAX_COMPARE, useImportScenarios } from '../scenarios-store';
import {
  libraryErrorMessage,
  useDeleteSavedScenario,
  useDownload,
  useFetchSavedScenario,
  useRenameSavedScenario,
  useSavedScenarioLibrary,
} from '../use-import-library';
import { FeatureCard } from './feature-card';
import { useImportToast } from '../toast-store';

/**
 * P41 (ADR 0055 D3 / D4, contract E3): the saved import scenarios the caller can see (the
 * server filters by hub scope), grouped by source file and import date. Each card shows
 * served fields only: who saved it and when, the week and plan version it was simulated
 * from, and three served KPIs.
 */

export function SavedScenariosLibrary(): React.JSX.Element {
  const list = useSavedScenarioLibrary();
  // P41-R01: pages of 50, concatenated in served (newest-first) order.
  const items = React.useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const groups = React.useMemo(() => groupBySource(items), [items]);
  const total = list.data?.pages.at(-1)?.total ?? 0;
  return (
    <FeatureCard
      icon={Library}
      title={`Saved scenarios (${int(total)})`}
      hint="From every import you can see, grouped by file and import date"
      testId="import-library"
      info={
        <>
          <p>
            A saved scenario is a frozen record: the figures are the ones computed when it was saved, on that
            week&apos;s plan. Open it to read it, or re-run it on today&apos;s plan.
          </p>
          <p>Scenarios are visible to Admins and to users whose hubs cover all of the scenario&apos;s hubs.</p>
        </>
      }
    >
      {list.isPending ? (
        <div className="space-y-s2" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : list.isError && list.data === undefined ? (
        <p role="alert" className="text-xs font-medium text-danger-subtle-fg">
          {libraryErrorMessage(list.error)}
        </p>
      ) : groups.length === 0 ? (
        <p className="text-xs text-text-muted" data-testid="import-library-empty">
          No saved scenario yet. Use “Save scenario” on the Executive tab.
        </p>
      ) : (
        <div className="max-h-[32rem] space-y-s4 overflow-y-auto pr-1">
          {groups.map((g) => (
            <section key={g.key} aria-label={`${g.fileName}, imported ${formatTimestamp(g.importedAt)}`} data-testid="library-group">
              <h5 className="mb-s2 flex flex-wrap items-baseline gap-x-s2 text-xs font-semibold text-text">
                <span data-testid="library-group-file">{g.fileName}</span>
                <span className="font-normal text-text-muted">imported {formatTimestamp(g.importedAt)}</span>
              </h5>
              <ul className="grid gap-s2 lg:grid-cols-2">
                {g.items.map((s) => (
                  <SavedCard key={s.id} s={s} />
                ))}
              </ul>
            </section>
          ))}
          {list.hasNextPage ? (
            <div className="flex flex-wrap items-center gap-s2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? <Spinner className="size-3.5" /> : null}
                Load more
              </Button>
              <span className="text-2xs text-text-muted" data-testid="library-loaded">
                {`${int(items.length)} of ${int(total)} shown`}
              </span>
            </div>
          ) : null}
          {list.isFetchNextPageError ? (
            <p role="alert" className="text-xs font-medium text-danger-subtle-fg">
              {libraryErrorMessage(list.error)}
            </p>
          ) : null}
        </div>
      )}
    </FeatureCard>
  );
}

function Kpi({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-text-muted">{label}</dt>
      <dd className="font-mono text-sm font-semibold tabular-nums text-text" data-numeric="">
        {int(value)}
      </dd>
    </div>
  );
}

function SavedCard({ s }: { s: SavedScenarioSummary }): React.JSX.Element {
  const fetchSaved = useFetchSavedScenario();
  const openView = useImportPlan((st) => st.openView);
  const closeView = useImportPlan((st) => st.closeView);
  const setTab = useImportPlan((st) => st.setResultsTab);
  const addStored = useImportScenarios((st) => st.addStored);
  const syncStored = useImportScenarios((st) => st.syncStored);
  const toggleCompare = useImportScenarios((st) => st.toggleCompare);
  const entry = useImportScenarios((st) => st.scenarios.find((x) => x.stored?.id === s.id));
  const compareFull = useImportScenarios((st) => st.compareIds.length >= MAX_COMPARE);
  const inCompare = useImportScenarios((st) => (entry ? st.compareIds.includes(entry.id) : false));
  const rename = useRenameSavedScenario();
  const remove = useDeleteSavedScenario();
  const download = useDownload();
  const toast = useImportToast((st) => st.show);
  const [busy, setBusy] = React.useState<'open' | 'compare' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(s.name);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const load = async (what: 'open' | 'compare') => {
    setBusy(what);
    setError(null);
    try {
      const full = await fetchSaved(s.id);
      if (what === 'open') {
        openView(savedViewOf(full));
        setTab('executive');
      } else {
        addStored(storedEntryOf(full));
      }
    } catch (e) {
      setError(libraryErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const submitRename = (e: React.FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (name === '') return;
    rename.mutate(
      { id: s.id, name },
      {
        onSuccess: () => {
          syncStored(s.id, { name });
          setEditing(false);
          toast(`Renamed to “${name}”.`);
        },
        onError: (err) => setError(libraryErrorMessage(err)),
      },
    );
  };

  const doDelete = () =>
    remove.mutate(s.id, {
      onSuccess: () => {
        syncStored(s.id, null);
        const view = useImportPlan.getState().view;
        if (view?.kind === 'saved' && view.id === s.id) closeView();
        toast(`Scenario “${s.name}” deleted.`);
      },
      onError: (err) => {
        setConfirmDelete(false);
        setError(libraryErrorMessage(err));
      },
    });

  const k = s.kpis;
  return (
    <li className="space-y-s2 rounded-md border border-border px-s3 py-s2" data-testid="library-card" data-scenario={s.name}>
      {editing ? (
        <form className="flex flex-wrap items-center gap-s2" onSubmit={submitRename}>
          <Input
            aria-label={`New name for ${s.name}`}
            className="h-8 w-56 max-w-full"
            value={draft}
            maxLength={MAX_SAVED_NAME}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={draft.trim() === '' || rename.isPending} aria-label="Save name">
            <Check />
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} aria-label="Cancel rename">
            <X />
          </Button>
        </form>
      ) : (
        <p className="text-sm font-semibold text-text">{s.name}</p>
      )}
      {s.note ? <p className="break-words text-2xs text-text">{s.note}</p> : null}
      <p className="flex flex-wrap items-center gap-1 text-2xs text-text-muted">
        <span>
          Saved{s.created_by_name ? ` by ${s.created_by_name}` : ''} on {formatTimestamp(s.created_at)}
        </span>
        <span aria-hidden="true">·</span>
        <span data-testid="library-card-week">
          {`W${String(s.simulated_week)}${s.plan_version === null ? '' : ` · plan v${String(s.plan_version)}`}`}
        </span>
        <Badge tone="neutral">{s.mode === 'merge' ? 'merged with plan' : 'file only'}</Badge>
      </p>
      <dl className="grid grid-cols-3 gap-s2">
        <Kpi label="Finish in plan year" value={k.within_plan_year} />
        <Kpi label="Spill over" value={k.spillover} />
        <Kpi label="Left out" value={k.left_out} />
      </dl>
      {error ? (
        <p role="alert" className="text-2xs font-medium text-danger-subtle-fg">
          {error}
        </p>
      ) : null}
      {download.error ? (
        <p role="alert" className="text-2xs font-medium text-danger-subtle-fg">
          {download.error}
        </p>
      ) : null}
      {confirmDelete ? (
        <div
          role="alertdialog"
          aria-label={`Delete ${s.name}`}
          className="flex flex-wrap items-center gap-s2 rounded-md border border-danger/40 bg-danger-subtle px-s2 py-1.5 text-2xs text-danger-subtle-fg"
        >
          <span className="min-w-0 flex-1">Delete “{s.name}” for everyone? This cannot be undone.</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
            Keep
          </Button>
          <Button type="button" size="sm" variant="danger" disabled={remove.isPending} onClick={doDelete}>
            Delete
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void load('open')} aria-label={`Open ${s.name}`}>
          {busy === 'open' ? <Spinner className="size-3.5" /> : <FolderOpen />}
          Open
        </Button>
        {inCompare && entry ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => toggleCompare(entry.id)} aria-label={`Remove ${s.name} from compare`}>
            <GitCompareArrows />
            In compare
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null || compareFull}
            title={compareFull ? `At most ${String(MAX_COMPARE)} scenarios are compared` : undefined}
            onClick={() => (entry ? toggleCompare(entry.id) : void load('compare'))}
            aria-label={`Add ${s.name} to compare`}
          >
            {busy === 'compare' ? <Spinner className="size-3.5" /> : <GitCompareArrows />}
            Add to compare
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={download.pending !== null}
          onClick={() => void download.run('export', () => downloadSavedScenario(s.id, s.name))}
          aria-label={`Export to Excel: ${s.name} (with Gantt chart)`}
        >
          {download.pending ? <Spinner className="size-3.5" /> : <Download />}
          Export to Excel
        </Button>
        {s.can_edit ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(s.name);
                setEditing(true);
              }}
              aria-label={`Rename ${s.name}`}
            >
              <Pencil />
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${s.name}`}>
              <Trash2 />
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
