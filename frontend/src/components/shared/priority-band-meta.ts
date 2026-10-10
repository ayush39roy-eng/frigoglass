import type { ProjectPriority } from '@/types/enums';

/** Band tokens and titles for the priority pill and the P11 move control.
 *  Colour is always paired with the text label (ui-ux-pro-max). */
export const PRIORITY_BAND_STYLES: Record<ProjectPriority, { dot: string; tint: string; label: string }> = {
  P1: { dot: 'bg-band-p1', tint: 'bg-band-p1/12', label: 'P1' },
  P2: { dot: 'bg-band-p2', tint: 'bg-band-p2/12', label: 'P2' },
  P3: { dot: 'bg-band-p3', tint: 'bg-band-p3/12', label: 'P3' },
  P4: { dot: 'bg-band-p4', tint: 'bg-band-p4/12', label: 'P4' },
  Q: { dot: 'bg-band-q', tint: 'bg-band-q/12', label: 'Q' },
};

export const PRIORITY_BAND_TITLE: Record<ProjectPriority, string> = {
  P1: 'Priority band P1 — highest',
  P2: 'Priority band P2',
  P3: 'Priority band P3',
  P4: 'Priority band P4 — lowest scored',
  Q: 'Queue — not yet scored',
};
