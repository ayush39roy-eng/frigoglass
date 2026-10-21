/**
 * P24-T02 (ADR 0035): the three read-only charter fields served on
 * `ProjectRead`, `WorkspaceProject` and `ProjectFilterRow` (the client
 * workbook's `Plant/OEM`, `Requesting Department` and `Product Type`).
 * Display metadata only.
 */

export type CharterFieldKey = 'plant' | 'requesting_department' | 'product_type';

export type CharterFields = Record<CharterFieldKey, string | null>;

export const CHARTER_FIELDS: readonly { key: CharterFieldKey; label: string; short: string }[] = [
  { key: 'plant', label: 'Plant', short: 'Plant' },
  { key: 'requesting_department', label: 'Requesting department', short: 'Req. dept' },
  { key: 'product_type', label: 'Product type', short: 'Product type' },
];

export const CHARTER_NOT_SET = 'Not set';
