import { PRIORITY_LABELS, type ProjectPriority } from '@/types/enums';

/** Band tokens and titles for the priority pill and the P11 move control.
 *  Colour is always paired with the text label (ui-ux-pro-max). */
export const PRIORITY_BAND_STYLES: Record<ProjectPriority, { dot: string; tint: string; label: string }> = {
  P1: { dot: 'bg-band-p1', tint: 'bg-band-p1/12', label: 'P1' },
  P2: { dot: 'bg-band-p2', tint: 'bg-band-p2/12', label: 'P2' },
  P3: { dot: 'bg-band-p3', tint: 'bg-band-p3/12', label: 'P3' },
  P4: { dot: 'bg-band-p4', tint: 'bg-band-p4/12', label: 'P4' },
  Q: { dot: 'bg-band-q', tint: 'bg-band-q/12', label: 'Q' },
};

/**
 * P42 (R42-1): the band's name for headers and selects — "P1 · Must do this
 * year". Q is shown as "Q" (owner rule); its label is in the tooltip only.
 * `servedLabel` lets a payload's own label (e.g. the board column's `label`)
 * win over the static mirror.
 */
export function priorityBandName(priority: ProjectPriority, servedLabel?: string | null): string {
  if (priority === 'Q') return 'Q';
  return `${priority} · ${servedLabel ?? PRIORITY_LABELS[priority]}`;
}

/** P42 (R42-1): the tooltip / accessible name of a band —
 *  "Priority band P1 — Must do this year". */
export const PRIORITY_BAND_TITLE: Record<ProjectPriority, string> = {
  P1: `Priority band P1 — ${PRIORITY_LABELS.P1}`,
  P2: `Priority band P2 — ${PRIORITY_LABELS.P2}`,
  P3: `Priority band P3 — ${PRIORITY_LABELS.P3}`,
  P4: `Priority band P4 — ${PRIORITY_LABELS.P4}`,
  Q: `Priority band Q — ${PRIORITY_LABELS.Q}`,
};
