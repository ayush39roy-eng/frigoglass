import * as React from 'react';
import { Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDecimal } from '@/lib/format';

import type { ChamberSetting, ChamberSettingUpdateRequest, WorkflowSettingsSaveResult } from '../api/types';
import { impliedHolidayWeeks, previewEfficientLabWeeks, previewWorkingWeeksPerChamber } from '../lib/preview';
import { saveErrorMessage } from './save-error';

/**
 * Chambers (ADR 0008): platforms, efficiency and the three downtime fields,
 * with the derived working weeks and efficient lab weeks. Saved figures are
 * the server's; edits show a labelled preview. Booking is still gated by
 * platform count only — downtime is a supply-reporting input.
 */
type Editable = Required<ChamberSettingUpdateRequest>;
const FIELDS: { key: keyof Editable; label: string; step: string }[] = [
  { key: 'platforms', label: 'Platforms', step: '1' },
  { key: 'efficiency', label: 'Efficiency', step: '0.05' },
  { key: 'maintenance_weeks', label: 'Maintenance (wk)', step: '0.5' },
  { key: 'breakdown_weeks', label: 'Breakdown (wk)', step: '0.5' },
  { key: 'calibration_weeks', label: 'Calibration (wk)', step: '0.5' },
];

export interface ChambersTabProps {
  chambers: ChamberSetting[];
  canWrite: boolean;
  onSave: (chamberId: string, body: ChamberSettingUpdateRequest) => Promise<WorkflowSettingsSaveResult>;
  saving: boolean;
}

export function ChambersTab({ chambers, canWrite, onSave, saving }: ChambersTabProps): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chambers</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-xs" aria-label="Chamber supply inputs">
            <thead className="bg-surface-sunken text-2xs text-text-muted">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-left">Chamber</th>
                <th scope="col" className="px-2 py-1.5 text-left">Region</th>
                {FIELDS.map((f) => (
                  <th key={f.key} scope="col" className="px-2 py-1.5 text-right">
                    {f.label}
                  </th>
                ))}
                <th scope="col" className="border-l border-border px-2 py-1.5 text-right">Working weeks</th>
                <th scope="col" className="px-2 py-1.5 text-right">Efficient lab weeks</th>
                {canWrite ? <th scope="col" className="px-2 py-1.5"><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {chambers.map((c) => (
                <ChamberRow key={`${c.chamber_id}-${String(c.efficient_lab_weeks)}`} chamber={c} canWrite={canWrite} onSave={onSave} saving={saving} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-2xs text-text-subtle">
          Working weeks = 52 − region holidays − maintenance − breakdown − calibration; efficient lab weeks =
          working weeks × efficiency × platforms. Saved figures come from the server; edited rows show a preview.
        </p>
      </CardContent>
    </Card>
  );
}

function ChamberRow({
  chamber,
  canWrite,
  onSave,
  saving,
}: {
  chamber: ChamberSetting;
  canWrite: boolean;
  onSave: ChambersTabProps['onSave'];
  saving: boolean;
}): React.JSX.Element {
  const initial: Editable = {
    platforms: chamber.platforms,
    efficiency: chamber.efficiency,
    maintenance_weeks: chamber.maintenance_weeks,
    breakdown_weeks: chamber.breakdown_weeks,
    calibration_weeks: chamber.calibration_weeks,
  };
  const [values, setValues] = React.useState<Editable>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const dirty = FIELDS.some((f) => values[f.key] !== initial[f.key]);
  const invalid =
    !Number.isInteger(values.platforms) ||
    values.platforms < 1 ||
    !(values.efficiency > 0 && values.efficiency <= 1) ||
    [values.maintenance_weeks, values.breakdown_weeks, values.calibration_weeks].some((v) => !(v >= 0));
  const holidays = impliedHolidayWeeks(chamber);

  const changed: ChamberSettingUpdateRequest = {};
  for (const f of FIELDS) if (values[f.key] !== initial[f.key]) changed[f.key] = values[f.key];

  return (
    <>
      <tr className="border-t border-border" data-testid={`chamber-${chamber.code}`}>
        <th scope="row" className="px-2 py-1 text-left font-medium text-text">
          {chamber.code}
        </th>
        <td className="px-2 py-1 text-text-muted">{chamber.lab_region}</td>
        {FIELDS.map((f) => (
          <td key={f.key} className="px-1 py-0.5 text-right">
            {canWrite ? (
              <input
                type="number"
                step={f.step}
                min={0}
                value={String(values[f.key])}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: Number(e.target.value) }))}
                aria-label={`${chamber.code} ${f.label}`}
                className="h-7 w-16 rounded border border-border-strong bg-surface px-1.5 text-right text-xs tabular-nums text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            ) : (
              <span data-numeric="">{formatDecimal(values[f.key])}</span>
            )}
          </td>
        ))}
        <td className="border-l border-border px-2 py-1 text-right" data-numeric="">
          <span className="block font-semibold text-text">{formatDecimal(chamber.working_weeks_per_chamber)}</span>
          {dirty ? (
            <span className="block text-2xs text-primary-subtle-fg" data-testid="preview-working">
              {formatDecimal(previewWorkingWeeksPerChamber(values, holidays))} preview
            </span>
          ) : null}
        </td>
        <td className="px-2 py-1 text-right" data-numeric="">
          <span className="block font-semibold text-text">{formatDecimal(chamber.efficient_lab_weeks)}</span>
          {dirty ? (
            <span className="block text-2xs text-primary-subtle-fg" data-testid="preview-efficient">
              {formatDecimal(previewEfficientLabWeeks(values, holidays))} preview
            </span>
          ) : null}
        </td>
        {canWrite ? (
          <td className="px-2 py-1 text-right">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!dirty || invalid || saving}
              onClick={() => {
                setError(null);
                onSave(chamber.chamber_id, changed).catch((err: unknown) => setError(saveErrorMessage(err)));
              }}
              aria-label={`Save ${chamber.code}`}
            >
              <Save />
            </Button>
          </td>
        ) : null}
      </tr>
      {invalid || error ? (
        <tr>
          <td colSpan={canWrite ? 10 : 9} className="px-2 pb-1">
            <p role="alert" className="text-2xs text-danger">
              {error ?? 'Platforms must be a whole number ≥ 1, efficiency in (0, 1], downtime ≥ 0.'}
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}
