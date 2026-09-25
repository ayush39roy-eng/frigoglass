import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SCHEDULE_OUTCOME_META } from './schedule-outcome-meta';
import { ScheduleOutcomeBadge } from './schedule-outcome-badge';
import type { ScheduleOutcomeFlag } from '@/types/enums';

describe('ScheduleOutcomeBadge', () => {
  it('pairs every one of the five outcome flags with a label, not colour alone', () => {
    const flags = Object.keys(SCHEDULE_OUTCOME_META) as ScheduleOutcomeFlag[];
    expect(flags).toHaveLength(5);
    for (const flag of flags) {
      const { unmount } = render(<ScheduleOutcomeBadge flag={flag} />);
      expect(screen.getByText(SCHEDULE_OUTCOME_META[flag].label)).toBeInTheDocument();
      unmount();
    }
  });

  it('exposes the label to assistive tech even in icon-only mode', () => {
    render(<ScheduleOutcomeBadge flag="LEFT_OUT" iconOnly />);
    expect(screen.getByText('Left out')).toHaveClass('sr-only');
  });
});
