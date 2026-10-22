import * as React from 'react';
import { motion } from 'framer-motion';

import { useMotionTokens } from '@/lib/motion';

/**
 * Page-mount stagger (Dashboard polish, 2026-09-30; retuned 2026-10-01 to the
 * Boltshift motion spec): each top-level section fades/rises in a few
 * milliseconds after the one before it, so the eye is guided down the page
 * instead of every panel popping in at once. Gated by `useMotionTokens()` — the
 * shared `prefers-reduced-motion` switch every other animated element in the app
 * reads from (`lib/motion.ts`) — and applied at the PAGE level, wrapping each
 * section from the outside, so none of the individual section components
 * (`WithinYearPanel`, `StatusOverviewCards`, …) needed their own internal DOM
 * changed; their existing unit tests are untouched by this.
 *
 * Boltshift's mount vocabulary is `y: 16 → 0` + opacity + `scale: 0.985 → 1` on
 * a `{stiffness: 300, damping: 30}` spring. The scale is on the SECTION
 * (everything settling into place together), never on an individual card hover
 * — the spec's own "DO NOT" list bans that, and `stat-card.tsx` / the spotlight
 * cards accordingly hover on `y` alone.
 *
 * Extracted from `DashboardPage.tsx` in P28 (ADR 0039) so the Executive view's
 * sections stagger with the identical vocabulary.
 */
const SECTION_VARIANTS = {
  hidden: { opacity: 0, y: 16, scale: 0.985 },
  show: { opacity: 1, y: 0, scale: 1 },
} as const;

const SECTION_SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const;

export function StaggerSection({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { reduced } = useMotionTokens();
  if (reduced) return <>{children}</>;
  return (
    <motion.div variants={SECTION_VARIANTS} transition={SECTION_SPRING}>
      {children}
    </motion.div>
  );
}

