import * as React from 'react';
import { Info } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * THE INFO AFFORDANCE — where Capacity's explanatory prose now lives.
 *
 * Client feedback, 2026-10-01: "remove all free text, there is a lot of text —
 * remove the unwanted explanatory text. Everything should be clean, no extra or
 * unwanted text except the heading and the details one, and all the text should
 * be part of something — into a card or box." Capacity was the worst offender in
 * the app: a four-paragraph "How to read these figures" aside above the first
 * card, a provenance sentence between every card header and its data, and a
 * definition paragraph on two more cards.
 *
 * NONE of that copy could be deleted. It is the hard-won framing that stops a
 * planner misreading this surface: the Load-vs-Capacity distinction (Invariants
 * I6 / I7, ADR 0007 / 0008), the "the scheduler applies NEITHER FTE NOR chamber
 * downtime when it books" caveat (ADR 0002 / 0008 — without it, "load > capacity"
 * reads as "the scheduler overbooked someone", which is false), and the
 * schedule-run provenance. So it moved HERE: an icon button in the owning card's
 * header, opening a popover holding the same words verbatim.
 *
 * DELIBERATE NEAR-DUPLICATE of `surfaces/dashboard/components/card-info.tsx`.
 * That file was created by a PARALLEL task from the same client instruction in
 * the same hour, and this task was explicitly told not to touch any Dashboard
 * file (that agent is mid-edit) and to keep shared-file changes strictly
 * additive. Promoting one copy into `components/ui/` would have required either
 * editing Dashboard's imports (forbidden) or racing that agent for the same new
 * path. The prop API here is IDENTICAL (`label`, `children`, `className`) so the
 * convergence — delete one, repoint imports — is mechanical once both land and
 * the tree is quiet. Flagged in docs/MEMORY.md for the orchestrator.
 *
 * Design rules this encodes (same as the Dashboard twin):
 *  - A real `<button>` inside a Radix `<Popover>`: keyboard reachable (Tab),
 *    dismissible (Escape), focus-managed, announced as a dialog with an
 *    accessible name. The prose stays fully reachable by assistive tech — it is
 *    just no longer shouted as body copy. `aria-label` is REQUIRED (the icon is
 *    `aria-hidden`), so every call site has to name what it explains.
 *  - Enter/exit motion comes from Radix's own `data-[state]` classes already on
 *    `popover.tsx` (tailwindcss-animate), NOT framer-motion — Radix unmounts
 *    content on close, and the sitewide `prefers-reduced-motion` rule in
 *    `index.css` already zeroes these CSS durations.
 *  - Short, stable FACTS (run version, solver, computed-at) do NOT belong in
 *    here — those became chips (`run-provenance-chips.tsx`). This is for
 *    sentences only.
 */

export interface CapacityInfoProps {
  /** Accessible name of the trigger AND the popover's visible heading. */
  label: string;
  /** The prose. Sentences, not numbers — a figure belongs on the card itself. */
  children: React.ReactNode;
  className?: string;
}

export function CapacityInfo({ label, children, className }: CapacityInfoProps): React.JSX.Element {
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
