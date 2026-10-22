import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NotInCapacityRosterBadge } from '@/components/shared/capacity-roster-markers';
import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { EngineerAllowedCategory, LabRegion } from '@/types/enums';

import type { CapacityBasis, DesignHubSummary, EngineerRead, EngineerUpdateRequest } from '../../api/types';
import { engineerFormSchema } from '../engineer-form-schema';
import { CATEGORY_CHIPS, CATEGORY_TITLE } from '../../lib/chip-options';
import { formatAmount, formatPct, formatPlain, pick, pickUnit, unitShort, type CapacityUnit } from '../../lib/figures';
import { InlineNumber } from './inline-number';
import { saveErrorMessage } from './save-error';
import { StaticChip, ToggleChip } from './toggle-chip';
import { CardPills } from './card-pills';

/**
 * One hub's design resources (P19-T04, the client's "R&D-Greece Hub (22%)"
 * card). Header figures are the hub's served `capacity-summary` row; each
 * engineer's capacity is their own served `capacity_weeks` / `capacity_days`.
 * Nothing is summed or scaled here (I9/I19); a field an older API does not
 * serve prints "—".
 *
 * P29 (ADR 0042, API_CONTRACT_P29 §3): one card per CAPACITY hub. A served
 * `members` list (R&D-Greece: OEM-HCK, OEM-Seitek) adds "Capacity also serves
 * …" under the header, the filter-selected member in bold; a served
 * `not_counted_engineer_count` adds "N not in capacity roster", and those
 * engineers' rows carry the marker (their own capacity is still shown, muted:
 * it is not part of the hub's capacity).
 *
 * Editing (`canEdit`: Capacity Planning write AND the hub in the caller's
 * scope, the server being the authority): FTE inline, category chips as toggle
 * buttons, edit / delete / add through the existing form and confirm dialogs.
 */
export interface HubEngineerCardProps {
  hubName: string;
  hubId: string | undefined;
  region: LabRegion | undefined;
  summary: DesignHubSummary | undefined;
  engineers: EngineerRead[];
  basis: CapacityBasis;
  unit: CapacityUnit;
  canEdit: boolean;
  onUpdate: (engineerId: string, body: EngineerUpdateRequest) => Promise<unknown>;
  onEdit: (row: EngineerRead) => void;
  onDelete: (row: EngineerRead) => void;
  onAdd: (hubId: string | undefined) => void;
}

const fteSchema = engineerFormSchema.shape.fte;

function validateFte(text: string): string | null {
  const r = fteSchema.safeParse(text);
  return r.success ? null : (r.error.issues[0]?.message ?? 'Enter a positive number');
}

export function HubEngineerCard({
  hubName,
  hubId,
  region,
  summary,
  engineers,
  basis,
  unit,
  canEdit,
  onUpdate,
  onEdit,
  onDelete,
  onAdd,
}: HubEngineerCardProps): React.JSX.Element {
  const headingId = React.useId();
  const share = pick(summary?.share_pct, basis);
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 overflow-hidden rounded-card border border-border bg-surface shadow-sm"
      data-testid={`hub-card-${hubName}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-primary-subtle/50 px-3 py-2">
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-bold text-primary-subtle-fg">
          {region ? <CountryFlag region={region} /> : null}
          <span>
            {hubName} Hub{' '}
            <span className="font-medium text-text-muted" data-testid="share">
              ({formatPct(share)})
            </span>
          </span>
        </h3>
        <div className="flex items-center gap-1.5">
          <CardPills
            weeks={pick(summary?.capacity_weeks, basis)}
            days={pick(summary?.capacity_days, basis)}
            label={`${hubName} design capacity`}
          />
          {canEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-1.5"
              aria-label={`Add engineer to ${hubName}`}
              onClick={() => onAdd(hubId)}
            >
              <Plus />
              Add
            </Button>
          ) : null}
        </div>
      </header>
      <HubCardNotes summary={summary} />

      {engineers.length === 0 ? (
        <p className="px-3 py-3 text-2xs text-text-subtle">No engineers in this hub.</p>
      ) : (
        <Table className="text-xs" scrollLabel={`${hubName} engineers`}>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 whitespace-nowrap px-1.5 text-2xs">Name</TableHead>
              <TableHead className="h-8 w-16 whitespace-nowrap px-1.5 text-right text-2xs">FTE</TableHead>
              <TableHead className="h-8 whitespace-nowrap px-1.5 text-right text-2xs">
                <span aria-hidden="true" className="flex flex-col items-end leading-tight">
                  <span>Cap.</span>
                  <span className="normal-case">({unitShort(unit)})</span>
                </span>
                <span className="sr-only">Capacity in {unit}</span>
              </TableHead>
              <TableHead className="h-8 whitespace-nowrap px-1.5 text-2xs">Project types</TableHead>
              {canEdit ? (
                <TableHead className="h-8 w-16 px-1 text-2xs">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {engineers.map((e) => (
              <EngineerRow
                key={e.id}
                engineer={e}
                basis={basis}
                unit={unit}
                canEdit={canEdit}
                onUpdate={onUpdate}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** P29: the served members and not-counted figures, one muted line; nothing derived. */
function HubCardNotes({ summary }: { summary: DesignHubSummary | undefined }): React.JSX.Element | null {
  const members = summary?.members ?? [];
  const notCounted = summary?.not_counted_engineer_count ?? 0;
  if (members.length === 0 && notCounted === 0) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-border px-3 py-1.5 text-2xs text-text-muted" data-testid="hub-notes">
      {members.length > 0 ? (
        <span data-testid="hub-notes-members">
          Capacity also serves{' '}
          {members.map((m, i) => (
            <React.Fragment key={m}>
              {i === 0 ? '' : i === members.length - 1 ? ' and ' : ', '}
              <span
                className={cn(summary?.selected_member === m && 'font-semibold text-primary-subtle-fg')}
                data-selected={summary?.selected_member === m ? 'true' : undefined}
              >
                {m}
              </span>
            </React.Fragment>
          ))}
          <span className="sr-only">
            {summary?.selected_member && members.includes(summary.selected_member)
              ? ` (${summary.selected_member} selected in the hub filter)`
              : ''}
          </span>
        </span>
      ) : null}
      {notCounted > 0 ? (
        <span data-testid="hub-notes-not-counted" data-numeric="">
          {formatInteger(notCounted)} not in capacity roster
        </span>
      ) : null}
    </p>
  );
}

function EngineerRow({
  engineer,
  basis,
  unit,
  canEdit,
  onUpdate,
  onEdit,
  onDelete,
}: {
  engineer: EngineerRead;
  basis: CapacityBasis;
  unit: CapacityUnit;
  canEdit: boolean;
  onUpdate: HubEngineerCardProps['onUpdate'];
  onEdit: HubEngineerCardProps['onEdit'];
  onDelete: HubEngineerCardProps['onDelete'];
}): React.JSX.Element {
  const [chipError, setChipError] = React.useState<string | null>(null);
  const [savingChip, setSavingChip] = React.useState(false);
  const allowed = engineer.allowed_categories;

  const toggle = async (category: EngineerAllowedCategory) => {
    const next = allowed.includes(category)
      ? allowed.filter((c) => c !== category)
      : CATEGORY_CHIPS.filter((c) => c === category || allowed.includes(c));
    setChipError(null);
    setSavingChip(true);
    try {
      await onUpdate(engineer.id, { allowed_categories: next });
    } catch (err) {
      setChipError(saveErrorMessage(err));
    } finally {
      setSavingChip(false);
    }
  };

  return (
    <TableRow data-testid={`engineer-row-${engineer.id}`}>
      <TableCell className="px-1.5 py-1.5 font-semibold text-text">
        {engineer.name}
        {/* P29 (API_CONTRACT_P29 §3.3): served flag; an older API omits it. */}
        {engineer.counts_in_capacity === false ? <NotInCapacityRosterBadge className="mt-0.5 flex w-fit" /> : null}
      </TableCell>
      <TableCell className="px-1.5 py-1.5 text-right tnum" data-numeric="">
        {canEdit ? (
          <InlineNumber
            id={`fte-${engineer.id}`}
            label={`FTE for ${engineer.name}`}
            value={engineer.fte}
            step="0.1"
            min={0.1}
            inputMode="decimal"
            validate={validateFte}
            onCommit={(fte) => onUpdate(engineer.id, { fte })}
          />
        ) : (
          formatPlain(engineer.fte)
        )}
      </TableCell>
      <TableCell
        className={cn(
          'whitespace-nowrap px-1.5 py-1.5 text-right font-mono font-semibold tnum',
          engineer.counts_in_capacity === false ? 'text-text-muted' : 'text-primary-subtle-fg',
        )}
        data-numeric=""
      >
        {formatAmount(pickUnit(engineer, unit, basis), unit)}
      </TableCell>
      <TableCell className="px-1.5 py-1.5">
        <div className="flex flex-wrap gap-1" role={canEdit ? 'group' : undefined} aria-label={canEdit ? `Project types for ${engineer.name}` : undefined}>
          {canEdit ? (
            CATEGORY_CHIPS.map((c) => (
              <ToggleChip
                key={c}
                tone="primary"
                pressed={allowed.includes(c)}
                label={`Allow category ${c} for ${engineer.name}`}
                title={CATEGORY_TITLE[c]}
                disabled={savingChip}
                onToggle={() => void toggle(c)}
              >
                {c}
              </ToggleChip>
            ))
          ) : allowed.length === 0 ? (
            <span className="text-2xs text-text-subtle">None set</span>
          ) : (
            CATEGORY_CHIPS.filter((c) => allowed.includes(c)).map((c) => (
              <StaticChip key={c} tone="primary" title={CATEGORY_TITLE[c]}>
                {c}
              </StaticChip>
            ))
          )}
        </div>
        {chipError ? (
          <p role="alert" className="mt-1 text-2xs text-danger">
            {chipError}
          </p>
        ) : null}
      </TableCell>
      {canEdit ? (
        <TableCell className="px-1 py-1.5">
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Edit ${engineer.name}`} onClick={() => onEdit(engineer)}>
              <Pencil />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Delete ${engineer.name}`} onClick={() => onDelete(engineer)}>
              <Trash2 />
            </Button>
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}
