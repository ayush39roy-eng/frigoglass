import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** Lists over this many rows mount only the visible rows (frontend rule: virtualize > 100). */
export const VIRTUALIZE_OVER = 100;

/**
 * The lists scroll (`max-h-72`) and their rows hold no focusable content, so the
 * scroll container itself takes focus: keyboard users scroll it with the arrow
 * keys (axe `scrollable-region-focusable`, P33-R02). Focus ring from the tokens.
 */
const SCROLL_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

/**
 * A project list for the apply dialog: a plain `<ul>` up to 100 rows, TanStack
 * Virtual beyond (≤ 330 projects per category, contract E2). Rows can wrap, so
 * the virtual rows are measured.
 */
export function ProjectRows<T>({
  rows,
  rowKey,
  renderRow,
  label,
  testId,
}: {
  rows: readonly T[];
  rowKey: (row: T) => string;
  renderRow: (row: T) => React.ReactNode;
  label: string;
  testId?: string;
}): React.JSX.Element {
  if (rows.length <= VIRTUALIZE_OVER) {
    return (
      <ul
        aria-label={label}
        tabIndex={0}
        className={`max-h-72 divide-y divide-border/70 overflow-y-auto rounded-md border border-border ${SCROLL_FOCUS}`}
        data-testid={testId}
      >
        {rows.map((row) => (
          <li key={rowKey(row)} className="px-3 py-2">
            {renderRow(row)}
          </li>
        ))}
      </ul>
    );
  }
  return <VirtualRows rows={rows} rowKey={rowKey} renderRow={renderRow} label={label} testId={testId} />;
}

const ESTIMATED_ROW = 56;

function VirtualRows<T>({
  rows,
  rowKey,
  renderRow,
  label,
  testId,
}: {
  rows: readonly T[];
  rowKey: (row: T) => string;
  renderRow: (row: T) => React.ReactNode;
  label: string;
  testId?: string | undefined;
}): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer (see eslint.config.js).
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW,
    overscan: 8,
    initialRect: { width: 640, height: 288 },
  });
  const items = virtualizer.getVirtualItems();
  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={label}
      tabIndex={0}
      className={`max-h-72 overflow-y-auto rounded-md border border-border ${SCROLL_FOCUS}`}
      data-testid={testId}
      data-virtualized="true"
    >
      <ul aria-label={label} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index];
          if (row === undefined) return null;
          return (
            <li
              key={rowKey(row)}
              data-index={item.index}
              aria-setsize={rows.length}
              aria-posinset={item.index + 1}
              ref={virtualizer.measureElement}
              className="absolute left-0 right-0 border-b border-border/70 px-3 py-2"
              style={{ transform: `translateY(${String(item.start)}px)` }}
            >
              {renderRow(row)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
