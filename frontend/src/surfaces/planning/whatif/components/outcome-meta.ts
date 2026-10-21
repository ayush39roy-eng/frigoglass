import type { WhatIfOutcome } from '../../api/whatif-types';

export const OUTCOME_LABEL: Record<WhatIfOutcome, string> = {
  within_year: 'Within the year',
  spillover: 'Spills over',
  left_out: 'Not placed',
  blocked: 'On hold',
  excluded: 'Excluded',
  data_error: 'Data error',
};

export const OUTCOME_TONE: Record<WhatIfOutcome, 'success' | 'warning' | 'neutral' | 'danger'> = {
  within_year: 'success',
  spillover: 'warning',
  left_out: 'warning',
  blocked: 'neutral',
  excluded: 'neutral',
  data_error: 'danger',
};

export const OUTCOME_ORDER: WhatIfOutcome[] = ['within_year', 'spillover', 'left_out', 'blocked', 'excluded', 'data_error'];
