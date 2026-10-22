import { describe, expect, it } from 'vitest';

import { canonicalScoringTags, scoringTagsText } from './scoring-tags';

describe('scoring tags (P27, ADR 0038)', () => {
  it('keeps the server canonical order and drops duplicates', () => {
    expect(canonicalScoringTags(['improvement', 'new_customer', 'improvement'])).toEqual(['new_customer', 'improvement']);
  });

  it('reads as labels, or "—" when none', () => {
    expect(scoringTagsText(['regulatory_compliance', 'strategic_project'])).toBe(
      'Strategic Project, Regulatory / Business Compliance',
    );
    expect(scoringTagsText([])).toBe('—');
  });
});
