import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

/**
 * THE MOTION LANGUAGE.
 *
 * Motion exists to make a state change legible. It is not decoration. This is a tool
 * people sit in front of for six hours a day, and anything that delights on the first
 * view irritates on the two-hundredth — so the vocabulary here is deliberately small
 * and every entry names the state change it explains.
 *
 * Deliberately NOT importing framer-motion at module scope. These are plain objects
 * that happen to be shaped like Framer transitions/variants, so the app shell can
 * import the motion language without pulling Framer Motion into the initial bundle.
 * Framer stays a per-surface lazy dependency (see use-prefers-reduced-motion.ts).
 *
 * CSS-driven motion is covered separately by the --dur-* tokens, which the reduced-
 * motion media query zeroes in one place. JS-driven springs never touch CSS custom
 * properties, which is why they need useMotionTokens() below.
 */

/* -------------------------------------------------------------------------- */
/* Durations (seconds — Framer's unit, unlike the CSS tokens which are ms)     */
/* -------------------------------------------------------------------------- */

export const DURATION = {
  instant: 0.08,
  fast: 0.12,
  base: 0.18,
  slow: 0.22,
} as const;

/** Matches --ease-out in tokens.css. A strong out-curve: fast start, soft landing. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/* -------------------------------------------------------------------------- */
/* Springs                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one spring in the system, used for anything that changes SIZE or POSITION —
 * Gantt row expand/collapse, drawer travel, Matrix card drag settle.
 *
 * stiffness 380 / damping 34 is just under critical damping: it arrives quickly with
 * a barely perceptible settle, which reads as "physical" without the cartoon overshoot
 * that a lower damping would give. Deliberately one spring, not a family — a second
 * spring would be indistinguishable to a user and impossible to keep consistent.
 */
export const SPRING = { type: 'spring', stiffness: 380, damping: 34 } as const;

/* -------------------------------------------------------------------------- */
/* Variants — each named for the state change it explains                      */
/* -------------------------------------------------------------------------- */

/**
 * Route transition. Opacity plus a 4px rise — just enough to signal "this is new
 * content", not enough to read as a slide. A horizontal slide would imply a spatial
 * relationship between surfaces that does not exist: the Matrix is not "to the right
 * of" the Dashboard.
 */
export const routeVariants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -2 },
} as const;

/** Drawers and modals. Slightly longer than a route change because they occlude. */
export const overlayVariants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 },
} as const;

/** Toasts enter from the top, where the eye already is after an action. */
export const toastVariants = {
  initial: { opacity: 0, y: -12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
} as const;

/* -------------------------------------------------------------------------- */
/* The single reduced-motion gate                                              */
/* -------------------------------------------------------------------------- */

export interface MotionTokens {
  /** True when the user has asked for reduced motion. */
  reduced: boolean;
  /** Durations, zeroed when reduced. */
  duration: typeof DURATION;
  /** The spring, degraded to an instant transition when reduced. */
  spring: typeof SPRING | { duration: 0 };
  /** `layout` prop value — false when reduced, so Framer skips layout projection. */
  layout: boolean;
  /** Ready-made transition for the common opacity/position case. */
  transition: { duration: number; ease: typeof EASE_OUT } | { duration: 0 };
}

const ZERO_DURATION = {
  instant: 0,
  fast: 0,
  base: 0,
  slow: 0,
} as unknown as typeof DURATION;

/**
 * ONE hook, not a per-component media-query check.
 *
 * Every animated component reads its timings from here, so honouring
 * `prefers-reduced-motion` is a property of the design system rather than a thing
 * 40 components each have to remember. When reduced, durations collapse to 0 and
 * `layout` goes false — which matters, because Framer's layout projection is the
 * expensive, motion-sickness-inducing part, and simply setting duration 0 does not
 * disable it.
 */
export function useMotionTokens(): MotionTokens {
  const reduced = usePrefersReducedMotion();

  if (reduced) {
    return {
      reduced,
      duration: ZERO_DURATION,
      spring: { duration: 0 },
      layout: false,
      transition: { duration: 0 },
    };
  }

  return {
    reduced,
    duration: DURATION,
    spring: SPRING,
    layout: true,
    transition: { duration: DURATION.base, ease: EASE_OUT },
  };
}

/* -------------------------------------------------------------------------- */
/* What must NEVER animate                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Documented here because it is the half of the motion language that gets forgotten:
 *
 *  - Table rows on data change. A 236-row stagger is ~4 seconds of unusable UI, and
 *    the Matrix re-sorts on every filter keystroke.
 *  - Chart re-renders on filter change. Instant. A re-animating bar chart makes the
 *    user wait to read a number they already asked for.
 *  - Anything triggered by typing.
 *  - Anything that can fire more than once per user interaction.
 *  - Spinners that pulse, breathe, or rotate at a variable rate — a constant-rate
 *    rotation is the only honest loading signal, because a varying one implies
 *    progress information the app does not have.
 *
 * These are enforced by review, not by code, because the failure is always someone
 * adding motion where none existed rather than misusing a token from this file.
 */
export const NEVER_ANIMATE = Object.freeze([
  'table-rows-on-data-change',
  'chart-rerender-on-filter',
  'typing-triggered',
  'repeated-per-interaction',
  'variable-rate-spinners',
] as const);
