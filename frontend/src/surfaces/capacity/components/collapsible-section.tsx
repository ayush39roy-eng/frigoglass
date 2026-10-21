import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A disclosure for the big, rarely-needed Capacity sections (P19-T01): a full-width
 * button that shows/hides its panel. COLLAPSED BY DEFAULT and LAZY: while closed the
 * children are not rendered at all, so their charts, heatmaps and data queries
 * (the engineer-utilization read is audited per read) do not run until the user
 * asks. Keyboard: a real `<button>` (Enter / Space), `aria-expanded` +
 * `aria-controls`; focus stays on the button when it toggles, so nothing needs
 * managing. The chevron turn is a CSS transition, zeroed by the sitewide
 * `prefers-reduced-motion` rule.
 */
export interface CollapsibleSectionProps {
  /** Button text when closed, e.g. "Show chamber utilization". */
  showLabel: string;
  /** Button text when open; defaults to `showLabel` with "Show" -> "Hide". */
  hideLabel?: string;
  /** One line under the label saying what is inside. */
  hint?: string;
  children: React.ReactNode;
  testId?: string;
  /** Start open (tests only; the product default is closed). */
  defaultOpen?: boolean;
}

export function CollapsibleSection({
  showLabel,
  hideLabel,
  hint,
  children,
  testId,
  defaultOpen = false,
}: CollapsibleSectionProps): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen);
  const panelId = React.useId();
  const hintId = React.useId();
  const label = open ? (hideLabel ?? showLabel.replace(/^Show\b/, 'Hide')) : showLabel;
  return (
    <section className="space-y-s3" data-testid={testId}>
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={label}
          aria-describedby={hint ? hintId : undefined}
          onClick={() => {
            setOpen((v) => !v);
          }}
          className={cn(
            'flex w-full items-center justify-between gap-s3 rounded-dash border border-dash-hairline bg-surface px-card-tight py-s3 text-left shadow-dashCard',
            'transition-colors hover:bg-dash-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <span className="min-w-0">
            <span className="block text-sm font-bold text-text">{label}</span>
            {hint ? <span id={hintId} className="block text-2xs font-medium text-text-muted">{hint}</span> : null}
          </span>
          <ChevronDown
            className={cn('size-4 shrink-0 text-text-muted transition-transform duration-fast', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </h2>
      <div id={panelId} hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  );
}
