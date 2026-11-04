import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import type { ImportSeverity } from '../import-types';
import { SEVERITY_META, SEVERITY_ORDER } from '../severity-meta';

export interface IssueItem {
  id: string;
  severity: ImportSeverity;
  code: string;
  message: string;
  /** "Row 5", a project name, or null for a file-level issue. */
  where: string | null;
}

const ITEM_H = 44;
const VIRTUALIZE_OVER = 100;

/**
 * Issues grouped by severity: one toggle per severity (with its served count of
 * items), then the list of the chosen group. Virtualized over 100 items.
 */
export function IssueList({ items, label }: { items: readonly IssueItem[]; label: string }): React.JSX.Element {
  const counts = React.useMemo(() => {
    const c: Record<ImportSeverity, number> = { error: 0, warning: 0, info: 0 };
    for (const i of items) c[i.severity] += 1;
    return c;
  }, [items]);
  const firstNonEmpty = SEVERITY_ORDER.find((s) => counts[s] > 0) ?? 'error';
  const [chosen, setChosen] = React.useState<ImportSeverity | null>(null);
  const severity = chosen ?? firstNonEmpty;
  const shown = React.useMemo(() => items.filter((i) => i.severity === severity), [items, severity]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtual = shown.length > VIRTUALIZE_OVER;
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer (see eslint.config.js).
  const virtualizer = useVirtualizer({
    count: virtual ? shown.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_H,
    overscan: 8,
    initialRect: { width: 600, height: 240 },
  });

  if (items.length === 0) {
    return <p className="text-xs text-text-muted">No issues found.</p>;
  }

  const renderItem = (i: IssueItem) => {
    const meta = SEVERITY_META[i.severity];
    return (
      <div className="flex items-start gap-s2 px-s3 py-1.5 text-xs" data-testid="import-issue">
        <meta.Icon className="mt-0.5 size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {i.where ? <span className="font-medium text-text">{i.where}: </span> : null}
          <span className="text-text">{i.message}</span>{' '}
          <span className="font-mono text-2xs text-text-muted">{i.code}</span>
        </span>
      </div>
    );
  };

  return (
    <div className="space-y-s2" data-testid="import-issues">
      <div role="group" aria-label={`${label}: severity`} className="flex flex-wrap gap-s2">
        {SEVERITY_ORDER.map((s) => {
          const meta = SEVERITY_META[s];
          return (
            <button
              key={s}
              type="button"
              aria-pressed={severity === s}
              onClick={() => setChosen(s)}
              className={cn(
                'inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                severity === s
                  ? 'border-primary bg-primary-subtle text-primary-subtle-fg'
                  : 'border-border-strong text-text-muted',
              )}
            >
              <meta.Icon className="size-3" aria-hidden="true" />
              {meta.plural}
              <Badge tone={meta.tone}>{counts[s]}</Badge>
            </button>
          );
        })}
      </div>
      <div
        ref={scrollRef}
        className="max-h-60 overflow-auto rounded-md border border-border"
        role="region"
        aria-label={`${label}: ${SEVERITY_META[severity].plural}`}
        tabIndex={0}
      >
        {shown.length === 0 ? (
          <p className="px-s3 py-s2 text-xs text-text-muted">None.</p>
        ) : virtual ? (
          <ul style={{ height: virtualizer.getTotalSize(), position: 'relative' }} data-virtualized="true">
            {virtualizer.getVirtualItems().map((v) => {
              const item = shown[v.index];
              if (!item) return null;
              return (
                <li
                  key={item.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${String(v.start)}px)`,
                  }}
                >
                  {renderItem(item)}
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((i) => (
              <li key={i.id}>{renderItem(i)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
