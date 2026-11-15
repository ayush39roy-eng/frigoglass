import * as React from 'react';
import { Columns3 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * P35-T08: show / hide the register's optional columns. The choice (and the
 * dragged widths) are this user's, kept in this browser (`column-prefs.ts`).
 */
export function ColumnMenu({
  columns,
  hidden,
  onToggle,
  onReset,
}: {
  columns: readonly { id: string; label: string }[];
  hidden: readonly string[];
  onToggle: (id: string, visible: boolean) => void;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="secondary" size="sm" className="rounded-pill" data-testid="column-menu-trigger">
          <Columns3 aria-hidden="true" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        {columns.map((col) => (
          <DropdownMenuCheckboxItem
            key={col.id}
            checked={!hidden.includes(col.id)}
            onCheckedChange={(checked) => onToggle(col.id, checked === true)}
            onSelect={(e) => e.preventDefault()}
            data-testid={`column-toggle-${col.id}`}
          >
            {col.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onReset} data-testid="column-reset">
          Reset columns and widths
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
