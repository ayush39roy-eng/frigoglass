/**
 * Person-name rendering (ADR 0028 lifted the OQ#8 withholding): the API serves
 * names to every caller who can read the project. A `null` name is shown as
 * "Name unavailable" only as a fallback (an id with no resolvable name) and
 * is never guessed.
 */
export const NAME_UNAVAILABLE = 'Name unavailable';

export function personLabel(name: string | null): string {
  return name === null ? NAME_UNAVAILABLE : name;
}

/** Comment author: the caller's own comments read "You". */
export function authorLabel(name: string | null, authorUserId: string, currentUserId: string | null): string {
  if (currentUserId !== null && authorUserId === currentUserId) return 'You';
  return personLabel(name);
}

/** The four fields `services/workspace.py::_FINANCIAL_FIELDS` nulls for a role
 *  without Project Registration read. */
export const RESTRICTED_FINANCIAL_FIELDS = ['customer_name', 'tcogs_eur', 'selling_price_eur', 'gross_margin_pct'] as const;
export const RESTRICTED = 'Restricted';
