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
 */
export function EngineerUtilizationPlaceholder(): React.JSX.Element {
  return (
    <EmptyState
      media={<ShieldAlert className="size-8" />}
      title="Per-engineer utilization pending GDPR sign-off"
      description="Named per-engineer weekly load is personal data under GDPR. This engineers × weeks view is withheld until Data Protection sign-off (OPEN_QUESTIONS #8 / P4-T08). Chamber utilization — equipment, not personal data — is shown above; hub-level design load vs. capacity is in the panel above that."
    />
  );
}
