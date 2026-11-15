import * as React from 'react';
import { SlidersHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * P21 sticky "View" panel. It sticks to the top of the surface scroll region
 * (directly under the app header) and turns compact while stuck: smaller
 * paddings, a subtle shadow, the controls in one row. P34-T02 (owner ask): the
 * CAT / TYPE / HUB / STATUS / Capacity fill / VIP filters stay visible while
 * stuck, as one compact line that scrolls sideways when it does not fit (they
 * were folded behind a "Filters (n)" button). Below `md` it is a
 * single "View & filters" button that opens a bottom sheet with every control.
 * The grid has its own scroll region, so the panel never covers the grid's
 * sticky header. Motion is a short padding/shadow transition, off under
 * reduced motion.
 */

export interface MatrixViewPanelProps {
  stuck: boolean;
  narrow: boolean;
  /** The control row; `compact` while stuck. */
  renderControls: (compact: boolean) => React.ReactNode;
  /** The chip filter rows. */
  filters: React.ReactNode;
  /** Number of active filters, for the narrow "View & filters (n)" button. */
  filterCount: number;
  /** A short summary shown on the narrow bar (e.g. the currency). */
  summary?: React.ReactNode;
  /** The sticky element, measured by the page to size the grid. */
  panelRef?: React.Ref<HTMLElement>;
}

export function MatrixViewPanel({
  stuck,
  narrow,
  renderControls,
  filters,
  filterCount,
  summary,
  panelRef,
}: MatrixViewPanelProps): React.JSX.Element {
  const filtersId = React.useId();
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const countText = filterCount > 0 ? ` (${String(filterCount)})` : '';

  const shell = cn(
    'sticky top-0 z-20 rounded-card border-2 border-border-strong/60 bg-surface text-text',
    'transition-[padding,box-shadow] duration-200 ease-out motion-reduce:transition-none',
    stuck ? 'px-3 py-2 shadow-pop' : 'px-card py-s3 shadow-card',
  );

  if (narrow) {
    return (
      <>
        <section
          ref={panelRef}
          aria-label="View"
          className={shell}
          data-testid="matrix-view-panel"
          data-stuck={stuck ? 'true' : 'false'}
        >
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSheetOpen(true)} aria-haspopup="dialog">
              <SlidersHorizontal aria-hidden="true" />
              View &amp; filters{countText}
            </Button>
            {summary ? <span className="min-w-0 truncate text-2xs text-text-muted">{summary}</span> : null}
          </div>
        </section>
        <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
          <DialogContent
            className={cn(
              // Bottom sheet on a narrow screen.
              'bottom-0 top-auto max-h-[88dvh] w-full max-w-none translate-y-0 overflow-y-auto rounded-b-none rounded-t-xl p-4',
              'data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100',
            )}
            data-testid="matrix-view-sheet"
          >
            <DialogHeader>
              <DialogTitle>View &amp; filters</DialogTitle>
              <DialogDescription>Currency, scenario mode, history, layout, export and filters.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-3">{renderControls(false)}</div>
              <div className="flex flex-col gap-3 border-t border-border pt-3">{filters}</div>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <section ref={panelRef} aria-labelledby={`${filtersId}-title`} className={shell} data-testid="matrix-view-panel" data-stuck={stuck ? 'true' : 'false'}>
      {/* Owner ask 2026-10-22: no visible "View" title; the controls sit on one aligned line. */}
      <h2 id={`${filtersId}-title`} className="sr-only">
        View
      </h2>
      <div className={cn('flex flex-wrap items-center', stuck ? 'gap-2' : 'gap-x-4 gap-y-2')}>
        {renderControls(stuck)}
      </div>
      <div
        id={filtersId}
        className={cn(
          'flex items-center border-t border-border',
          stuck
            ? // One compact line; scrolls sideways when it does not fit.
              'mt-1.5 flex-nowrap gap-x-4 overflow-x-auto pt-1.5 scrollbar-thin [&>*]:shrink-0 [&_[role=group]]:flex-nowrap [&_[role=radiogroup]]:flex-nowrap'
            : 'mt-2.5 flex-wrap gap-x-6 gap-y-2 pt-2.5',
        )}
        data-testid="matrix-view-filters"
        data-compact={stuck ? 'true' : undefined}
      >
        {filters}
      </div>
    </section>
  );
}
