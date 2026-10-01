import { describe, expect, it } from 'vitest';

import type { CommentRead } from '../api/types';
import { canStillEdit, EDIT_WINDOW_MS, mentionQueryAt } from './comments';

const c = (over: Partial<CommentRead>): CommentRead => ({
  id: 'c1',
  body_md: 'x',
  author_name: 'A',
  author_user_id: 'u1',
  created_at: '2026-09-27T10:00:00Z',
  edited_at: null,
  can_edit: true,
  mentioned_user_ids: [],
  ...over,
});

describe('canStillEdit — the 15-minute author edit lock', () => {
  const created = Date.parse('2026-09-27T10:00:00Z');
  it('server can_edit=false always wins', () => {
    expect(canStillEdit(c({ can_edit: false }), created + 1000)).toBe(false);
  });
  it('the affordance disappears once 15 minutes pass on an open page', () => {
    expect(canStillEdit(c({}), created + EDIT_WINDOW_MS - 1)).toBe(true);
    expect(canStillEdit(c({}), created + EDIT_WINDOW_MS)).toBe(false);
  });
});

describe('mentionQueryAt', () => {
  it('finds the @query before the caret', () => {
    expect(mentionQueryAt('hello @han', 10)).toEqual({ query: 'han', start: 6 });
    expect(mentionQueryAt('@a', 2)).toEqual({ query: 'a', start: 0 });
  });
  it('ignores emails mid-word and finished mentions', () => {
    expect(mentionQueryAt('mail me@x', 9)).toBeNull();
    expect(mentionQueryAt('hi @hana ', 9)).toBeNull();
  });
});
