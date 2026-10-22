/**
 * "Delivery by priority" bar segments (Dashboard Portfolio analytics).
 *
 * Colour meaning (unchanged): finishing = green, not finishing = amber; in
 * flight is solid, not started is the light tint; delivered is blue, not in
 * plan grey.
 *
 * QA-F23-1 (WCAG 1.4.3): each segment prints its count in the bar, so each fill
 * carries its own ink, taken from the design token pair rather than a fixed
 * white: a solid fill uses its `-fg` token (dark ink on amber, white on green
 * and blue in light mode; the tokens flip in dark mode), the light tints and the
 * light grey use dark text. `fillToken` / `inkToken` / `alpha` / `ground` name
 * the CSS custom properties the classes resolve to, so
 * `delivery-segments-contrast.test.ts` measures every pair (≥ 4.5:1) in both
 * themes from `tokens.css`.
 */

import type { DisplayOutcome } from './outcome';

export type SegmentKey =
  | 'in_flight_finishing'
  | 'in_flight_not_finishing'
  | 'not_started_finishing'
  | 'not_started_not_finishing'
  | 'delivered'
  | 'not_in_plan';

export interface DeliverySegment {
  key: SegmentKey;
  label: string;
  /** Tailwind classes (static strings so the JIT sees them). */
  fill: string;
  ink: string;
  /** The tokens behind `fill` and `ink`, for the contrast test. */
  fillToken: string;
  inkToken: string;
  /** Fill opacity (`bg-x/40` → 0.4); the segment sits on the track (`ground`). */
  alpha: number;
  ground: string;
}

const TRACK = '--color-surface-sunken';

export const DELIVERY_SEGMENTS: readonly DeliverySegment[] = [
  {
    key: 'in_flight_finishing',
    label: 'In flight, finishing this year',
    fill: 'bg-success',
    ink: 'text-success-fg',
    fillToken: '--color-success',
    inkToken: '--color-success-fg',
    alpha: 1,
    ground: TRACK,
  },
  {
    key: 'in_flight_not_finishing',
    label: 'In flight, not finishing',
    fill: 'bg-warning',
    ink: 'text-warning-fg',
    fillToken: '--color-warning',
    inkToken: '--color-warning-fg',
    alpha: 1,
    ground: TRACK,
  },
  {
    key: 'not_started_finishing',
    label: 'Not started, finishing this year',
    fill: 'bg-success/40',
    ink: 'text-text',
    fillToken: '--color-success',
    inkToken: '--color-text',
    alpha: 0.4,
    ground: TRACK,
  },
  {
    key: 'not_started_not_finishing',
    label: 'Not started, not finishing',
    fill: 'bg-warning/40',
    ink: 'text-text',
    fillToken: '--color-warning',
    inkToken: '--color-text',
    alpha: 0.4,
    ground: TRACK,
  },
  {
    key: 'delivered',
    label: 'Already delivered',
    fill: 'bg-primary',
    ink: 'text-primary-fg',
    fillToken: '--color-primary',
    inkToken: '--color-primary-fg',
    alpha: 1,
    ground: TRACK,
  },
  {
    key: 'not_in_plan',
    label: 'Not in plan',
    fill: 'bg-border-strong',
    ink: 'text-text',
    fillToken: '--color-border-strong',
    inkToken: '--color-text',
    alpha: 1,
    ground: TRACK,
  },
];

/**
 * "Outcomes by hub" stacked bars (ADR 0024: three outcomes on the 52-week year;
 * a left-out project sits in the spillover segment). Same rule as above
 * (QA-F23-1, found on the same Dashboard by the live axe check): each fill's
 * count uses the ink of its token pair, never a fixed white.
 */
export interface HubOutcomeSegment {
  bucket: DisplayOutcome;
  label: string;
  fill: string;
  dot: string;
  ink: string;
  fillToken: string;
  inkToken: string;
}

export const HUB_OUTCOME_STACK: readonly HubOutcomeSegment[] = [
  {
    bucket: 'within_year',
    label: 'Within year',
    fill: 'bg-success',
    dot: 'bg-success',
    ink: 'text-success-fg',
    fillToken: '--color-success',
    inkToken: '--color-success-fg',
  },
  {
    bucket: 'spillover',
    label: 'Spillover (past W52)',
    fill: 'bg-warning',
    dot: 'bg-warning',
    ink: 'text-warning-fg',
    fillToken: '--color-warning',
    inkToken: '--color-warning-fg',
  },
  {
    bucket: 'blocked',
    label: 'On Hold at a stage',
    fill: 'bg-text-muted',
    dot: 'bg-text-muted',
    ink: 'text-text-inverse',
    fillToken: '--color-text-muted',
    inkToken: '--color-text-inverse',
  },
];
