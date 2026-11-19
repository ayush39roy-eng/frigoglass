/**
 * P51-T02: the one client-side project search matcher (DOMAIN_RULES "Project
 * search"; the same rule the server applies to `q` in `services/text_search.py`).
 *
 * - Case-insensitive; leading / trailing whitespace is ignored; blank = no filter.
 * - `*` matches any run of characters (including none), `?` exactly one character.
 * - Every other character (`% _ \ - / + ( ) [ ] . & ' " # > < =`, non-ASCII …)
 *   matches literally (regex specials are escaped).
 * - Still a substring match: a term without `*` / `?` behaves exactly as the old
 *   `value.toLowerCase().includes(term)`, and `SP*` finds any value containing "SP".
 */

/** Matches when ANY of the given values contains the term. */
export type SearchMatcher = (...values: ReadonlyArray<string | null | undefined>) => boolean;

// The `u` flag only allows escaping syntax characters and `/` (not `-`).
const REGEX_SPECIALS = /[.+^${}()|[\]\\/]/g;

/** The regex source for a lower-cased term: specials escaped, `*` → `.*`, `?` → `.`. */
export function wildcardSource(term: string): string {
  let out = '';
  for (const ch of term) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(REGEX_SPECIALS, '\\$&');
  }
  return out;
}

/**
 * Compile a search term once (outside the row loop). Returns `null` for a blank
 * term so callers can skip filtering entirely.
 */
export function compileSearch(term: string | null | undefined): SearchMatcher | null {
  const needle = (term ?? '').trim().toLowerCase();
  if (needle === '') return null;
  let test: (value: string) => boolean;
  if (!needle.includes('*') && !needle.includes('?')) {
    test = (value) => value.includes(needle);
  } else {
    // `s`: `.` also crosses line breaks; `u`: `?` is one code point (as Postgres `_`).
    const re = new RegExp(wildcardSource(needle), 'su');
    test = (value) => re.test(value);
  }
  return (...values) => values.some((v) => typeof v === 'string' && test(v.toLowerCase()));
}

/** One-off convenience: does any value match `term`? A blank term matches everything. */
export function matchesSearch(term: string | null | undefined, ...values: ReadonlyArray<string | null | undefined>): boolean {
  const matcher = compileSearch(term);
  return matcher === null || matcher(...values);
}
