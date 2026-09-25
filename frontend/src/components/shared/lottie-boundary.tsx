import * as React from 'react';

import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { cn } from '@/lib/utils';

import { ErrorBoundary } from './error-boundary';

/**
 * The ONLY sanctioned entry point for Lottie in this codebase.
 *
 * Permitted uses (CLAUDE.md / frontend-builder SKILL / Standing Decisions) — exactly three:
 *   1. empty states
 *   2. solver progress (SSE-driven queued → running → done)
 *   3. success confirmations
 * Anything else (hover effects, page transitions, decoration) is Framer Motion's job.
 *
 * Behaviour:
 *   - `lottie-react` is lazy-loaded so it never lands in the initial bundle.
 *   - `prefers-reduced-motion` → the animation is not rendered at all; `poster` shows instead.
 *   - a render/load failure falls back to `poster` (or nothing) — a decorative animation
 *     must never take a surface down.
 */

type LottieCompProps = {
  src: string | object;
  loop?: boolean | number;
  autoplay?: boolean;
  className?: string;
  'aria-hidden'?: boolean;
};

const LazyLottie = React.lazy(async () => {
  const mod = await import('lottie-react');
  return { default: mod.Lottie as unknown as React.ComponentType<LottieCompProps> };
});

export interface LottieBoundaryProps {
  /** Parsed Lottie JSON (`import animation from './x.json'`) or a URL/path string. */
  src: string | object;
  /** Required: what the animation conveys, for assistive tech and the reduced-motion path. */
  label: string;
  loop?: boolean | number;
  autoplay?: boolean;
  className?: string;
  /** Static stand-in shown under reduced-motion, while loading, or on failure. */
  poster?: React.ReactNode;
}

export function LottieBoundary({
  src,
  label,
  loop = true,
  autoplay = true,
  className,
  poster = null,
}: LottieBoundaryProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const wrapperClass = cn('flex items-center justify-center', className);

  if (reducedMotion) {
    return (
      <div className={wrapperClass} role="img" aria-label={label}>
        {poster}
      </div>
    );
  }

  return (
    <div className={wrapperClass} role="img" aria-label={label}>
      <ErrorBoundary fallback={<>{poster}</>}>
        <React.Suspense fallback={<>{poster}</>}>
          <LazyLottie src={src} loop={loop} autoplay={autoplay} aria-hidden />
        </React.Suspense>
      </ErrorBoundary>
    </div>
  );
}
