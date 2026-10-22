import * as React from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Star, Trash2 } from 'lucide-react';

import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ImpactLogo } from '@/components/shared/impact-logo';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { useVipItemWrite, type VipBoardArea, type VipItem, type VipPillarInfo } from '@/lib/api/vip';
import { cn } from '@/lib/utils';

import { VipItemEditor, type VipEditorTarget } from './vip-item-editor';
import { HiddenProjects, VipItemLink } from './vip-item-link';
import { PILLAR_STYLE, STATUS_TAG_META } from './vip-meta';

/**
 * One area's VIP slide (ADR 0027 §6, amended for OQ #39): three pillar
 * columns — number, title, headline, items, IMPACT footer — exactly as the
 * client's slides. VIP (highlighted) items get the pillar's accent background
 * AND a "VIP" marker, so it is never colour alone. Sub-items are indented.
 *
 * `canEdit` (`MATRIX` WRITE) adds an Edit mode: add / edit / delete, toggle
 * VIP, status tag and note, reorder up / down, and project links.
 */
export function VipBoardDialog({
  area,
  pillars,
  canEdit,
  onClose,
}: {
  area: VipBoardArea | null;
  pillars: VipPillarInfo[];
  canEdit: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  const [editor, setEditor] = React.useState<VipEditorTarget | null>(null);

  return (
    <>
      <Dialog
        open={area !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(false);
            onClose();
          }
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100vh-2rem)] max-w-6xl flex-col motion-reduce:animate-none"
          data-testid="vip-board-dialog"
        >
          {area ? (
            <>
              <DialogHeader className="flex-row flex-wrap items-center justify-between gap-2 pr-8">
                <ImpactLogo />
                <div className="mr-auto flex flex-col gap-1">
                  <DialogTitle className="flex items-center gap-2">
                    <CountryFlag region={area.area} />
                    {`VIP projects — ${area.label}`}
                  </DialogTitle>
                  <DialogDescription>{area.hubs.join(' · ')}</DialogDescription>
                </div>
                {canEdit ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={editing ? 'primary' : 'secondary'}
                    aria-pressed={editing}
                    onClick={() => setEditing((v) => !v)}
                    data-testid="vip-edit-toggle"
                  >
                    <Pencil aria-hidden="true" />
                    {editing ? 'Done editing' : 'Edit'}
                  </Button>
                ) : null}
              </DialogHeader>
              <div className="grid min-h-0 gap-4 overflow-y-auto md:grid-cols-3" data-testid="vip-slide">
                {pillars.map((pillar) => (
                  <PillarColumn
                    key={pillar.key}
                    pillar={pillar}
                    area={area}
                    items={area.items.filter((i) => i.pillar === pillar.key)}
                    editing={editing}
                    onEdit={setEditor}
                  />
                ))}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <VipItemEditor target={editor} onClose={() => setEditor(null)} />
    </>
  );
}

function PillarColumn({
  pillar,
  area,
  items,
  editing,
  onEdit,
}: {
  pillar: VipPillarInfo;
  area: VipBoardArea;
  items: VipItem[];
  editing: boolean;
  onEdit: (t: VipEditorTarget) => void;
}): React.JSX.Element {
  const style = PILLAR_STYLE[pillar.key];
  const headingId = React.useId();
  const lastOrder = items.length > 0 ? Math.max(...items.map((i) => i.sort_order)) : 0;
  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex min-w-0 flex-col rounded-md border border-border bg-surface', style.rule)}
      data-testid="vip-pillar"
      data-pillar={pillar.key}
    >
      <header className="flex items-start gap-3 p-3">
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold', style.band)} aria-hidden="true">
          {pillar.number}
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className={cn('text-sm font-extrabold uppercase tracking-wide', style.ink)}>
            <span className="sr-only">{`${pillar.number} `}</span>
            {pillar.label}
          </h3>
          <p className="text-xs font-semibold text-text">{pillar.headline}</p>
        </div>
      </header>
      <ul className="flex flex-1 flex-col gap-1 px-2 pb-2" aria-label={`${pillar.label} items`}>
        {items.map((item, index) => (
          <ItemRow
            key={item.id}
            item={item}
            siblings={items}
            index={index}
            pillar={pillar}
            area={area}
            editing={editing}
            onEdit={onEdit}
          />
        ))}
        {items.length === 0 ? <li className="px-2 py-1 text-xs text-text-muted">No items.</li> : null}
      </ul>
      {editing ? (
        <div className="px-3 pb-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onEdit({ mode: 'create', area: area.area, pillar: pillar.key, parentId: null, sortOrder: lastOrder + 1 })}
          >
            <Plus aria-hidden="true" />
            {`Add item to ${pillar.label}`}
          </Button>
        </div>
      ) : null}
      <footer className={cn('mt-auto rounded-b-md px-3 py-2 text-2xs', style.band)} data-testid="vip-impact">
        <span className="font-extrabold uppercase tracking-wider">Impact</span>
        <span className="mx-1.5" aria-hidden="true">
          ·
        </span>
        {pillar.impact.join(' • ')}
      </footer>
    </section>
  );
}

function ItemRow({
  item,
  siblings,
  index,
  pillar,
  area,
  editing,
  onEdit,
  depth = 0,
}: {
  item: VipItem;
  siblings: VipItem[];
  index: number;
  pillar: VipPillarInfo;
  area: VipBoardArea;
  editing: boolean;
  onEdit: (t: VipEditorTarget) => void;
  depth?: number;
}): React.JSX.Element {
  const style = PILLAR_STYLE[pillar.key];
  const tag = item.status_tag ? STATUS_TAG_META[item.status_tag] : null;
  const lastChildOrder = item.children.length > 0 ? Math.max(...item.children.map((c) => c.sort_order)) : 0;
  return (
    <li className={cn(depth > 0 && 'ml-5')} data-testid="vip-item" data-highlighted={item.highlighted || undefined} data-depth={depth}>
      <div className={cn('flex flex-col gap-1 rounded-sm px-2 py-1.5', item.highlighted && style.highlight)}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs text-text">
          <span className={cn('select-none', style.ink)} aria-hidden="true">
            {depth > 0 ? '–' : '•'}
          </span>
          {item.highlighted ? (
            <span className={cn('inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-2xs font-bold', style.marker)} data-testid="vip-marker">
              <Star className="size-2.5" aria-hidden="true" />
              VIP
            </span>
          ) : null}
          <VipItemLink item={item} className={cn('font-medium', item.highlighted && 'font-semibold')} />
          {tag ? (
            <Badge tone={tag.tone} className="rounded-pill" data-testid="vip-status-tag" data-tag={item.status_tag}>
              {tag.label}
            </Badge>
          ) : null}
          {item.status_note ? <span className="text-2xs italic text-text-muted">({item.status_note})</span> : null}
        </div>
        {item.projects.length === 0 && item.hidden_project_count > 0 ? <HiddenProjects count={item.hidden_project_count} /> : null}
        {editing ? (
          <ItemControls
            item={item}
            siblings={siblings}
            index={index}
            onEdit={() => onEdit({ mode: 'edit', area: area.area, item })}
            onAddChild={
              depth === 0
                ? () => onEdit({ mode: 'create', area: area.area, pillar: pillar.key, parentId: item.id, sortOrder: lastChildOrder + 1 })
                : null
            }
          />
        ) : null}
      </div>
      {item.children.length > 0 ? (
        <ul className="mt-0.5 flex flex-col gap-0.5" aria-label={`${item.title} sub-items`}>
          {item.children.map((child, i) => (
            <ItemRow
              key={child.id}
              item={child}
              siblings={item.children}
              index={i}
              pillar={pillar}
              area={area}
              editing={editing}
              onEdit={onEdit}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const ICON_BUTTON =
  'inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-2xs text-text hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

function ItemControls({
  item,
  siblings,
  index,
  onEdit,
  onAddChild,
}: {
  item: VipItem;
  siblings: VipItem[];
  index: number;
  onEdit: () => void;
  onAddChild: (() => void) | null;
}): React.JSX.Element {
  const write = useVipItemWrite();
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((err: unknown) => setError(apiErrorMessage(err, 'The change could not be saved.')));
  };
  /** Reorder = swap the two served `sort_order` values. */
  const swap = (other: VipItem | undefined) => {
    if (!other) return;
    run(async () => {
      await write.mutateAsync({ kind: 'update', itemId: item.id, body: { sort_order: other.sort_order } });
      await write.mutateAsync({ kind: 'update', itemId: other.id, body: { sort_order: item.sort_order } });
    });
  };
  const busy = write.isPending;
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`Edit ${item.title}`}>
      <button type="button" className={ICON_BUTTON} onClick={onEdit} disabled={busy}>
        <Pencil className="size-3" aria-hidden="true" />
        Edit
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        aria-pressed={item.highlighted}
        onClick={() => run(() => write.mutateAsync({ kind: 'update', itemId: item.id, body: { highlighted: !item.highlighted } }))}
        disabled={busy}
      >
        <Star className="size-3" aria-hidden="true" />
        VIP
      </button>
      <button type="button" className={ICON_BUTTON} aria-label={`Move ${item.title} up`} onClick={() => swap(siblings[index - 1])} disabled={busy || index === 0}>
        <ArrowUp className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        aria-label={`Move ${item.title} down`}
        onClick={() => swap(siblings[index + 1])}
        disabled={busy || index === siblings.length - 1}
      >
        <ArrowDown className="size-3" aria-hidden="true" />
      </button>
      {onAddChild ? (
        <button type="button" className={ICON_BUTTON} onClick={onAddChild} disabled={busy}>
          <Plus className="size-3" aria-hidden="true" />
          Sub-item
        </button>
      ) : null}
      {confirmDelete ? (
        <>
          <button
            type="button"
            className={cn(ICON_BUTTON, 'border-danger text-danger')}
            onClick={() => run(() => write.mutateAsync({ kind: 'delete', itemId: item.id }))}
            disabled={busy}
          >
            <Trash2 className="size-3" aria-hidden="true" />
            {`Confirm delete${item.children.length > 0 ? ' (and its sub-items)' : ''}`}
          </button>
          <button type="button" className={ICON_BUTTON} onClick={() => setConfirmDelete(false)} disabled={busy}>
            Keep
          </button>
        </>
      ) : (
        <button type="button" className={ICON_BUTTON} aria-label={`Delete ${item.title}`} onClick={() => setConfirmDelete(true)} disabled={busy}>
          <Trash2 className="size-3" aria-hidden="true" />
        </button>
      )}
      {error ? (
        <span role="alert" className="w-full text-2xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
