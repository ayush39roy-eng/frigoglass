/**
 * OQ#8 (GDPR) name rendering, per the P9-T03 behaviour: every person name on
 * the workspace (`author_name`, `uploaded_by_name`, `actor_name`,
 * `leader_engineer_name`, `assigned_engineer_name`) is `null` unless that
 * person IS the caller. So a non-null name is always the caller's own, and is
 * labelled as such; a null is "Withheld (GDPR pending)", never guessed.
 */
export const WITHHELD = 'Withheld (GDPR pending)';

export function personLabel(name: string | null): string {
  return name === null ? WITHHELD : `${name} (you)`;
}

/** Comment author: we also know the author's user id, so the caller's own
 *  comments read "You" even if the name were ever withheld. */
export function authorLabel(name: string | null, authorUserId: string, currentUserId: string | null): string {
  if (currentUserId !== null && authorUserId === currentUserId) return 'You';
  return personLabel(name);
}

/** The four fields `services/workspace.py::_FINANCIAL_FIELDS` nulls for a role
 *  without Project Registration read. */
export const RESTRICTED_FINANCIAL_FIELDS = ['customer_name', 'tcogs_eur', 'selling_price_eur', 'gross_margin_pct'] as const;
export const RESTRICTED = 'Restricted';
