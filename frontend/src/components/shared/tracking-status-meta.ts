/**
 * Display copy for the served project tracking status (ADR 0021 §4,
 * API_CONTRACT_P12 §7). The status itself is computed by the server
 * (`services/tracking.py`); the browser only maps the wire value to a label.
 */

export const TRACKING_STATUSES = ['live', 'due', 'overdue', 'idle'] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export const TRACKING_STATUS_META: Record<
  TrackingStatus,
  { label: string; tone: 'success' | 'primary' | 'danger' | 'outline'; description: string }
> = {
  live: {
    label: 'Live',
    tone: 'success',
    description: 'Every stage due this week has been checked in this week.',
  },
  due: {
    label: 'Due this week',
    tone: 'primary',
    description: 'At least one stage due this week has not been checked in yet.',
  },
  overdue: {
    label: 'Overdue',
    tone: 'danger',
    description: 'A due stage has had no check-in this week or last week.',
  },
  idle: {
    label: 'No active stage',
    tone: 'outline',
    description: 'No stage of this project is due for a check-in this week.',
  },
};
