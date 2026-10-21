import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { LAB_REGIONS, type LabRegion } from '@/types/enums';

import type { CapacityBasis, ChamberRead, ChamberUpdateRequest, LabRegionSummary } from '../../api/types';
import { chamberFormSchema } from '../chamber-form-schema';
import type { StageChip } from '../../lib/chip-options';
import { formatAmount, formatPct, formatPlain, pick, pickUnit, unitShort, type CapacityUnit } from '../../lib/figures';
import { CardPills } from './card-pills';
import { InlineNumber } from './inline-number';
import { saveErrorMessage } from './save-error';
import { StaticChip, ToggleChip } from './toggle-chip';

/**
 * One lab region's chambers (P19-T04, the client's "Greece Labs (15%)" card).
 * Header figures are the region's served `capacity-summary` row; each
 * chamber's capacity is its served `capacity_weeks` / `capacity_days`, and
 * "Wks/ch" its served `working_weeks`. Nothing is computed.
 *
 * Editing (`canEdit`: write AND the region holds a hub in the caller's scope):
 * platforms and efficiency inline, stage chips as toggle buttons, downtime and
 * the rest through the existing chamber form.
 */
export interface LabRegionCardProps {
  region: string;
  summary: LabRegionSummary | undefined;
  chambers: ChamberRead[];
  stages: StageChip[];
  basis: CapacityBasis;
  unit: CapacityUnit;
  canEdit: boolean;
  onUpdate: (chamberId: string, body: ChamberUpdateRequest) => Promise<unknown>;
  onEdit: (row: ChamberRead) => void;
  onDelete: (row: ChamberRead) => void;
  onAdd: () => void;
}

function fromSchema(field: 'platforms' | 'efficiency') {
  const schema = chamberFormSchema.shape[field];
  return (text: string): string | null => {
    if (text === '') return 'A value is required';
    const r = schema.safeParse(text);
    return r.success ? null : (r.error.issues[0]?.message ?? 'Enter a number');
  };
}
const validatePlatforms = fromSchema('platforms');
const validateEfficiency = fromSchema('efficiency');

export function LabRegionCard({
  region,
  summary,
  chambers,
  stages,
  basis,
  unit,
  canEdit,
  onUpdate,
  onEdit,
  onDelete,
  onAdd,
}: LabRegionCardProps): React.JSX.Element {
  const headingId = React.useId();
  const isKnownRegion = (LAB_REGIONS as readonly string[]).includes(region);
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 overflow-hidden rounded-card border border-border bg-surface shadow-sm"
      data-testid={`lab-card-${region}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-success-subtle/60 px-3 py-2">
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-bold text-success-subtle-fg">
          {isKnownRegion ? <CountryFlag region={region as LabRegion} /> : null}
          <span>
            {region} labs{' '}
            <span className="font-medium text-text-muted" data-testid="share">
              ({formatPct(pick(summary?.share_pct, basis))})
            </span>
          </span>
        </h3>
        <div className="flex items-center gap-1.5">
          <CardPills
            weeks={pick(summary?.capacity_weeks, basis)}
            days={pick(summary?.capacity_days, basis)}
            label={`${region} lab capacity`}
          />
          {canEdit ? (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5" aria-label={`Add chamber to ${region} labs`} onClick={onAdd}>
              <Plus />
              Add
            </Button>
          ) : null}
        </div>
      </header>

      {chambers.length === 0 ? (
        <p className="px-3 py-3 text-2xs text-text-subtle">No chambers in this lab region.</p>
      ) : (
        <Table className="text-xs" scrollLabel={`${region} chambers`}>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 whitespace-nowrap px-1.5 text-2xs">Chamber</TableHead>
              <TableHead className="h-8 whitespace-nowrap px-1.5 text-right text-2xs" title="Platforms (setting platforms also sets max concurrent on save)">
                <span aria-hidden="true">Plat.</span>
                <span className="sr-only">Platforms</span>
              </TableHead>
              <TableHead className="h-8 whitespace-nowrap px-1.5 text-right text-2xs" title="Efficiency, as a fraction (1 = 100%)">
                <span aria-hidden="true">Eff.</span>
                <span className="sr-only">Efficiency</span>
              </TableHead>
              <TableHead className="h-8 whitespace-nowrap px-1.5 text-right text-2xs" title="Working weeks per chamber per year">
                <span aria-hidden="true">Wks/ch</span>
                <span className="sr-only">Working weeks per chamber</span>
              </TableHead>
              <TableHead className="h-8 whitespace-nowrap px-1.5 text-right text-2xs">
                <span aria-hidden="true" className="flex flex-col items-end leading-tight">
                  <span>Cap.</span>
                  <span className="normal-case">({unitShort(unit)})</span>
                </span>
                <span className="sr-only">Capacity in {unit}</span>
              </TableHead>
              <TableHead className="h-8 whitespace-nowrap px-1.5 text-2xs">Stages</TableHead>
              {canEdit ? (
                <TableHead className="h-8 w-16 px-1 text-2xs">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {chambers.map((c) => (
              <ChamberRow
                key={c.id}
                chamber={c}
                stages={stages}
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

function ChamberRow({
  chamber,
  stages,
  basis,
  unit,
  canEdit,
  onUpdate,
  onEdit,
  onDelete,
}: {
  chamber: ChamberRead;
  stages: StageChip[];
  basis: CapacityBasis;
  unit: CapacityUnit;
  canEdit: boolean;
  onUpdate: LabRegionCardProps['onUpdate'];
  onEdit: LabRegionCardProps['onEdit'];
  onDelete: LabRegionCardProps['onDelete'];
}): React.JSX.Element {
  const [chipError, setChipError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const allowed = chamber.allowed_stages;

  const toggle = async (stageId: string) => {
    const next = allowed.includes(stageId)
      ? allowed.filter((s) => s !== stageId)
      : stages.map((s) => s.id).filter((id) => id === stageId || allowed.includes(id));
    setChipError(null);
    setSaving(true);
    try {
      await onUpdate(chamber.id, { allowed_stages: next });
    } catch (err) {
      setChipError(saveErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <TableRow data-testid={`chamber-row-${chamber.id}`}>
      <TableCell className="whitespace-nowrap px-1.5 py-1.5 font-semibold text-text">{chamber.code}</TableCell>
      <TableCell className="px-1.5 py-1.5 text-right tnum" data-numeric="">
        {canEdit ? (
          <InlineNumber
            id={`plat-${chamber.id}`}
            label={`Platforms for ${chamber.code}`}
            value={chamber.platforms}
            step="1"
            min={1}
            inputMode="numeric"
            validate={validatePlatforms}
            onCommit={(platforms) => onUpdate(chamber.id, { platforms })}
            className="[&_input]:w-10"
          />
        ) : (
          formatPlain(chamber.platforms)
        )}
      </TableCell>
      <TableCell className="px-1.5 py-1.5 text-right tnum" data-numeric="">
        {canEdit ? (
          <InlineNumber
            id={`eff-${chamber.id}`}
            label={`Efficiency for ${chamber.code}`}
            value={chamber.efficiency}
            step="0.01"
            min={0.01}
            inputMode="decimal"
            validate={validateEfficiency}
            onCommit={(efficiency) => onUpdate(chamber.id, { efficiency })}
            className="[&_input]:w-12"
          />
        ) : (
          formatPlain(chamber.efficiency)
        )}
      </TableCell>
      <TableCell className="px-1.5 py-1.5 text-right font-mono tnum" data-numeric="">
        {formatPlain(chamber.working_weeks)}
      </TableCell>
      <TableCell className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono font-semibold text-success-subtle-fg tnum" data-numeric="">
        {formatAmount(pickUnit(chamber, unit, basis), unit)}
      </TableCell>
      <TableCell className="px-1.5 py-1.5">
        <div className="flex flex-wrap gap-1" role={canEdit ? 'group' : undefined} aria-label={canEdit ? `Stages for ${chamber.code}` : undefined}>
          {canEdit ? (
            stages.map((s) => (
              <ToggleChip
                key={s.id}
                tone="success"
                pressed={allowed.includes(s.id)}
                label={`Allow stage ${s.label} for ${chamber.code}`}
                title={s.label}
                disabled={saving}
                onToggle={() => void toggle(s.id)}
              >
                <StageText stage={s} />
              </ToggleChip>
            ))
          ) : allowed.length === 0 ? (
            <span className="text-2xs text-text-subtle">None set</span>
          ) : (
            stages
              .filter((s) => allowed.includes(s.id))
              .map((s) => (
                <StaticChip key={s.id} tone="success" title={s.label}>
                  <StageText stage={s} />
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
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Edit ${chamber.code}`} onClick={() => onEdit(chamber)}>
              <Pencil />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Delete ${chamber.code}`} onClick={() => onDelete(chamber)}>
              <Trash2 />
            </Button>
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

function StageText({ stage }: { stage: StageChip }): React.JSX.Element {
  return <span className="whitespace-nowrap">{stage.compact}</span>;
}
