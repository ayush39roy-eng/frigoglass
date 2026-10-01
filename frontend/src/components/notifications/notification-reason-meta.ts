import type * as React from 'react';
import { CircleAlert, CircleOff, Clock, OctagonPause } from 'lucide-react';

import type { BadgeProps } from '@/components/ui/badge';
import type { NotificationReason } from '@/types/enums';

/**
 * Presentation metadata for the three in-app notification reasons (P5-T06
 * `backend/models/enums.py::NotificationReason`). Mirrors
 * `components/shared/schedule-outcome-meta.ts`'s pattern and, deliberately,
 * its colour semantics — these reasons are directly downstream of the same
 * scheduling outcomes that module already covers, so a user should never learn
 * a second colour vocabulary for what is substantively the same signal:
 * - `delay_introduced` reads the same as `SPILLOVER` (a schedule slip) → warning.
 * - `project_left_out` reads the same as `LEFT_OUT` → warning.
 * - `conflict_raised` covers both `eng_conflict`/`chamber_overlap`
 *   (`services/notifications.py`'s own `bool_or` over both columns) → danger,
 *   same as `ENG_CONFLICT`/`OVERLAP`.
 * - `stage_blocked` (P9) — a stage set to Blocked on the Project Workspace →
 *   warning (an obstacle to act on), deliberately NOT the red delay/conflict tone.
 * Every reason still pairs colour with an icon AND a text label (ui-ux-pro-max
 * SKILL — colour is never the sole carrier of meaning).
 */
export interface NotificationReasonMeta {
  tone: NonNullable<BadgeProps['tone']>;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

export const NOTIFICATION_REASON_META: Record<NotificationReason, NotificationReasonMeta> = {
  delay_introduced: { tone: 'warning', label: 'Delay introduced', Icon: Clock },
  project_left_out: { tone: 'warning', label: 'Project left out', Icon: CircleOff },
  conflict_raised: { tone: 'danger', label: 'Conflict raised', Icon: CircleAlert },
  stage_blocked: { tone: 'warning', label: 'Stage blocked', Icon: OctagonPause },
};
