import * as React from 'react';
import { HardHat, Pencil, RotateCcw, UserX } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NotInCapacityRosterBadge } from '@/components/shared/capacity-roster-markers';
import { SuperAdminOnly } from '@/components/shared/super-admin-only';
import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { useIsSuperAdmin } from '@/lib/auth/super-admin';
import { formatFactor, formatInteger, formatWeek } from '@/lib/format';
import { HUB_NAMES, type LabRegion } from '@/types/enums';

import type { EngineerRead } from '../api/types';
import { groupRows } from '../lib/group-rows';
import { isInactive, reasonLabel } from '../lib/deactivation';
import { InactiveTag } from './inactive-tag';

/**
 * Plain (non-virtualized) table — engineer rows number in the tens per hub in
 * the real dataset, nowhere near CLAUDE.md's "virtualize any list over 100
 * rows" threshold (that's the 236-project baseline the Matrix/Gantt/
 * Registration lists are built for).
 */
export type EngineerTableRow = EngineerRead & { hubName: string; hubRegion?: LabRegion | undefined };

/**
 * P13-T17 (mock-up image 13): rows are grouped under a header per hub
 * (canonical hub order) — display grouping only; no per-hub figure is derived.
 */
export interface EngineerTableProps {
  rows: EngineerTableRow[];
  canEdit: boolean;
  /** P38 (ADR 0053 §1): Admin / Super Admin may deactivate and reactivate (OQ #93). */
  canChangeStatus: boolean;
  onEdit: (row: EngineerRead) => void;
  onDeactivate: (row: EngineerRead) => void;
  onReactivate: (row: EngineerRead) => void;
}

/**
 * P38-T06: Delete is gone (DELETE answers 410). An active row offers Edit and,
 * for an Admin, Deactivate; an inactive row carries the "Inactive" tag and
 * offers Reactivate (Admin) and Edit, which changes the name only (ADR 0053 §7).
 */
export function EngineerTable({ rows, canEdit, canChangeStatus, onEdit, onDeactivate, onReactivate }: EngineerTableProps): React.JSX.Element {
  const groups = React.useMemo(() => groupRows(rows, (r) => r.hubName, HUB_NAMES), [rows]);
  const columns = canEdit ? 4 : 3;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">FTE</TableHead>
          <TableHead>Allowed categories</TableHead>
          {canEdit ? <TableHead className="w-24 text-right">Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      {groups.map((group) => {
        const region = group.rows[0]?.hubRegion;
        return (
      <TableBody key={group.key} data-testid={`engineer-group-${group.key}`}>
        <tr className="border-t-[1.5px] border-border bg-primary-subtle/40">
          <th scope="rowgroup" colSpan={columns} className="px-4 py-2 text-left">
            <span className="flex items-center gap-2">
              {region ? <CountryFlag region={region} /> : null}
              <span className="font-display text-sm font-bold text-primary-subtle-fg">{group.key} Hub</span>
              <span className="text-2xs font-medium text-text-muted" data-numeric="">
                {formatInteger(group.rows.length)} {group.rows.length === 1 ? 'engineer' : 'engineers'}
              </span>
            </span>
          </th>
        </tr>
        {group.rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <span className="flex items-center gap-3">
                <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-subtle text-primary-subtle-fg">
                  <HardHat className="size-[18px]" />
                </span>
                <span className="font-semibold text-text">{row.name}</span>
                {/* P29 (API_CONTRACT_P29 §3.3): served flag; an older API omits it. */}
                {row.counts_in_capacity === false ? <NotInCapacityRosterBadge /> : null}
                {isInactive(row) ? <InactiveTag /> : null}
              </span>
              {isInactive(row) && row.deactivated_week != null ? (
                <span className="ml-12 block text-2xs text-text-muted" data-testid="inactive-since">
                  Since {formatWeek(row.deactivated_week)}
                  {reasonLabel(row.deactivation_reason) ? ` · ${reasonLabel(row.deactivation_reason) ?? ''}` : ''}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="text-right tnum" data-numeric="">
              {formatFactor(row.fte)}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {row.allowed_categories.length === 0 ? (
                  <span className="text-2xs text-text-subtle">None set</span>
                ) : (
                  row.allowed_categories.map((c) => (
                    <Badge key={c} tone="outline">
                      {c}
                    </Badge>
                  ))
                )}
              </div>
            </TableCell>
            {canEdit ? (
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={isInactive(row) ? `Edit name of ${row.name}` : `Edit ${row.name}`}
                    onClick={() => onEdit(row)}
                  >
                    <Pencil />
                  </Button>
                  {canChangeStatus ? (
                    <StatusAction row={row} onDeactivate={onDeactivate} onReactivate={onReactivate} />
                  ) : null}
                </div>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
        );
      })}
    </Table>
  );
}

/** Deactivate on an active row, Reactivate on an inactive one (Admin only).
 *  P46 (ADR 0058 D1.3): Deactivate is Super Admin only — disabled with the
 *  hint for anyone else; Reactivate stays an Admin right. */
export function StatusAction({
  row,
  onDeactivate,
  onReactivate,
  className,
}: {
  row: EngineerRead;
  onDeactivate: (row: EngineerRead) => void;
  onReactivate: (row: EngineerRead) => void;
  className?: string;
}): React.JSX.Element {
  const superAdmin = useIsSuperAdmin();
  return isInactive(row) ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      aria-label={`Reactivate ${row.name}`}
      title="Reactivate"
      aria-haspopup="dialog"
      onClick={() => onReactivate(row)}
    >
      <RotateCcw />
    </Button>
  ) : (
    <SuperAdminOnly locked={!superAdmin}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={className}
        aria-label={`Deactivate ${row.name}`}
        title={superAdmin ? 'Deactivate' : undefined}
        aria-haspopup="dialog"
        disabled={!superAdmin}
        onClick={() => onDeactivate(row)}
      >
        <UserX />
      </Button>
    </SuperAdminOnly>
  );
}
