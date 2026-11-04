import { describe, expect, it } from 'vitest';

import { stage } from '@/surfaces/project-workspace/test-fixtures';

import { unplacedTimingEditable } from './complete-step-rows';

describe('unplacedTimingEditable (mirror of ADR 0019 §4, offer only; the server decides)', () => {
  const base = { canWriteGantt: true, frozen: false, status: 'In Queue' as const };
  it.each([
    [{}, {}, 'move_resize'],
    [{}, { status: 'In Progress' as const }, 'resize'],
    [{}, { status: 'Blocked' as const }, 'resize'],
    [{}, { status: 'Done' as const }, 'none'],
    [{}, { skipped: true }, 'none'],
    [{ canWriteGantt: false }, {}, 'none'],
    [{ frozen: true }, {}, 'none'],
    [{ status: 'On Hold' as const }, {}, 'none'],
    [{ status: 'Commercialized' as const }, {}, 'none'],
  ])('%o / stage %o → %s', (facts, stageOver, expected) => {
    expect(unplacedTimingEditable({ ...base, ...facts, stage: stage(4, stageOver) })).toBe(expected);
  });
});
