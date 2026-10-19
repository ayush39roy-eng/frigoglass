import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';

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
import { apiErrorMessage } from '@/lib/api/error-messages';
import {
  useVipItemWrite,
  VIP_NOTE_MAX,
  VIP_STATUS_TAGS,
  VIP_TITLE_MAX,
  type VipArea,
  type VipItem,
  type VipPillar,
  type VipStatusTag,
} from '@/lib/api/vip';
import { queryKeys } from '@/lib/query-keys';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useHubFilter } from '@/stores/hub-filter';

import { fetchDashboardProjects } from '../../api/dashboard-api';
import { STATUS_TAG_META } from './vip-meta';

/** What the editor is for: a new item (optionally a sub-item) or an existing one. */
export type VipEditorTarget =
  | { mode: 'create'; area: VipArea; pillar: VipPillar; parentId: string | null; sortOrder: number }
  | { mode: 'edit'; area: VipArea; item: VipItem };

interface LinkedProject {
  id: string;
  name: string;
  hub: string;
}

const SEARCH_MAX = 100;
const NO_TAG = '';

function sameIds(a: LinkedProject[], b: LinkedProject[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((p) => p.id));
  return b.every((p) => ids.has(p.id));
}

/**
 * Add / edit one VIP item (ADR 0027 §5, `MATRIX` WRITE). Title, status tag,
 * status note, highlighted (= VIP, OQ #39), and the linked projects, picked
 * through `GET /dashboard/projects?q=`. The server audits every write, checks
 * scope and area (422 `VIP_PROJECT_AREA_MISMATCH`) and recomputes `is_vip`.
 */
export function VipItemEditor({
  target,
  onClose,
}: {
  target: VipEditorTarget | null;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg motion-reduce:animate-none" data-testid="vip-item-editor">
        {target ? <EditorForm key={target.mode === 'edit' ? target.item.id : 'new'} target={target} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function EditorForm({ target, onClose }: { target: VipEditorTarget; onClose: () => void }): React.JSX.Element {
  const existing = target.mode === 'edit' ? target.item : null;
  const initialLinks = React.useMemo<LinkedProject[]>(
    () => (existing ? existing.projects.map((p) => ({ id: p.id, name: p.name, hub: p.hub })) : []),
    [existing],
  );
  const [title, setTitle] = React.useState(existing?.title ?? '');
  const [tag, setTag] = React.useState<string>(existing?.status_tag ?? NO_TAG);
  const [note, setNote] = React.useState(existing?.status_note ?? '');
  const [highlighted, setHighlighted] = React.useState(existing?.highlighted ?? false);
  const [links, setLinks] = React.useState<LinkedProject[]>(initialLinks);
  const [error, setError] = React.useState<string | null>(null);
  const write = useVipItemWrite();
  const ids = { title: React.useId(), tag: React.useId(), note: React.useId(), hl: React.useId() };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmed = title.trim();
    if (!trimmed) {
      setError('A title is required.');
      return;
    }
    const fields = {
      title: trimmed,
      status_tag: tag === NO_TAG ? null : (tag as VipStatusTag),
      status_note: note.trim() === '' ? null : note.trim(),
      highlighted,
    };
    try {
      let itemId: string | null = existing?.id ?? null;
      if (target.mode === 'create') {
        const created = await write.mutateAsync({
          kind: 'create',
          body: { area: target.area, pillar: target.pillar, parent_id: target.parentId, sort_order: target.sortOrder, ...fields },
        });
        itemId = readId(created);
      } else {
        await write.mutateAsync({ kind: 'update', itemId: target.item.id, body: fields });
      }
      if (itemId && !sameIds(links, initialLinks)) {
        await write.mutateAsync({ kind: 'link', itemId, projectIds: links.map((l) => l.id) });
      }
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, 'The item could not be saved.'));
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      <DialogHeader className="pr-6">
        <DialogTitle>{existing ? 'Edit VIP item' : target.mode === 'create' && target.parentId ? 'Add sub-item' : 'Add VIP item'}</DialogTitle>
        <DialogDescription>Changes are saved to the shared VIP board and audited. Nothing is recalculated.</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.title}>Title</Label>
        <Input id={ids.title} value={title} maxLength={VIP_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} required />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.tag}>Status tag</Label>
          <select
            id={ids.tag}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="h-9 rounded-md border border-border-strong bg-surface px-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value={NO_TAG}>No tag</option>
            {VIP_STATUS_TAGS.map((t) => (
              <option key={t} value={t}>
                {STATUS_TAG_META[t].label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.note}>Status note</Label>
          <Input id={ids.note} value={note} maxLength={VIP_NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Tooling delayed" />
        </div>
      </div>

      <label htmlFor={ids.hl} className="flex items-center gap-2 text-sm text-text">
        <input
          id={ids.hl}
          type="checkbox"
          checked={highlighted}
          onChange={(e) => setHighlighted(e.target.checked)}
          className="size-4 accent-primary"
        />
        VIP (highlighted on the slide)
      </label>

      <ProjectLinks area={target.area} links={links} onChange={setLinks} />

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose} disabled={write.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={write.isPending}>
          {write.isPending ? 'Saving…' : 'Save item'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function readId(created: unknown): string | null {
  if (created && typeof created === 'object' && 'id' in created) {
    const id = (created as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

/** Linked projects + a search on `GET /dashboard/projects?q=` (scoped by the server). */
function ProjectLinks({
  area,
  links,
  onChange,
}: {
  area: VipArea;
  links: LinkedProject[];
  onChange: (next: LinkedProject[]) => void;
}): React.JSX.Element {
  const [q, setQ] = React.useState('');
  const debounced = useDebouncedValue(q.trim(), 300);
  const { hubId } = useHubFilter();
  const searchId = React.useId();
  // The area is a country (OQ #39): search within it, so every offered project
  // can be linked (the server still checks, 422 VIP_PROJECT_AREA_MISMATCH).
  const search = useQuery({
    queryKey: queryKeys.vipLinkSearch(debounced, hubId, area),
    queryFn: ({ signal }) =>
      fetchDashboardProjects({ q: debounced.slice(0, SEARCH_MAX), region: area, hub_id: hubId ?? undefined, sort: 'name' }, { signal }),
    enabled: debounced.length >= 2,
  });
  const linked = new Set(links.map((l) => l.id));
  const results = (search.data?.rows ?? []).filter((r) => !linked.has(r.project_id)).slice(0, 20);

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-text">Linked projects</legend>
      {links.length === 0 ? (
        <p className="text-xs text-text-muted">No project linked. The item is shown as plain text.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Linked projects">
          {links.map((l) => (
            <li key={l.id} className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface-raised py-0.5 pl-2 pr-1 text-xs text-text">
              {l.name}
              <span className="text-text-muted">· {l.hub}</span>
              <button
                type="button"
                onClick={() => onChange(links.filter((x) => x.id !== l.id))}
                aria-label={`Unlink ${l.name}`}
                className="rounded-pill p-0.5 text-text-muted hover:bg-surface-sunken hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
        <Input
          id={searchId}
          type="search"
          aria-label={`Search projects in ${area} to link`}
          value={q}
          maxLength={SEARCH_MAX}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects by name or code"
          className="pl-7"
        />
      </div>
      {debounced.length >= 2 ? (
        search.isPending ? (
          <p className="text-xs text-text-muted" role="status">
            Searching…
          </p>
        ) : search.isError ? (
          <p className="text-xs text-danger" role="alert">
            {apiErrorMessage(search.error, 'The project search failed.')}
          </p>
        ) : results.length === 0 ? (
          <p className="text-xs text-text-muted" role="status">
            No matching project in {area}.
          </p>
        ) : (
          <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1" aria-label="Search results">
            {results.map((r) => (
              <li key={r.project_id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange([...links, { id: r.project_id, name: r.project_name, hub: r.hub }]);
                    setQ('');
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-text hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Link ${r.project_name} (${r.hub})`}
                >
                  <Plus className="size-3 shrink-0 text-text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{r.project_name}</span>
                  <span className="shrink-0 text-text-muted">{r.hub}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </fieldset>
  );
}
