import * as React from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { HUB_NAMES, LAB_REGIONS, PROJECT_PRIORITIES, PROJECT_TYPES, PROJECT_TYPE_LABELS } from '@/types/enums';

import type { ChamberRead } from '../../api/types';
import type { WhatIfHub, WhatIfRegion } from '../../api/whatif-types';
import {
  MAX_LINES,
  WHATIF_STATUSES,
  categoriesForHub,
  parseDesignerFte,
  type CapKey,
  type CapTotal,
  type LineErrors,
  type LineListName,
  type ScenarioLines,
  type ScenarioValidation,
} from '../scenario-schema';
import { useWhatIfScenario } from '../scenario-store';
import { Field, NativeSelect, TextInput } from './form-controls';

/**
 * The scenario form (no AI needed). Every line is one hypothetical change; the
 * numbers it produces come back from the API, never from here.
 */

function LineShell({
  groupLabel,
  onRemove,
  children,
}: {
  groupLabel: string;
  onRemove: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={groupLabel}
      className="flex items-start gap-s2 rounded-md border border-border bg-surface-sunken/40 p-s3"
    >
      <div className="grid flex-1 grid-cols-2 gap-s3 sm:grid-cols-3 lg:grid-cols-4">{children}</div>
      <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${groupLabel}`} onClick={onRemove}>
        <Trash2 />
      </Button>
    </div>
  );
}

function Section({
  title,
  description,
  list,
  addLabel,
  lineCount,
  cap,
  children,
}: {
  title: string;
  description: string;
  list: LineListName;
  addLabel: string;
  lineCount: number;
  /** Running total against this section's per-scenario cap, when it has one. */
  cap?: CapTotal | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const addLine = useWhatIfScenario((s) => s.addLine);
  const headingId = `whatif-${list}-heading`;
  return (
    <section aria-labelledby={headingId} className="space-y-s3">
      <div className="flex flex-wrap items-start justify-between gap-s2">
        <div className="min-w-0">
          <h4 id={headingId} className="text-sm font-semibold text-text">
            {title}
          </h4>
          <p className="text-2xs text-text-muted">{description}</p>
          {cap ? (
            <p
              className={
                cap.over
                  ? 'text-2xs font-semibold text-danger-subtle-fg'
                  : 'text-2xs text-text-muted'
              }
              data-testid={`whatif-cap-${cap.key}`}
            >
              Total {String(cap.total)} of {String(cap.cap)} {cap.noun}
              {cap.over ? ': over the limit.' : ` (${String(cap.remaining)} left).`}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={lineCount >= MAX_LINES}
          onClick={() => addLine(list)}
        >
          <Plus />
          {addLabel}
        </Button>
      </div>
      {children}
    </section>
  );
}

function HubSelect({
  id,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (hub: WhatIfHub) => void;
  invalid: boolean;
  describedBy: string | undefined;
}): React.JSX.Element {
  return (
    <NativeSelect
      id={id}
      value={value}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value as WhatIfHub)}
    >
      {HUB_NAMES.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </NativeSelect>
  );
}

function RegionSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (region: WhatIfRegion) => void;
}): React.JSX.Element {
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value as WhatIfRegion)}>
      {LAB_REGIONS.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </NativeSelect>
  );
}

export interface ScenarioBuilderProps {
  validation: ScenarioValidation;
  /** Server-scoped chamber list, for the downtime picker. */
  chambers: ChamberRead[];
}

export function ScenarioBuilder({ validation, chambers }: ScenarioBuilderProps): React.JSX.Element {
  const lines = useWhatIfScenario();
  const errors: LineErrors = validation.errors;
  const { updateLine, removeLine } = lines;

  const capOf = (k: CapKey): CapTotal | undefined => validation.totals.find((t) => t.key === k);
  const err = (key: string, field: string): string | undefined => errors[key]?.[field];

  return (
    <Card data-testid="whatif-builder">
      <CardHeader>
        <CardTitle>Scenario builder</CardTitle>
        <Button type="button" size="sm" variant="ghost" onClick={lines.reset}>
          <RotateCcw />
          Clear scenario
        </Button>
      </CardHeader>
      <CardContent className="space-y-s6">
        <div className="flex flex-wrap items-end gap-s4">
          <div className="flex flex-col gap-1">
            <span id="whatif-basis-label" className="text-2xs text-text-muted">
              Capacity basis
            </span>
            <ToggleGroup
              type="single"
              size="sm"
              value={lines.basis}
              aria-labelledby="whatif-basis-label"
              onValueChange={(v) => {
                if (v === 'year' || v === 'remaining') lines.setBasis(v);
              }}
            >
              <ToggleGroupItem value="year">Full year</ToggleGroupItem>
              <ToggleGroupItem value="remaining">Remaining weeks</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <Field
            id="whatif-designer-fte"
            label="FTE per added designer (estimate and fewest-additions)"
            className="w-56"
            error={parseDesignerFte(lines.designerFte).error}
          >
            {(p) => <TextInput {...p} value={lines.designerFte} onChange={(e) => lines.setDesignerFte(e.target.value)} />}
          </Field>
        </div>

        <Section
          title="Add projects"
          description="Hypothetical projects. Defaults: In Queue, priority P3 (or the band of a score)."
          list="projects"
          cap={capOf('projects')}
          addLabel="Add project line"
          lineCount={lines.projects.length}
        >
          {lines.projects.map((l, i) => {
            const id = (f: string) => `${l.key}-${f}`;
            const set = (patch: Partial<ScenarioLines['projects'][number]>) => updateLine('projects', l.key, patch);
            return (
              <LineShell key={l.key} groupLabel={`Added projects, line ${String(i + 1)}`} onRemove={() => removeLine('projects', l.key)}>
                <Field id={id('hub')} label="Hub">
                  {(p) => <HubSelect {...p} value={l.hub} invalid={p['aria-invalid']} describedBy={p['aria-describedby']} onChange={(hub) => set({ hub })} />}
                </Field>
                <Field id={id('category')} label="Category" error={err(l.key, 'category')}>
                  {(p) => (
                    <NativeSelect {...p} value={l.category} onChange={(e) => set({ category: e.target.value as typeof l.category })}>
                      {categoriesForHub(l.hub).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field id={id('count')} label="Count" error={err(l.key, 'count')}>
                  {(p) => <TextInput {...p} value={l.count} onChange={(e) => set({ count: e.target.value })} />}
                </Field>
                <Field id={id('type')} label="Type">
                  {(p) => (
                    <NativeSelect {...p} value={l.projectType} onChange={(e) => set({ projectType: e.target.value as typeof l.projectType })}>
                      <option value="">Default</option>
                      {PROJECT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {PROJECT_TYPE_LABELS[t]}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field id={id('status')} label="Status">
                  {(p) => (
                    <NativeSelect {...p} value={l.status} onChange={(e) => set({ status: e.target.value as typeof l.status })}>
                      {(WHATIF_STATUSES.includes(l.status) ? WHATIF_STATUSES : [...WHATIF_STATUSES, l.status]).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field id={id('priority')} label="Priority">
                  {(p) => (
                    <NativeSelect {...p} value={l.priority} onChange={(e) => set({ priority: e.target.value as typeof l.priority })}>
                      <option value="">Default (P3)</option>
                      {PROJECT_PRIORITIES.map((pr) => (
                        <option key={pr} value={pr}>
                          {pr}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field id={id('score')} label="Score (if no priority)" error={err(l.key, 'score')}>
                  {(p) => <TextInput {...p} value={l.score} placeholder="0 to 100" onChange={(e) => set({ score: e.target.value })} />}
                </Field>
                <div className="flex items-center gap-2 self-end pb-1.5">
                  <Checkbox
                    id={id('cert')}
                    checked={l.certification}
                    onCheckedChange={(c) => set({ certification: c === true })}
                  />
                  <Label htmlFor={id('cert')} className="text-2xs text-text-muted">
                    Needs certification testing
                  </Label>
                </div>
              </LineShell>
            );
          })}
        </Section>

        <Section
          title="Add designers"
          description="Extra designers for a hub. FTE is above 0, up to 1 per person."
          list="engineers"
          cap={capOf('designersAdded')}
          addLabel="Add designer line"
          lineCount={lines.engineers.length}
        >
          {lines.engineers.map((l, i) => {
            const id = (f: string) => `${l.key}-${f}`;
            return (
              <LineShell key={l.key} groupLabel={`Added designers, line ${String(i + 1)}`} onRemove={() => removeLine('engineers', l.key)}>
                <Field id={id('hub')} label="Hub">
                  {(p) => <HubSelect {...p} value={l.hub} invalid={p['aria-invalid']} describedBy={p['aria-describedby']} onChange={(hub) => updateLine('engineers', l.key, { hub })} />}
                </Field>
                <Field id={id('fte')} label="FTE each" error={err(l.key, 'fte')}>
                  {(p) => <TextInput {...p} value={l.fte} onChange={(e) => updateLine('engineers', l.key, { fte: e.target.value })} />}
                </Field>
                <Field id={id('count')} label="Count" error={err(l.key, 'count')}>
                  {(p) => <TextInput {...p} value={l.count} onChange={(e) => updateLine('engineers', l.key, { count: e.target.value })} />}
                </Field>
                {l.allowedCategories ? (
                  <p className="self-end text-2xs text-text-muted">Limited to {l.allowedCategories.join(', ')}</p>
                ) : null}
              </LineShell>
            );
          })}
        </Section>

        <Section
          title="Remove designers"
          description="Takes the least-loaded designers of a hub out of the plan; their projects go to colleagues."
          list="removals"
          cap={capOf('designersRemoved')}
          addLabel="Add removal line"
          lineCount={lines.removals.length}
        >
          {lines.removals.map((l, i) => {
            const id = (f: string) => `${l.key}-${f}`;
            return (
              <LineShell key={l.key} groupLabel={`Removed designers, line ${String(i + 1)}`} onRemove={() => removeLine('removals', l.key)}>
                <Field id={id('hub')} label="Hub">
                  {(p) => <HubSelect {...p} value={l.hub} invalid={p['aria-invalid']} describedBy={p['aria-describedby']} onChange={(hub) => updateLine('removals', l.key, { hub })} />}
                </Field>
                <Field id={id('count')} label="Count" error={err(l.key, 'count')}>
                  {(p) => <TextInput {...p} value={l.count} onChange={(e) => updateLine('removals', l.key, { count: e.target.value })} />}
                </Field>
              </LineShell>
            );
          })}
        </Section>

        <Section
          title="Add chambers"
          description="New lab chambers. Leave a value blank to use the lab region's norm."
          list="chambers"
          cap={capOf('chambers')}
          addLabel="Add chamber line"
          lineCount={lines.chambers.length}
        >
          {lines.chambers.map((l, i) => {
            const id = (f: string) => `${l.key}-${f}`;
            const set = (patch: Partial<ScenarioLines['chambers'][number]>) => updateLine('chambers', l.key, patch);
            return (
              <LineShell key={l.key} groupLabel={`Added chambers, line ${String(i + 1)}`} onRemove={() => removeLine('chambers', l.key)}>
                <Field id={id('region')} label="Lab region">
                  {(p) => <RegionSelect id={p.id} value={l.labRegion} onChange={(labRegion) => set({ labRegion })} />}
                </Field>
                <Field id={id('count')} label="Count" error={err(l.key, 'count')}>
                  {(p) => <TextInput {...p} value={l.count} onChange={(e) => set({ count: e.target.value })} />}
                </Field>
                <Field id={id('platforms')} label="Platforms" error={err(l.key, 'platforms')}>
                  {(p) => <TextInput {...p} value={l.platforms} placeholder="Norm" onChange={(e) => set({ platforms: e.target.value })} />}
                </Field>
                <Field id={id('efficiency')} label="Efficiency" error={err(l.key, 'efficiency')}>
                  {(p) => <TextInput {...p} value={l.efficiency} placeholder="Norm" onChange={(e) => set({ efficiency: e.target.value })} />}
                </Field>
                <Field id={id('maintenance')} label="Maintenance weeks" error={err(l.key, 'maintenance')}>
                  {(p) => <TextInput {...p} value={l.maintenance} placeholder="Norm" onChange={(e) => set({ maintenance: e.target.value })} />}
                </Field>
                <Field id={id('breakdown')} label="Breakdown weeks" error={err(l.key, 'breakdown')}>
                  {(p) => <TextInput {...p} value={l.breakdown} placeholder="Norm" onChange={(e) => set({ breakdown: e.target.value })} />}
                </Field>
                <Field id={id('calibration')} label="Calibration weeks" error={err(l.key, 'calibration')}>
                  {(p) => <TextInput {...p} value={l.calibration} placeholder="Norm" onChange={(e) => set({ calibration: e.target.value })} />}
                </Field>
                {l.allowedStages ? (
                  <p className="self-end text-2xs text-text-muted">Limited to stages {l.allowedStages.join(', ')}</p>
                ) : null}
              </LineShell>
            );
          })}
        </Section>

        <Section
          title="Chamber downtime change"
          description="Replace an existing chamber's downtime weeks. Leave a field blank to keep its current value."
          list="downtime"
          addLabel="Add downtime line"
          lineCount={lines.downtime.length}
        >
          {lines.downtime.map((l, i) => {
            const id = (f: string) => `${l.key}-${f}`;
            const set = (patch: Partial<ScenarioLines['downtime'][number]>) => updateLine('downtime', l.key, patch);
            const known = chambers.some((c) => c.id === l.chamberId);
            return (
              <LineShell key={l.key} groupLabel={`Chamber downtime, line ${String(i + 1)}`} onRemove={() => removeLine('downtime', l.key)}>
                <Field id={id('chamber')} label="Chamber" error={err(l.key, 'chamberId')} className="col-span-2">
                  {(p) => (
                    <NativeSelect {...p} value={l.chamberId} onChange={(e) => set({ chamberId: e.target.value })}>
                      <option value="">Choose a chamber</option>
                      {l.chamberId !== '' && !known ? <option value={l.chamberId}>{l.chamberId}</option> : null}
                      {chambers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} ({c.lab_region})
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field id={id('maintenance')} label="Maintenance weeks" error={err(l.key, 'maintenance')}>
                  {(p) => <TextInput {...p} value={l.maintenance} onChange={(e) => set({ maintenance: e.target.value })} />}
                </Field>
                <Field id={id('breakdown')} label="Breakdown weeks" error={err(l.key, 'breakdown')}>
                  {(p) => <TextInput {...p} value={l.breakdown} onChange={(e) => set({ breakdown: e.target.value })} />}
                </Field>
                <Field id={id('calibration')} label="Calibration weeks" error={err(l.key, 'calibration')}>
                  {(p) => <TextInput {...p} value={l.calibration} onChange={(e) => set({ calibration: e.target.value })} />}
                </Field>
              </LineShell>
            );
          })}
        </Section>

        {validation.listErrors.length > 0 ? (
          <div role="alert" data-testid="whatif-list-errors">
            <ul className="space-y-1 text-xs font-medium text-danger-subtle-fg">
              {validation.listErrors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
