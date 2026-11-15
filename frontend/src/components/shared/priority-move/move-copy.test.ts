import { describe, expect, it } from 'vitest';

import { MOVE_COPY, notNeededCopy, previewNotNeededCopy, RANK_COPY, rankPositionCopy } from './move-copy';

describe('rankPositionCopy (P36-R02, W36-1)', () => {
  it('reads "position N in <band>" and never "of M"', () => {
    expect(rankPositionCopy(2, 'P1')).toBe('position 2 in P1');
    // A hub-scoped / filtered column can hold fewer cards than the full-band rank.
    expect(rankPositionCopy(23, 'P1')).toBe('position 23 in P1');
    expect(rankPositionCopy(23, 'P1')).not.toMatch(/ of /);
  });

  it('a null position (unknown display position) is "a new position in <band>"', () => {
    expect(rankPositionCopy(null, 'Q')).toBe('a new position in Q');
  });

  it('takes no band size argument', () => {
    expect(rankPositionCopy.length).toBe(2);
  });
});

describe('previewNotNeededCopy', () => {
  it('names the status when served', () => {
    expect(previewNotNeededCopy('On Hold')).toBe(
      "This project isn't in the plan (status On Hold), so moving it changes no timeline. Yes saves the new priority.",
    );
  });

  it.each([null, undefined, ''])('omits the status when it is %j', (status) => {
    expect(previewNotNeededCopy(status)).toBe(
      "This project isn't in the plan, so moving it changes no timeline. Yes saves the new priority.",
    );
  });
});

describe('notNeededCopy', () => {
  it('names the status when served', () => {
    expect(notNeededCopy('Draft')).toBe("Saved. This project isn't in the plan (status Draft), so no timeline change.");
  });

  it.each([null, undefined, ''])('omits the status when it is %j', (status) => {
    expect(notNeededCopy(status)).toBe("Saved. This project isn't in the plan, so no timeline change.");
  });
});

describe('copy tables', () => {
  it('rank copy never states a band size', () => {
    for (const text of [...Object.values(RANK_COPY), ...Object.values(MOVE_COPY)]) {
      expect(text).not.toMatch(/position \d+ of \d+/);
    }
  });
});
