import * as React from 'react';
import { FileSpreadsheet } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * P24-T02 (ADR 0035): the three read-only charter fields the API serves on
 * `ProjectRead`, `WorkspaceProject` and `ProjectFilterRow` — the client
 * workbook's `Plant/OEM`, `Requesting Department` and `Product Type`, as
 * written. Shown verbatim; never edited (a write is a 422) and never a
 * scheduling input. A null value prints "Not set".
 */

export type CharterFieldKey = 'plant' | 'requesting_department' | 'product_type';

export type CharterFields = Record<CharterFieldKey, string | null>;

export const CHARTER_FIELDS: readonly { key: CharterFieldKey; label: string; short: string }[] = [
  { key: 'plant', label: 'Plant', short: 'Plant' },
  { key: 'requesting_department', label: 'Requesting department', short: 'Req. dept' },
  { key: 'product_type', label: 'Product type', short: 'Product type' },
];

export const CHARTER_NOT_SET = 'Not set';

/** One table cell: the served value, or a subtle "Not set". */
export function CharterCell({ value }: { value: string | null }): React.JSX.Element {
  if (value === null || value === '') {
    return <span className="text-xs text-text-subtle">{CHARTER_NOT_SET}</span>;
  }
  return (
    <span className="truncate text-xs font-medium text-text" title={value}>
      {value}
    </span>
  );
}

/** Shows or hides the optional workbook columns of a project list. */
export function CharterColumnsToggle({
  pressed,
  onPressedChange,
}: {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant={pressed ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={pressed}
      title="Show the Plant, Requesting department and Product type columns (from the client workbook, read-only)"
      onClick={() => onPressedChange(!pressed)}
      data-testid="charter-columns-toggle"
    >
      <FileSpreadsheet aria-hidden="true" />
      Workbook fields
    </Button>
  );
}

/** A read-only definition list of the three fields (drawer, Workspace). */
export function CharterFieldList({
  project,
  className,
  labelledBy,
}: {
  project: CharterFields;
  className?: string;
  /** Id of a visible heading naming the list. */
  labelledBy?: string;
}): React.JSX.Element {
  return (
    <dl
      className={className ?? 'grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-3'}
      aria-labelledby={labelledBy}
      data-testid="charter-fields"
    >
      {CHARTER_FIELDS.map(({ key, label }) => {
        const value = project[key];
        return (
          <div key={key} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-2xs font-semibold uppercase tracking-wider text-text-subtle">{label}</dt>
            <dd className={value ? 'break-words font-medium text-text' : 'text-text-subtle'}>
              {value || CHARTER_NOT_SET}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
