import { describe, expect, it } from 'vitest';

import { badRankCopy, MOVE_COPY, notNeededCopy, previewNotNeededCopy, RANK_COPY, rankPositionCopy } from './move-copy';

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

describe('badRankCopy (owner request 2026-11-17)', () => {
  it('one past the current rank reads "already last"; any other says the position does not exist; never a band size', () => {
    expect(badRankCopy('Ann', 'P1', 4, 3)).toBe("Ann is already last in P1, so it can't move down. Nothing was changed.");
    expect(badRankCopy('Ann', 'P2', 40, 3)).toBe(
      'There is no position 40 in P2: the band has fewer projects than that. Choose a smaller number. Nothing was changed.',
    );
    expect(badRankCopy('Ann', 'P2', null, null)).toBe('That position does not exist in P2. Choose a smaller number. Nothing was changed.');
    for (const text of [badRankCopy('Ann', 'P1', 4, 3), badRankCopy('Ann', 'P1', 40, 3)]) expect(text).not.toMatch(/ of \d/);
  });
});
