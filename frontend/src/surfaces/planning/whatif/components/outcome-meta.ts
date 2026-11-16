import type { WhatIfOutcome } from '../../api/whatif-types';

export const OUTCOME_LABEL: Record<WhatIfOutcome, string> = {
  within_year: 'Within the year',
  spillover: 'Spills over',
  left_out: 'Not placed',
  blocked: 'On hold',
  excluded: 'Excluded',
  data_error: 'Data error',
  // P42 (ADR 0056): not counted this year.
  queued: 'Queued (not counted)',
  not_scheduled_priority: 'Not scheduled (P4)',
};

export const OUTCOME_TONE: Record<WhatIfOutcome, 'success' | 'warning' | 'neutral' | 'danger'> = {
  within_year: 'success',
  spillover: 'warning',
  left_out: 'warning',
  blocked: 'neutral',
  excluded: 'neutral',
  data_error: 'danger',
  queued: 'neutral',
  not_scheduled_priority: 'neutral',
};

export const OUTCOME_ORDER: WhatIfOutcome[] = [
  'within_year',
  'spillover',
  'left_out',
  'blocked',
  'queued',
  'not_scheduled_priority',
  'excluded',
  'data_error',
];
