import * as React from 'react';
import { Info } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * THE INFO AFFORDANCE — where the Dashboard's explanatory prose now lives.
 *
 * Client feedback, 2026-10-01: "remove all free text… everything should be
 * clean, no extra or unwanted text except the heading and the details one, and
 * all text should be part of something — into a card or box." The Dashboard had
 * ~6 paragraphs of `<p className="text-2xs text-text-muted">` body copy sitting
 * loose under card titles and chart figures.
 *
 * None of that copy could simply be DELETED: most of it is domain-critical
 * provenance — the Invariant I9 "not recomputed in your browser" statement, the
 * "source: live project registry vs. active schedule run" distinction (the two
 * senses of "spillover" collide if that distinction is lost, see
 * `pipeline-panel.tsx`), and the counting-rule definitions straight out of
 * `DOMAIN_RULES.md`. So it moved HERE: a 24px icon button in the owning card's
 * header, opening a popover that holds the same words verbatim.
 *
 * Design rules this encodes:
 *  - It is a real `<button>` inside a Radix `<Popover>`, so it is keyboard
 *    reachable (Tab), dismissible (Escape), focus-managed, and announced as a
 *    dialog with an accessible name — the prose is still fully reachable by
 *    assistive tech, just not shouted as body copy. `aria-label` is REQUIRED
 *    (the icon is `aria-hidden`), so every call site names what it explains.
 *  - Enter/exit motion comes from Radix's own `data-[state]` classes already on
 *    `popover.tsx` (tailwindcss-animate), NOT from a framer-motion
 *    `AnimatePresence`: Radix unmounts the content on close, so an exit
 *    animation would need `forceMount` + manual presence plumbing, and the
 *    sitewide `prefers-reduced-motion` rule in `index.css` already zeroes these
 *    CSS durations. Same reasoning as `app-sidebar.tsx`'s CSS-transition active
 *    bar (docs/MEMORY.md 2026-10-01).
 *  - Anything that is a short, stable FACT (run version, solver, computed-at)
 *    does NOT belong in here — that became a chip
 *    (`schedule-run-provenance.tsx`). This is for sentences only.
 */

export interface CardInfoProps {
  /** Accessible name of the trigger AND the popover's visible heading. */
  label: string;
  /** The prose. Sentences, not numbers — a figure belongs on the card itself. */
  children: React.ReactNode;
  className?: string;
}

export function CardInfo({ label, children, className }: CardInfoProps): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex size-7 shrink-0 items-center justify-center rounded-full',
            'text-text-subtle transition-colors duration-fast ease-ease-out-expo',
            'hover:bg-dash-alt hover:text-text',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
            className,
          )}
        >
          <Info className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 rounded-dash border-dash-hairline p-s4 shadow-pop data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1"
      >
        <p className="label-caps mb-s2 text-text-subtle">{label}</p>
        <div className="space-y-1.5 text-2xs leading-relaxed text-text-muted">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
