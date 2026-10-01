import * as React from 'react';
import { ShieldAlert } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/**
 * The engineer half of the "engineers × weeks" utilization matrix is WITHHELD.
 *
 * `GET /capacity/utilization-matrix` returns named per-engineer weekly load
 * (`EngineerWeekLoad.name`), which is GDPR personal data. Per
 * `docs/OPEN_QUESTIONS.md` #8 and P4-T08 (BLOCKED), no named-engineer
 * utilization view ships until Data Protection sign-off. This surface therefore
 * renders only the chamber (equipment) side of the matrix plus hub-level
 * aggregates, with this visible placeholder where the per-engineer view will go.
 * The endpoint's engineer array is never read into a rendered list here.
 *
 * RESTYLED 2026-10-01 (Capacity Boltshift reskin) to a proper Boltshift empty-
 * state card (`rounded-dash`/`border-dash-hairline`/`bg-dash-alt`, the same
 * tokens `<BoltCard>` reads) rather than the shared `EmptyState`'s default
 * dashed grey well, via its own `className` override only — the shared
 * `EmptyState` component itself is untouched, so every other surface's empty
 * states keep their current look. This is a restyle of the WITHHELD-state
 * messaging only, never a loosening of the GDPR gate it enforces.
 */
export function EngineerUtilizationPlaceholder(): React.JSX.Element {
  return (
    <EmptyState
      className="rounded-dash border-solid border-dash-hairline bg-dash-alt py-10"
      media={<ShieldAlert className="size-8" />}
      title="Per-engineer utilization pending GDPR sign-off"
      description="Named per-engineer weekly load is personal data under GDPR. This engineers × weeks view is withheld until Data Protection sign-off (OPEN_QUESTIONS #8 / P4-T08). Chamber utilization — equipment, not personal data — is shown above; hub-level design load vs. capacity is in the panel above that."
    />
  );
}
